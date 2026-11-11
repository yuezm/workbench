// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decide } from '../../src/kernel/decide'
import { project } from '../../src/kernel/project'
import { viewSpec } from '../../src/kernel/view-spec'
import type { KernelPort } from '../../src/kernel/types'
import type { Agent, RunRow, Runtime, Task, WorkflowStage } from '../../src/protocol/entities'
import type { ExecutorIO, ExecutorPort, Receipt, Turn } from '../../src/protocol/executor'
import { openDatabase } from '../../src/host/db'
import { createExecutorPort } from '../../src/host/executor'
import { pluginFromBackend, testContext, type TestBackend } from './plugin-support'
import { createProcessRegistry, type ProcessRegistry } from '../../src/host/process-registry'
import { createScheduler, type Scheduler, type SchedulerTimer } from '../../src/host/scheduler'
import { createStore, type Store } from '../../src/host/store/index'

const kernel: KernelPort = { decide, project, viewSpec }
const AT = '2026-01-01T00:00:00.000Z'
const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }

let world: World
let commandSeq = 0

interface World {
  db: DatabaseSync
  store: Store
}

const nextCommandId = (): string => {
  commandSeq += 1
  return `cmd-${commandSeq}`
}

/** 假定时器：心跳不真的挂系统定时器。 */
const fakeTimer = (): SchedulerTimer => ({
  setInterval: () => ({ handle: 1 }),
  clearInterval: () => undefined,
})

const receiptOf = (turn: Turn, over: Partial<Receipt> = {}): Receipt => ({
  status: 'succeeded',
  leaseId: turn.leaseId,
  turn: turn.turn,
  output: 'ok',
  usage,
  durationMs: 1,
  ...over,
})

const portOf = (handler: (turn: Turn, io: ExecutorIO) => Promise<Receipt>): ExecutorPort => ({
  run: handler,
})

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  commandSeq = 0
  const db = openDatabase(':memory:')
  const store = createStore({ db, kernel })
  store.ensureProjection()
  world = { db, store }
})

afterEach(() => world.db.close())

const registryRows = (): Array<{ runId: string; pid: number | null; startedAt: string }> =>
  (
    world.db
      .prepare('SELECT run_id, pid, started_at FROM process_registry ORDER BY run_id')
      .all() as unknown as Array<{ run_id: string; pid: number | null; started_at: string }>
  ).map((row) => ({ runId: row.run_id, pid: row.pid, startedAt: row.started_at }))

describe('createProcessRegistry', () => {
  it('begin 写占位行（pid 为空），attachPid 回填，remove 删行', () => {
    const registry = createProcessRegistry(world.db)
    registry.begin('run-1', AT)
    expect(registryRows()).toEqual([{ runId: 'run-1', pid: null, startedAt: AT }])

    registry.attachPid('run-1', 4242)
    expect(registryRows()).toEqual([{ runId: 'run-1', pid: 4242, startedAt: AT }])

    registry.remove('run-1')
    expect(registryRows()).toEqual([])
  })

  it('同一 run 重跑：begin 覆盖旧行并把 pid 重置为空', () => {
    const registry = createProcessRegistry(world.db)
    registry.begin('run-1', AT)
    registry.attachPid('run-1', 100)

    registry.begin('run-1', '2026-01-02T00:00:00.000Z')
    expect(registryRows()).toEqual([
      { runId: 'run-1', pid: null, startedAt: '2026-01-02T00:00:00.000Z' },
    ])
  })

  it('attachPid 对不存在的行静默忽略', () => {
    const registry = createProcessRegistry(world.db)
    registry.attachPid('ghost', 7)
    expect(registryRows()).toEqual([])
  })

  it('list 按 started_at、run_id 排序；clear 清空全表', () => {
    const registry = createProcessRegistry(world.db)
    registry.begin('run-b', '2026-01-02T00:00:00.000Z')
    registry.begin('run-a', '2026-01-01T00:00:00.000Z')
    registry.begin('run-c', '2026-01-02T00:00:00.000Z')

    expect(registry.list().map((row) => row.runId)).toEqual(['run-a', 'run-b', 'run-c'])
    registry.clear()
    expect(registryRows()).toEqual([])
  })

  it('不在投影白名单 / 指纹里：rebuild 不清登记行', () => {
    const registry = createProcessRegistry(world.db)
    registry.begin('run-1', AT)
    registry.attachPid('run-1', 99)

    world.store.rebuild()
    expect(registryRows()).toEqual([{ runId: 'run-1', pid: 99, startedAt: AT }])
  })
})

// ---------- 执行链集成：调度器写入 / 回填 / 删除 ----------

