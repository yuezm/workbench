/**
 * 崩溃仿真（计划 M35-A 的第二条腿）：反复强杀写进程，验证「已确认的不丢、重启能自愈」。
 *
 * 用法：`node scripts/sim-crash.mjs [次数] [种子]`（默认 20 次；`tests/sim/crash.test.ts` 只跑 2 次）。
 * 一次迭代 = 起写进程 → 随机时刻 SIGKILL → 重新打开库并核对：
 *   1. 事实 `seq` 连续（没有半截事务留下的空洞）；
 *   2. 写进程最后一次打出的 `seq=N` 仍然存在（已应答的写入不丢）；
 *   3. `projection_meta` 与日志一致（落后就自愈重建）；
 *   4. 不变量全部成立（`tests/sim/invariants.ts`）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'

const restarts = Number(process.argv[2] ?? 20)
const seed = Number(process.argv[3] ?? 1)
const workDir = join(process.cwd(), '.scratch', 'sim-crash')
mkdirSync(workDir, { recursive: true })

let state = seed >>> 0
const rng = () => {
  state = (state + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})
const load = async (path) => server.ssrLoadModule(path)
const { openDatabase } = await load('/src/host/db.ts')
const { createStore } = await load('/src/host/store/index.ts')
const kernel = {
  decide: (await load('/src/kernel/decide.ts')).decide,
  project: (await load('/src/kernel/scopes/project.ts')).project,
  viewSpec: (await load('/src/kernel/scopes/view-spec.ts')).viewSpec,
  nextWakeAt: (await load('/src/kernel/core/next-wake.ts')).nextWakeAt,
}
const { checkInvariants } = await load('/tests/sim/invariants.ts')

const fail = (message, details) => {
  process.stderr.write(`crash-sim FAILED: ${message}\n${details ?? ''}\n`)
  process.exitCode = 1
}

const runOnce = (dbPath) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['scripts/sim-crash-child.mjs', dbPath, String(Math.floor(rng() * 1e6))],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    let timer = null
    // 等它先真的写进去（第一条 `seq=`），再随机杀：否则杀在 vite 启动阶段，什么也没测到
    const kill = () => child.kill('SIGKILL')
    const armKill = () => {
      if (timer !== null) return
      timer = setTimeout(kill, 60 + Math.floor(rng() * 400))
    }
    const watchdog = setTimeout(kill, 20_000)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      if (stdout.includes('seq=')) armKill()
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(watchdog)
      if (timer !== null) clearTimeout(timer)
      const seqs = [...stdout.matchAll(/seq=(\d+)/g)].map((match) => Number(match[1]))
      resolve({ code, signal, lastSeq: seqs.length === 0 ? 0 : Math.max(...seqs), stderr })
    })
  })

const dbPath = join(workDir, `crash-${Date.now()}.sqlite`)
rmSync(dbPath, { force: true })

let totalFacts = 0
for (let round = 1; round <= restarts; round += 1) {
  const result = await runOnce(dbPath)
  // 写进程被强杀是预期结果；自退出（尤其带非零码）说明仿真本身坏了
  if (result.signal === null && result.code !== 0) {
    fail(`第 ${round} 轮写进程自行退出（code=${String(result.code)}）`, result.stderr)
    break
  }

  const db = openDatabase(dbPath)
  const store = createStore({ db, kernel, timezone: 'UTC' })
  store.ensureProjection()
  store.ensureBuiltinStages()

  const log = db.prepare('SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi FROM facts').get()
  const meta = db.prepare('SELECT seq FROM projection_meta WHERE id = 1').get()
  const violations = checkInvariants(db)

  if (log.n > 0 && (log.lo !== 1 || log.hi !== log.n)) {
    fail(`第 ${round} 轮事实序号不连续`, `count=${log.n} min=${log.lo} max=${log.hi}`)
  } else if (result.lastSeq > (log.hi ?? 0)) {
    fail(`第 ${round} 轮丢了已应答的写入`, `已报告 seq=${result.lastSeq}，库里 max=${log.hi}`)
  } else if (meta !== undefined && meta.seq !== (log.hi ?? 0)) {
    fail(`第 ${round} 轮投影未自愈`, `meta.seq=${meta.seq} max=${log.hi}`)
  } else if (violations.length > 0) {
    fail(
      `第 ${round} 轮不变量被破坏`,
      violations.map((item) => `${item.rule} ${item.detail}`).join('\n'),
    )
  }
  if (process.exitCode === 1) break

  totalFacts = log.hi ?? 0
  db.close()
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
}

await server.close()
if (process.exitCode !== 1) {
  process.stdout.write(`crash-sim ok restarts=${restarts} facts=${totalFacts} db=${dbPath}\n`)
}
