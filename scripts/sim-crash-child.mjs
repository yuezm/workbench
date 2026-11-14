/**
 * 崩溃仿真的写进程：往真实库里连续写，父进程在随机时刻 SIGKILL。
 *
 * 验证两条承诺：
 *   1. 已经应答的写入不丢（`seq` 连续，不会留半截事务的空洞）；
 *   2. 被杀之后重启能自愈（`projection_meta` 落后就重建，不变量仍然成立）。
 *
 * 用 vite 的 SSR loader 加载 TS（仓库没有 ts-node / vite-node，vite 本来就在 devDeps 里）。
 * 每写 10 条命令往 stdout 打一次 `seq=<n>`，父进程据此核对「已确认的不丢」。
 */
import { createServer } from 'vite'

const [dbPath, seedArg] = process.argv.slice(2)
if (dbPath === undefined) throw new Error('用法：node scripts/sim-crash-child.mjs <dbPath> [seed]')

let state = Number(seedArg ?? 1) >>> 0
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

const db = openDatabase(dbPath)
const store = createStore({ db, kernel, timezone: 'UTC' })
store.ensureProjection()
store.ensureBuiltinStages()

const send = (input) => {
  try {
    store.dispatch(input)
  } catch {
    // 崩溃仿真只关心「写进去的事实」；业务拒绝与主题无关
  }
}

const idOf = (table) => db.prepare(`SELECT id FROM ${table} ORDER BY id LIMIT 1`).get()?.id

send({
  type: 'runtime.create',
  commandId: 'c-rt',
  input: { name: '崩溃运行时', executorKey: 'command', command: 'echo' },
})
const runtimeId = idOf('runtimes')
send({ type: 'agent.create', commandId: 'c-ag', input: { name: '崩溃智能体', runtimeId } })
const agentId = idOf('agents')
send({
  type: 'workflow.create',
  commandId: 'c-wf',
  input: {
    name: '崩溃流程',
    stages: [
      { name: '待办', entryMode: 'none' },
      { name: '进行中', entryMode: 'agent', agentId },
    ],
  },
})

let counter = 0
for (;;) {
  counter += 1
  const workflowId = idOf('workflows')
  const taskId = db
    .prepare("SELECT id FROM tasks WHERE status = 'active' ORDER BY id LIMIT 1")
    .get()?.id
  if (workflowId !== undefined && rng() < 0.5) {
    send({
      type: 'task.create',
      commandId: `c-t-${counter}`,
      input: { title: `崩溃任务 ${counter}`, workflowId },
    })
  } else if (taskId !== undefined) {
    send({ type: 'task.comment', commandId: `c-c-${counter}`, taskId, text: `第 ${counter} 条` })
  } else {
    send({ type: 'run.claim', runtimeId: idOf('runtimes'), capacity: 2 })
  }
  if (counter % 10 === 0) {
    process.stdout.write(`seq=${db.prepare('SELECT MAX(seq) AS seq FROM facts').get()?.seq ?? 0}\n`)
  }
  await new Promise((resolve) => setTimeout(resolve, 2))
}