function seedRun(): { runtime: Runtime; run: Record<string, unknown> } {
  const runtimeFacts = world.store.dispatch({
    type: 'runtime.create',
    commandId: nextCommandId(),
    input: { name: 'rt-' + commandSeq, executorKey: 'dsh', command: 'dsh' },
  }).facts
  const runtimeId = (
    runtimeFacts.find((fact) => fact.type === 'runtime.created')?.payload as { runtime: Runtime }
  ).runtime.id
  const runtime = world.store.query('runtimes.all').find((item) => item.id === runtimeId) as Runtime

  const agentFacts = world.store.dispatch({
    type: 'agent.create',
    commandId: nextCommandId(),
    input: { name: 'coder', runtimeId, systemPrompt: 'sys' },
  }).facts
  const agentId = (
    agentFacts.find((fact) => fact.type === 'agent.created')?.payload as { agent: Agent }
  ).agent.id

  const workflowFacts = world.store.dispatch({
    type: 'workflow.create',
    commandId: nextCommandId(),
    input: { name: 'w', stages: [{ name: '执行', entryMode: 'agent', agentId }] },
  }).facts
  const workflowId = (
    workflowFacts.find((fact) => fact.type === 'workflow.created')?.payload as {
      workflow: { id: string }
    }
  ).workflow.id
  // M18：新任务默认落内置「待办」（不派活）；要起 run 必须显式落到自己添加的阶段
  const stageId = (
    workflowFacts
      .filter((fact) => fact.type === 'stage.created')
      .map((fact) => (fact.payload as { stage: WorkflowStage }).stage)
      .find((stage) => (stage.builtin ?? null) === null) as WorkflowStage
  ).id
  // M10：任务必须挂在项目下（项目文件夹就是本轮工作目录）。
  // 同一个库里可能 seed 多次：名称与路径都要唯一（内核按项目集判重）。
  const projectLabel = nextCommandId()
  const projectFacts = world.store.dispatch({
    type: 'project.create',
    commandId: `pj-${projectLabel}`,
    input: { name: `项目 ${projectLabel}`, path: `D:/work/${projectLabel}` },
  }).facts
  const projectId = (
    projectFacts.find((fact) => fact.type === 'project.created')?.payload as {
      project: { id: string }
    }
  ).project.id
  const taskFacts = world.store.dispatch({
    type: 'task.create',
    commandId: nextCommandId(),
    input: { title: 'T', workflowId, projectId, stageId },
  }).facts
  const taskId = (taskFacts.find((fact) => fact.type === 'task.created')?.payload as { task: Task })
    .task.id

  world.store.dispatch({ type: 'run.claim', runtimeId: runtime.id, capacity: 1 })
  const run = world.db
    .prepare('SELECT * FROM runs WHERE task_id = ?')
    .get(taskId) as unknown as Record<string, unknown>
  return { runtime, run }
}

/** 投影行（snake_case）→ `start()` 需要的 RunRow 子集。 */
const claimedRunRow = (run: Record<string, unknown>): RunRow =>
  ({
    id: String(run.id),
    runtimeId: String(run.runtime_id),
    agentId: String(run.agent_id),
    leaseId: String(run.lease_id),
    turn: Number(run.turn),
    status: 'running',
  }) as unknown as RunRow

function makeScheduler(port: ExecutorPort, registry: ProcessRegistry): Scheduler {
  return createScheduler({
    dispatch: (input) => world.store.dispatch(input),
    runtimes: () => world.store.query('runtimes.all'),
    agents: () => world.store.query('agents.all'),
    executors: { forRuntime: () => port },
    timer: fakeTimer(),
    limits: { heartbeatMs: 1_000, runTimeoutMs: 10_000, maxFramesPerBatch: 500 },
    registry,
    now: () => AT,
  })
}

describe('process_registry × scheduler', () => {
  it('执行开始写占位行（pid 空）→ pid 到达回填 → 结束删除', async () => {
    const { run } = seedRun()
    const registry = createProcessRegistry(world.db)
    const gate = deferred()
    const scheduler = makeScheduler(
      portOf(async (turn, io) => {
        await gate.promise
        io.process?.(4242)
        return receiptOf(turn)
      }),
      registry,
    )

    scheduler.start(claimedRunRow(run))
    await Promise.resolve()
    // spawn 前已登记：pid 为空（进程还没起来）
    expect(registryRows()).toEqual([{ runId: String(run.id), pid: null, startedAt: AT }])

    gate.resolve()
    await vi.waitFor(() => expect(registryRows()).toEqual([]))
    await scheduler.idle()
    expect(world.db.prepare('SELECT status FROM runs WHERE id = ?').get(String(run.id))).toEqual({
      status: 'succeeded',
    })
  })

  it('执行器抛错：登记行同样删除（终态不悬空）', async () => {
    const { run } = seedRun()
    const registry = createProcessRegistry(world.db)
    const scheduler = makeScheduler(
      portOf(async () => {
        throw new Error('执行器不可达')
      }),
      registry,
    )

    scheduler.start(claimedRunRow(run))
    await scheduler.idle()

    expect(registryRows()).toEqual([])
    expect(world.db.prepare('SELECT status FROM runs WHERE id = ?').get(String(run.id))).toEqual({
      status: 'failed',
    })
  })
})

// ---------- 适配层：pid 回调透传 ----------

describe('createExecutorPort × pid 回调', () => {
  const backend = (): TestBackend => ({
    async execute(request) {
      request.onSpawn?.(777)
      return {
        status: 'succeeded',
        output: '',
        error: null,
        errorCode: null,
        exitCode: 0,
        sessionId: null,
        resumeRejected: false,
        usage,
        durationMs: 1,
      }
    },
  })

  const turnOf = (): Turn => ({
    runId: 'run-1',
    leaseId: 'run-1:1',
    turn: 1,
    purpose: 'stage',
    prompt: 'p',
    cwd: '',
    access: 'edit',
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  })

  it('后端 spawn 回调 → io.process（宿主登记 pid）', async () => {
    const received: number[] = []
    const port = createExecutorPort(pluginFromBackend(backend()), testContext())
    const io: ExecutorIO = { emit: () => undefined, process: (pid) => received.push(pid) }

    await port.run(turnOf(), io)
    expect(received).toEqual([777])
  })

  it('io 没提供 process 时回调可空（执行器不崩溃）', async () => {
    const port = createExecutorPort(pluginFromBackend(backend()), testContext())
    const io: ExecutorIO = { emit: () => undefined }

    await expect(port.run(turnOf(), io)).resolves.toMatchObject({ status: 'succeeded' })
  })
})
