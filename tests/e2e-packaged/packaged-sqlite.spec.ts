import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTempUserData, describeDir, type TempUserData } from './helpers/temp-userdata'

/**
 * M0-T3 打包冒烟：证明 electron-builder 产物里的 Electron 主进程能用 node:sqlite。
 *
 * 证据链：
 * 1. 用 `--user-data-dir` 把打包进程的 userData 指到临时目录（真实 %APPDATA% 不参与）；
 * 2. 该进程启动时执行 openDb(userData/ai-workflow.db)，数据库落盘即证明打包后的
 *    `require('node:sqlite')`（electron-vite 打包的 CJS）可用；
 * 3. 测试侧用 Node 22 的 DatabaseSync 只读打开该库，核对 PRAGMA user_version=2 与
 *    schema 表清单，证明迁移/建表确实完成；
 * 4. 在打包进程内用 process.getBuiltinModule('node:sqlite') 再做一次建表 → 写入 → 读回，
 *    证明主进程侧读写往返正常（不只是 App 启动时恰好写成功）。
 */

const repoRoot = path.resolve(__dirname, '..')
const packagedExe = path.join(repoRoot, 'dist', 'win-unpacked', 'Workbench.exe')
const DB_WAIT_TIMEOUT_MS = 20_000

/** v2 schema 必须存在的表（见 src/host/schema.ts）。 */
const EXPECTED_TABLES = [
  'agents',
  'chat_conversations',
  'chat_messages',
  'run_events',
  'runs',
  'runtimes',
  'tasks',
  'workflow_stages',
  'workflows',
] as const

let app: ElectronApplication
let page: Page
let temp: TempUserData

/**
 * 打包 exe 若继承 ELECTRON_RUN_AS_NODE 会被当成 Node 进程启动（报 bad option）；
 * 冒烟要的是 App 进程，显式去掉该变量。普通终端里本来就没有它，删除无副作用。
 */
function launchEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || value === undefined) continue
    env[key] = value
  }
  return env
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(file)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const exeStamp = existsSync(packagedExe)
    ? `${packagedExe}（mtime ${statSync(packagedExe).mtime.toISOString()}）`
    : `${packagedExe}（不存在）`
  throw new Error(
    `等待打包进程创建 ${file} 超时（${timeoutMs}ms）。\n` +
      `临时 userData：${path.dirname(file)}\n` +
      `目录内容：${describeDir(path.dirname(file))}\n` +
      `打包产物：${exeStamp}`,
  )
}

interface InProcessRoundtrip {
  ok: boolean
  nodeVersion: string
  electronVersion: string
  value?: string
  error?: string
}

test.beforeAll(() => {
  if (!existsSync(packagedExe)) {
    throw new Error(
      `未找到打包产物 ${packagedExe}；先执行 pnpm build（electron-vite build + electron-builder --win）`,
    )
  }
})

test.beforeEach(async () => {
  temp = createTempUserData()
  app = await electron.launch({
    executablePath: packagedExe,
    args: [`--user-data-dir=${temp.dir}`],
    env: launchEnv(),
    timeout: 120_000,
  })
  page = await app.firstWindow()
})

test.afterEach(async () => {
  await app.close()
  temp.cleanup()
})

test('打包产物内 node:sqlite 可用：建表 → 写入 → 读回（user_version=2）', async () => {
  // 1) 打包后的 renderer 与主窗口正常起来
  await expect(page).toHaveTitle('Workbench')

  // 2) userData 被指到临时目录：数据库只会落在临时目录里，真实 %APPDATA% 不受影响
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  expect(
    path.resolve(userData).toLowerCase(),
    `打包进程的 userData 应等于 --user-data-dir 指定的临时目录，实际 ${userData}`,
  ).toBe(path.resolve(temp.dir).toLowerCase())

  // 3) 打包主进程启动时已 openDb(userData/ai-workflow.db)：等它落盘
  const dbFile = path.join(temp.dir, 'ai-workflow.db')
  await waitForFile(dbFile, DB_WAIT_TIMEOUT_MS)
  expect(
    path.resolve(dbFile).startsWith(`${path.resolve(temp.dir)}${path.sep}`),
    `ai-workflow.db 必须落在临时 userData 内，实际 ${dbFile}`,
  ).toBe(true)

  // 4) 测试侧用 Node 自带 node:sqlite 只读打开，核对 schema 与版本
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const versionRow = db.prepare('PRAGMA user_version').get() as
      { user_version: number } | undefined
    expect(
      versionRow?.user_version,
      `ai-workflow.db 的 PRAGMA user_version 应为 2（schema v2），实际 ${String(versionRow?.user_version)}；文件 ${dbFile}（${statSync(dbFile).size} 字节）`,
    ).toBe(2)

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
    expect(tables, `打包进程建出的表不完整，实际：${tables.join(', ')}`).toEqual(
      expect.arrayContaining([...EXPECTED_TABLES]),
    )

    const integrity = db.prepare('PRAGMA integrity_check').get() as
      { integrity_check: string } | undefined
    expect(integrity?.integrity_check, 'ai-workflow.db 的 integrity_check 结果').toBe('ok')
  } finally {
    db.close()
  }

  // 5) 打包主进程内的 node:sqlite 往返：建表 → 写入 → 读回
  const roundtripFile = path.join(temp.dir, 'packaged-roundtrip.db')
  const roundtrip = await app.evaluate(async (_electron, file): Promise<InProcessRoundtrip> => {
    const sqlite = process.getBuiltinModule('node:sqlite')
    const result: InProcessRoundtrip = {
      ok: false,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron ?? '',
    }
    try {
      const db = new sqlite.DatabaseSync(file)
      try {
        db.exec('CREATE TABLE roundtrip (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
        db.prepare('INSERT INTO roundtrip (id, value) VALUES (?, ?)').run(1, 'packaged')
        db.prepare('SELECT value FROM roundtrip WHERE id = ?').get(1)
      } finally {
        db.close()
      }
      const reopened = new sqlite.DatabaseSync(file, { readOnly: true })
      try {
        const row = reopened.prepare('SELECT value FROM roundtrip WHERE id = ?').get(1) as
          { value: string } | undefined
        result.value = row?.value
        result.ok = row?.value === 'packaged'
      } finally {
        reopened.close()
      }
    } catch (error) {
      result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    return result
  }, roundtripFile)

  expect(
    roundtrip.ok,
    `打包进程内 node:sqlite 往返失败（node ${roundtrip.nodeVersion} / electron ${roundtrip.electronVersion}）：${roundtrip.error ?? '读回值不符'}`,
  ).toBe(true)
  expect(roundtrip.value, '打包进程内读回的写入值').toBe('packaged')
})
