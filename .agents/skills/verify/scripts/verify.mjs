#!/usr/bin/env node
/**
 * Workbench 验证驱动器（verify harness CLI）。
 *
 * 一个 run = 一次独立启动：临时数据目录 + 系统分配端口（`WORKBENCH_PORT=0`），
 * 驱动完 `stop` 掉——绝不碰本机常驻实例（`~/.workbench`，默认 3000）。
 *
 *   node .agents/skills/verify/scripts/verify.mjs launch  [--run NAME] [--empty]
 *   node .agents/skills/verify/scripts/verify.mjs doctor  [--run NAME]
 *   node .agents/skills/verify/scripts/verify.mjs status  [--run NAME]
 *   node .agents/skills/verify/scripts/verify.mjs query   <view> [--params JSON] [--run NAME]
 *   node .agents/skills/verify/scripts/verify.mjs sql     "SELECT ..." [--run NAME]
 *   node .agents/skills/verify/scripts/verify.mjs drive   <script.mjs> [--run NAME] [--headed]
 *   node .agents/skills/verify/scripts/verify.mjs stop    [--run NAME] [--purge]
 *
 * 运行态全部落在 `.scratch/verify/<run>/`（已被 .gitignore 忽略）：
 *   state.json        实例台账（url / pid / dataDir / artifactsDir / 种子 id）
 *   data/             一次性数据目录（库 ai-workflow.db、artifacts、plugins、secret.key）
 *   artifacts/        证据（截图、ARIA 快照、导出 JSON）——stop 不删
 *   server.log        本次启动的服务端日志
 *   server-phase1.log 阶段一（写入通道隔离）的服务端日志
 *
 * 为什么启动分两段：飞书通道读的是本机 `~/.lark-cli` 的真实登录态，启动就会 spawn
 * `lark-cli` 挂事件流（用本人的飞书身份）。要停用它必须先落一条 `plugins.replace`
 * 事实，而通道只在装配期 `startAll()` 读一次设置——所以第一段用「PATH 里没有 lark-cli」
 * 的空目录起服务（飞书起不来、20s 的握手也省掉），只写那条事实；第二段正常起，
 * 飞书从头就不会启动。缺了这一步，验证实例会拿真人身份连飞书。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根：从脚本位置向上找 `package.json` 里 name=workbench 的那一层 */
function findRoot(start) {
  let dir = start
  for (;;) {
    const pkg = path.join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'workbench') return dir
      } catch {
        // 半截 package.json：继续往上找
      }
    }
    const up = path.dirname(dir)
    if (up === dir) throw new Error('找不到 Workbench 仓库根（package.json name=workbench）')
    dir = up
  }
}

const ROOT = findRoot(HERE)
const LISTENING = /workbench listening on (http:\/\/\S+)/u

/** 隔离事实：停用会把消息交给真人的通道（目前只有飞书），见 tests/support/channel-isolation.ts */
const ISOLATION_COMMAND = 'verify-isolate-external-channels'
const ISOLATION_SETTINGS = [{ id: 'feishu', kind: 'channel', enabled: false, granted: [], config: {} }]

function parseArgs(list) {
  const positional = []
  const flags = {}
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = list[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

const { positional, flags } = parseArgs(process.argv.slice(2))
const command = positional[0]
const runName = typeof flags.run === 'string' ? flags.run : 'default'
const RUN_DIR = path.join(ROOT, '.scratch', 'verify', runName)
const STATE_PATH = path.join(RUN_DIR, 'state.json')
const DATA_DIR = path.join(RUN_DIR, 'data')
const ARTIFACTS_DIR = path.join(RUN_DIR, 'artifacts')

function fail(message) {
  console.error(`[verify] ${message}`)
  process.exit(1)
}

function readState() {
  if (!existsSync(STATE_PATH)) return null
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
}

function writeState(state) {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 大小写不敏感地写一个环境变量（Windows 下 Path/PATH 会撞） */
function setEnv(env, key, value) {
  for (const existing of Object.keys(env)) {
    if (existing.toUpperCase() === key.toUpperCase()) delete env[existing]
  }
  env[key] = value
}

/**
 * 子进程环境：清掉父进程带下来的全部 `WORKBENCH_*`（尤其 `WORKBENCH_TOKEN`，
 * 留着会让实例要鉴权、还要在脚本里重复一份口令），再按本次 run 重设。
 */
function serverEnv({ dataDir, workdir, pathOverride }) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('WORKBENCH_')) delete env[key]
  }
  setEnv(env, 'WORKBENCH_DATA_DIR', dataDir)
  setEnv(env, 'WORKBENCH_PORT', '0')
  setEnv(env, 'WORKBENCH_HOST', '127.0.0.1')
  setEnv(env, 'WORKBENCH_WORKDIR', workdir)
  setEnv(env, 'WORKBENCH_WEB_DIR', path.join(ROOT, 'out', 'web'))
  if (pathOverride !== undefined) setEnv(env, 'Path', pathOverride)
  return env
}

