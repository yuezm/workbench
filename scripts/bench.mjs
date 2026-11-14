/**
 * 性能基线（M36-G）：把 ARCHITECTURE 验收表里那些数字变成仪器读数。
 *
 * 用法：`node scripts/bench.mjs [--facts=100000] [--tasks=5000] [--samples=200] [--json]`
 *
 * 口径（与 SPEC 一致，别拿它当压测）：
 * - 每条写入单独提交，事务落盘后才算完成；
 * - 「装载 + decide」按 `viewSpec` 切片装载，p50 / p99 取 200 次采样的分位；
 * - 重建从事实日志全量 fold，含投影写入；
 * - 启动增量 = 投影已是最新时 `createStore` + `ensureProjection` 的耗时。
 *
 * 用 vite 的 SSR loader 加载 TS（仓库没有 ts-node）；数据库用临时文件（WAL + 真实落盘）。
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'

const args = new Map(
  process.argv
    .slice(2)
    .filter((item) => item.startsWith('--'))
    .map((item) => {
      const [key, value = 'true'] = item.replace(/^--/, '').split('=')
      return [key, value]
    }),
)
const FACTS = Number(args.get('facts') ?? 100_000)
const TASKS = Number(args.get('tasks') ?? 5_000)
const SAMPLES = Number(args.get('samples') ?? 200)
const JSON_OUT = args.get('json') === 'true'

const AT = '2026-11-15T00:00:00.000Z'

const server = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})
const load = async (path) => server.ssrLoadModule(path)
const { openDatabase } = await load('/src/host/db.ts')
const { createStore } = await load('/src/host/store/index.ts')
const schema = await load('/src/host/schema.ts')
const { withTx } = schema
const kernel = {
  decide: (await load('/src/kernel/decide.ts')).decide,
  project: (await load('/src/kernel/scopes/project.ts')).project,
  viewSpec: (await load('/src/kernel/scopes/view-spec.ts')).viewSpec,
  nextWakeAt: (await load('/src/kernel/core/next-wake.ts')).nextWakeAt,
}

const dir = mkdtempSync(join(tmpdir(), 'workbench-bench-'))
const dbPath = join(dir, 'bench.db')
const db = openDatabase(dbPath)

const percentile = (values, p) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}
const ms = (value) => Math.round(value * 100) / 100

const now = () => AT
const store = createStore({ db, kernel, now, timezone: 'UTC' })
store.ensureProjection()

// ---- 造数：直接写事实 + 走同一条投影路径（不经过 decide，避免把造数时间算进指标） ----
const { appendFacts } = await load('/src/host/store/facts.ts')

const seedAt = Date.now()
const workflowId = 'wf-bench'
const stageId = 'st-bench'
// 造数只追加事实；投影交给下面计时的 `rebuild()` 一次 fold（否则每条 fact 走一遍 writer，
// 10 万条要几分钟）。整批放一个事务里：WAL + synchronous 下逐条自动提交会把「造数」拉成分钟级。
const seed = (drafts) => withTx(db, () => appendFacts(db, drafts))

seed([
  {
    type: 'workflow.created',
    actor: { kind: 'host', via: 'reconcile' },
    at: AT,
    payload: { workflow: { id: workflowId, name: '压测流程', description: '', createdAt: AT } },
  },
])
seed([
  {
    type: 'stage.created',
    actor: { kind: 'host', via: 'reconcile' },
    at: AT,
    payload: {
      stage: {
        id: stageId,
        workflowId,
        name: '待办',
        position: 0,
        entryMode: 'none',
        agentId: null,
        exits: {},
        judge: null,
        handoffs: [],
        subtaskStageId: null,
        onChildrenSettled: null,
        spawnPolicy: null,
        instructions: '',
        acceptance: [],
        runTimeoutMs: null,
        script: null,
      },
    },
  },
])

const taskDrafts = []
for (let index = 0; index < TASKS; index += 1) {
  taskDrafts.push({
    type: 'task.created',
    actor: { kind: 'owner', via: 'ui' },
    at: AT,
    payload: {
      task: {
        id: `task-${index}`,
        title: `压测任务 ${index}`,
        description: '',
        workflowId,
        projectId: null,
        currentStageId: stageId,
        status: 'active',
        origin: 'manual',
        ruleId: null,
        externalRef: null,
        labels: [],
        threadId: null,
        parentTaskId: null,
        spawnedByRunId: null,
        batchNo: null,
        spawnKey: null,
        handoffFromTaskId: null,
        handoffFromStageId: null,
        handoffFromRunId: null,
        gateFails: 0,
        createdAt: AT,
        updatedAt: AT,
      },
    },
  })
}
seed(taskDrafts)

// 更新类事实（整行携带 Task）：比「评论」更接近真实增长（评论只在反馈时产生，
// 拿它当主要增长会放大 `task_comments` 切片装载，量出来的是异常而非常态）
const updateDrafts = []
const updates = Math.max(0, FACTS - 2 - TASKS)
for (let index = 0; index < updates; index += 1) {
  const base = index % TASKS
  updateDrafts.push({
    type: 'task.updated',
    actor: { kind: 'owner', via: 'ui' },
    at: AT,
    payload: {
      task: {
        id: `task-${base}`,
        title: `压测任务 ${base}（第 ${index} 次更新）`,
        description: '',
        workflowId,
        projectId: null,
        currentStageId: stageId,
        status: 'active',
        origin: 'manual',
        ruleId: null,
        externalRef: null,
        labels: [],
        threadId: null,
        parentTaskId: null,
        spawnedByRunId: null,
        batchNo: null,
        spawnKey: null,
        handoffFromTaskId: null,
        handoffFromStageId: null,
        handoffFromRunId: null,
        gateFails: 0,
        createdAt: AT,
        updatedAt: AT,
      },
    },
  })
}
for (let offset = 0; offset < updateDrafts.length; offset += 500) {
  seed(updateDrafts.slice(offset, offset + 500))
}
const seedMs = Date.now() - seedAt

const factCount = db.prepare('SELECT COUNT(*) AS n FROM facts').get().n

// ---- 指标 1：全量重建（从事实日志 fold） ----
const rebuildStart = process.hrtime.bigint()
store.rebuild()
const rebuildMs = Number(process.hrtime.bigint() - rebuildStart) / 1e6

// ---- 指标 2：装载 + decide（按 viewSpec 切片，投影已就绪） ----
const samples = []
for (let index = 0; index < SAMPLES; index += 1) {
  const commandId = `bench-${index}`
  const started = process.hrtime.bigint()
  store.dispatch({
    type: 'task.comment',
    commandId,
    taskId: `task-${index % TASKS}`,
    text: `基线样本 ${index}`,
  })
  samples.push(Number(process.hrtime.bigint() - started) / 1e6)
}

// ---- 指标 2b：装载 + decide（clock.tick：到期集合，不碰任务评论） ----
const tickSamples = []
for (let index = 0; index < SAMPLES; index += 1) {
  const started = process.hrtime.bigint()
  store.dispatch({ type: 'clock.tick' })
  tickSamples.push(Number(process.hrtime.bigint() - started) / 1e6)
}

// ---- 指标 3：启动增量（投影已是最新） ----
const startupStart = process.hrtime.bigint()
const store2 = createStore({ db, kernel, now, timezone: 'UTC' })
store2.ensureProjection()
const startupMs = Number(process.hrtime.bigint() - startupStart) / 1e6

const sizeBytes = statSync(dbPath).size
db.close()
rmSync(dir, { recursive: true, force: true })
await server.close()

const result = {
  facts: factCount,
  tasks: TASKS,
  seedMs,
  decideP50Ms: ms(percentile(samples, 50)),
  decideP99Ms: ms(percentile(samples, 99)),
  tickP50Ms: ms(percentile(tickSamples, 50)),
  tickP99Ms: ms(percentile(tickSamples, 99)),
  rebuildMs: ms(rebuildMs),
  startupMs: ms(startupMs),
  dbBytes: sizeBytes,
}

const rows = [
  ['事实条数', `${result.facts}`],
  ['任务数', `${result.tasks}`],
  ['造数耗时', `${ms(result.seedMs)} ms`],
  ['装载 + decide p50', `${result.decideP50Ms} ms`],
  ['装载 + decide p99', `${result.decideP99Ms} ms`],
  ['装载 + tick p50', `${result.tickP50Ms} ms`],
  ['装载 + tick p99', `${result.tickP99Ms} ms`],
  ['全量重建', `${result.rebuildMs} ms`],
  ['启动增量（投影最新）', `${result.startupMs} ms`],
  ['库体积', `${(result.dbBytes / 1024 / 1024).toFixed(1)} MB`],
]

if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
} else {
  process.stdout.write(
    [
      '| 指标 | 实测 |',
      '| --- | --- |',
      ...rows.map(([label, value]) => `| ${label} | ${value} |`),
      '',
    ].join('\n'),
  )
}