/** 起一个脱离父进程的服务（detached + unref：CLI 退出后它继续跑） */
function spawnServer({ logPath, dataDir, workdir, pathOverride }) {
  // 日志直接写文件描述符而不是管道：管道会把本 CLI 的事件循环挂住（CLI 退不掉）
  const logFd = openSync(logPath, 'w')
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join('out', 'server', 'index.js')],
    {
      cwd: ROOT,
      env: serverEnv({ dataDir, workdir, pathOverride }),
      stdio: ['ignore', logFd, logFd],
      detached: true,
      windowsHide: true,
    },
  )
  child.unref()
  return child
}

function logTail(logPath, lines = 25) {
  if (!existsSync(logPath)) return '(没有日志)'
  return readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')
}

/** 等 `workbench listening on <url>`；进程提前退出就把日志尾部带出来 */
async function waitReady(child, logPath, timeoutMs = 60_000) {
  const startedAt = Date.now()
  for (;;) {
    if (existsSync(logPath)) {
      const match = LISTENING.exec(readFileSync(logPath, 'utf8'))
      if (match?.[1] !== undefined) return match[1]
    }
    if (!alive(child.pid)) {
      throw new Error(`服务进程提前退出（pid ${child.pid}）：\n${logTail(logPath)}`)
    }
    if (Date.now() - startedAt > timeoutMs) {
      await stopPid(child.pid)
      throw new Error(`服务 ${timeoutMs}ms 内没有监听：\n${logTail(logPath)}`)
    }
    await sleep(100)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 停我们自己的实例：先 SIGTERM，2s 不退再 taskkill /T /F（连子进程一起） */
async function stopPid(pid) {
  if (!alive(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // 已经没了
  }
  for (let i = 0; i < 20; i += 1) {
    if (!alive(pid)) return
    await sleep(100)
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经没了
    }
  }
  for (let i = 0; i < 30; i += 1) {
    if (!alive(pid)) return
    await sleep(100)
  }
}

async function request(base, pathname, body) {
  const init =
    body === undefined
      ? { method: 'GET' }
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
  const response = await fetch(`${base}${pathname}`, init)
  const text = await response.text()
  if (!response.ok) throw new Error(`${pathname} → HTTP ${response.status}：${text.slice(0, 400)}`)
  return text === '' ? null : JSON.parse(text)
}

/** dispatch：`{ok, value:{facts, value}}`；被内核拒绝时 `ok:false` → 抛错 */
async function dispatch(base, cmd) {
  const payload = await request(base, '/api/dispatch', { command: cmd })
  if (payload?.ok !== true) {
    throw new Error(`命令 ${cmd.type} 被拒：${JSON.stringify(payload?.error ?? payload)}`)
  }
  return payload.value
}

/** query：`{ok, value}`；读视图失败同样是 `ok:false` */
async function query(base, view, params) {
  const payload = await request(base, '/api/query', params === undefined ? { view } : { view, params })
  if (payload?.ok !== true) {
    throw new Error(`视图 ${view} 读取失败：${JSON.stringify(payload?.error ?? payload)}`)
  }
  return payload.value
}

/**
 * 默认种子：一条两段工作流 + 一个项目 + 一张卡。
 *
 * 全走公开命令（与界面同一条路径）：`workflow.create` 会自动补齐四个内置阶段
 * （待办 / 已阻塞 / 已完成 / 已取消），这里只补「方案 / 实施」两个用户阶段。
 * 阶段一律 `entryMode:'none'`：不绑智能体、不起任何子进程。
 */
async function seed(base, workdir) {
  const workflow = (
    await dispatch(base, {
      type: 'workflow.create',
      commandId: 'verify-seed-workflow',
      input: {
        name: '验证流程',
        stages: [
          { name: '方案', entryMode: 'none' },
          { name: '实施', entryMode: 'none' },
        ],
      },
    })
  ).value
  const project = (
    await dispatch(base, {
      type: 'project.create',
      commandId: 'verify-seed-project',
      input: { name: '验证项目', path: workdir },
    })
  ).value
  const stage = workflow.stages.find((item) => item.name === '方案') ?? workflow.stages[0]
  const task = (
    await dispatch(base, {
      type: 'task.create',
      commandId: 'verify-seed-task',
      input: {
        title: '验证首张卡',
        description: 'harness 种子：证明看板能看到一张卡',
        workflowId: workflow.id,
        stageId: stage.id,
        projectId: project.id,
      },
    })
  ).value
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    stageIds: Object.fromEntries(workflow.stages.map((item) => [item.name, item.id])),
    projectId: project.id,
    projectName: project.name,
    taskId: task.id,
    taskTitle: task.title,
  }
}

async function launch() {
  const serverEntry = path.join(ROOT, 'out', 'server', 'index.js')
  const webEntry = path.join(ROOT, 'out', 'web', 'index.html')
  if (!existsSync(serverEntry) || !existsSync(webEntry)) {
    fail('缺少构建产物（out/server 或 out/web）：先在仓库根执行 `pnpm build`')
  }
  const previous = readState()
  if (previous !== null && alive(previous.pid)) {
    fail(
      `run「${runName}」已有实例在跑（pid ${previous.pid}，${previous.url}）：先 \`stop\`，或换 \`--run\` 起一个新 run`,
    )
  }
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(ARTIFACTS_DIR, { recursive: true })
  const workdir = path.join(DATA_DIR, 'workdir')
  mkdirSync(workdir, { recursive: true })
  // 阶段一专用：空 PATH，让飞书通道找不到 lark-cli
  const noPath = path.join(RUN_DIR, '_nopath')
  mkdirSync(noPath, { recursive: true })

  // ── 阶段一：写「停用飞书」事实（服务起来只为接这一条命令） ──
  const phase1Log = path.join(RUN_DIR, 'server-phase1.log')
  const first = spawnServer({ logPath: phase1Log, dataDir: DATA_DIR, workdir, pathOverride: noPath })
  try {
    const firstUrl = await waitReady(first, phase1Log)
    await dispatch(firstUrl, {
      type: 'plugins.replace',
      commandId: ISOLATION_COMMAND,
      settings: ISOLATION_SETTINGS,
    })
  } finally {
    await stopPid(first.pid)
  }

  // ── 阶段二：正式实例（飞书已被停用，不再 spawn lark-cli） ──
  const logPath = path.join(RUN_DIR, 'server.log')
  const second = spawnServer({ logPath, dataDir: DATA_DIR, workdir })
  let url
  try {
    url = await waitReady(second, logPath)
  } catch (error) {
    await stopPid(second.pid)
    fail(error.message)
  }

  let seedInfo = null
  if (flags.empty !== true) {
    try {
      seedInfo = await seed(url, workdir)
    } catch (error) {
      await stopPid(second.pid)
      fail(`种子失败：${error.message}`)
    }
  }

  const info = await request(url, '/api/info')
  const state = {
    run: runName,
    status: 'running',
    url,
    pid: second.pid,
    dataDir: DATA_DIR,
    dbPath: path.join(DATA_DIR, 'ai-workflow.db'),
    logPath,
    artifactsDir: ARTIFACTS_DIR,
    startedAt: info?.value?.startedAt ?? null,
    serverVersion: info?.value?.version ?? null,
    kernelVersion: info?.value?.kernelVersion ?? null,
    seeded: seedInfo,
  }
  writeState(state)
  console.log(JSON.stringify(state, null, 2))
}

async function doctor() {
  const state = readState()
  if (state === null) fail(`run「${runName}」没有 state.json：先 \`launch\``)
  const results = []
  const check = async (name, run) => {
    try {
      const detail = await run()
      results.push({ ok: true, name, detail: detail ?? '' })
    } catch (error) {
      results.push({ ok: false, name, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  await check('state.json 存在', () => `${state.run} → ${state.url}`)
  await check('构建产物 out/web/index.html', () => {
    if (!existsSync(path.join(ROOT, 'out', 'web', 'index.html'))) throw new Error('缺 out/web：pnpm build')
    return path.join('out', 'web')
  })
  await check('数据目录是一次性的（不在 ~/.workbench）', () => {
    if (!path.resolve(state.dataDir).startsWith(path.resolve(RUN_DIR))) {
      throw new Error(`state.dataDir 不在本次 run 目录下：${state.dataDir}`)
    }
    return state.dataDir
  })
  await check(`进程存活（pid ${state.pid}）`, () => {
    if (!alive(state.pid)) throw new Error('进程不在了：重新 launch')
    return 'alive'
  })
  await check('GET /api/health', async () => {
    const body = await request(state.url, '/api/health')
    if (body?.value?.status !== 'ok') throw new Error(JSON.stringify(body))
    return `status=ok clients=${body.value.clients}`
  })
  await check('GET /api/info 与本实例对得上', async () => {
    const body = await request(state.url, '/api/info')
    const info = body?.value ?? {}
    if (info.pid !== state.pid) throw new Error(`pid 不符：info=${info.pid} state=${state.pid}（端口被别的进程占了）`)
    if (path.resolve(info.dataDir) !== path.resolve(state.dataDir)) {
      throw new Error(`dataDir 不符：info=${info.dataDir}`)
    }
    return `v${info.version} kernel=${info.kernelVersion} pid=${info.pid}`
  })
  await check('界面可访问（/ 返回 HTML）', async () => {
    const response = await fetch(state.url)
    const text = await response.text()
    if (!response.ok || !/text\/html/.test(response.headers.get('content-type') ?? '')) {
      throw new Error(`HTTP ${response.status} ${response.headers.get('content-type')}`)
    }
    if (!text.includes('<title>Workbench</title>')) throw new Error('首页不是 Workbench 页面')
    return 'title=Workbench'
  })
  await check('外部通道已隔离（feishu 停用）', async () => {
    const view = await query(state.url, 'plugins.settings')
    const feishu = view.settings.find((item) => item.id === 'feishu')
    if (feishu === undefined || feishu.enabled !== false) {
      throw new Error('feishu 未停用：这次 run 可能拿真人身份连飞书，立即 stop')
    }
    return `settings v${view.version}`
  })

  for (const item of results) {
    console.log(`${item.ok ? 'OK  ' : 'FAIL'} ${item.name}${item.detail === '' ? '' : ` — ${item.detail}`}`)
  }
  if (results.some((item) => !item.ok)) process.exit(1)
}

async function status() {
  const state = readState()
  if (state === null) fail(`run「${runName}」没有 state.json：先 \`launch\``)
  console.log(JSON.stringify({ ...state, pidAlive: alive(state.pid) }, null, 2))
}

/** `node:sqlite` 带实验特性告警：按需 require，只有真读库的命令才会打那行警告 */
let DatabaseSyncCtor = null
function databaseSync() {
  if (DatabaseSyncCtor === null) {
    DatabaseSyncCtor = createRequire(import.meta.url)('node:sqlite').DatabaseSync
  }
  return DatabaseSyncCtor
}

/** 只读 SQL（证据用）：只放行 SELECT / WITH / PRAGMA */
function sqlAll(queryText, params = []) {
  const trimmed = queryText.trim()
  if (!/^(select|with|pragma)\b/iu.test(trimmed)) {
    throw new Error('sql 只允许 SELECT / WITH / PRAGMA（证据是只读的）')
  }
  const state = readState()
  const db = new (databaseSync())(state.dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return db.prepare(trimmed).all(...params)
  } finally {
    db.close()
  }
}

async function runQuery() {
  const view = positional[1]
  if (view === undefined) fail('用法：query <view> [--params JSON]')
  const state = readState()
  if (state === null) fail(`run「${runName}」没有 state.json：先 \`launch\``)
  const params = typeof flags.params === 'string' ? JSON.parse(flags.params) : undefined
  console.log(JSON.stringify(await query(state.url, view, params), null, 2))
}

async function runSql() {
  const statement = positional[1]
  if (statement === undefined) fail('用法：sql "SELECT ..."')
  console.log(JSON.stringify(sqlAll(statement), null, 2))
}

/**
 * 驱动浏览器：脚本 `export default async (ctx) => {...}`，`ctx` 给
 * `page / browser / url / artifacts / shot(name) / api.query / api.dispatch / sql / state`。
 */
async function drive() {
  const scriptArg = positional[1]
  if (scriptArg === undefined) fail('用法：drive <script.mjs> [--run NAME] [--headed]')
  const state = readState()
  if (state === null) fail(`run「${runName}」没有 state.json：先 \`launch\``)
  const scriptPath = path.resolve(ROOT, scriptArg)
  if (!existsSync(scriptPath)) fail(`驱动脚本不存在：${scriptPath}`)
  const { chromium } = await import('@playwright/test')

  const browser = await chromium.launch({ headless: flags.headed !== true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  const shot = async (name) => {
    const file = path.join(ARTIFACTS_DIR, name.endsWith('.png') ? name : `${name}.png`)
    await page.screenshot({ path: file, fullPage: true })
    return file
  }
  const api = {
    query: (view, params) => query(state.url, view, params),
    dispatch: (cmd) => dispatch(state.url, cmd),
  }

  let summary = null
  let failed = null
  try {
    const module = await import(pathToFileURL(scriptPath).href)
    if (typeof module.default !== 'function') throw new Error('驱动脚本要 export default async (ctx) => {...}')
    await page.goto(state.url)
    summary = await module.default({
      page,
      browser,
      url: state.url,
      runDir: RUN_DIR,
      artifacts: ARTIFACTS_DIR,
      state,
      shot,
      api,
      sql: sqlAll,
    })
  } catch (error) {
    failed = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  } finally {
    await browser.close()
  }

  if (consoleErrors.length > 0 || pageErrors.length > 0) {
    console.log(`[verify] 页面报错 ${consoleErrors.length + pageErrors.length} 条：`)
    for (const line of [...consoleErrors, ...pageErrors]) console.log(`  - ${line}`)
  }
  if (failed !== null) {
    console.error(`[verify] 驱动失败：${failed}`)
    process.exit(1)
  }
  console.log(JSON.stringify({ artifacts: ARTIFACTS_DIR, summary }, null, 2))
}

async function stop() {
  const state = readState()
  if (state === null) fail(`run「${runName}」没有 state.json`)
  await stopPid(state.pid)
  state.status = 'stopped'
  state.stoppedAt = new Date().toISOString()
  writeState(state)
  if (flags.purge === true) {
    rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    console.log(`[verify] 已停止并删除 ${DATA_DIR}（证据仍留在 ${ARTIFACTS_DIR}）`)
  } else {
    console.log(`[verify] 已停止 run「${runName}」（pid ${state.pid}）；证据仍在 ${ARTIFACTS_DIR}`)
  }
}

const COMMANDS = {
  launch,
  doctor,
  status,
  query: runQuery,
  sql: runSql,
  drive,
  stop,
}

const handler = COMMANDS[command]
if (handler === undefined) {
  console.error(`用法：verify.mjs <${Object.keys(COMMANDS).join('|')}> [选项]；见 .agents/skills/verify/SKILL.md`)
  process.exit(1)
}
await handler()
