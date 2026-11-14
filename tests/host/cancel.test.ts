// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decide } from '../../src/kernel/decide'
import { project } from '../../src/kernel/scopes/project'
import { viewSpec } from '../../src/kernel/scopes/view-spec'
import type { KernelPort } from '../../src/kernel/core/types'
import type { Agent, Runtime, Task, WorkflowStage } from '../../src/protocol/entities'
import type { ExecutorIO, ExecutorPort, Receipt, Turn } from '../../src/protocol/executor'
import { createEffects } from '../../src/host/effects'
import { createCommandRouter, type CommandRouter } from '../../src/host/commands'
import { createProcessRegistry, type ProcessRegistry } from '../../src/host/process-registry'
import { createScheduler, type Scheduler, type SchedulerTimer } from '../../src/host/scheduler'
import { createStore, type Store } from '../../src/host/store/index'
import { openDatabase } from '../../src/host/db'

const kernel: KernelPort = { decide, project, viewSpec }
const AT = '2026-01-01T00:00:00.000Z'
const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }
const GRACE_MS = 1_000
const KILL_AFTER_MS = 2_000
const FRAME_FLUSH_MS = 60_000

interface World {
  db: DatabaseSync
  store: Store
}

let world: World
let commandSeq = 0

const nextCommandId = (): string => {
  commandSeq += 1
  return `cmd-${commandSeq}`
}

interface FakeTimeout {
  callback: () => void
  delayMs: number
  cancelled: boolean
}

interface FakeTimer extends SchedulerTimer {
  pending(): FakeTimeout[]
  fire(delayMs: number): void
  intervalCount(): number
}

/** 假定时器：按延迟手动触发单次定时器（取消宽限 / 强杀等待 / 帧窗口）。 */
function fakeTimer(): FakeTimer {
  const intervals: Array<() => void> = []
  const timeouts: FakeTimeout[] = []
  return {
    setInterval: (callback) => {
      intervals.push(callback)
      return { handle: intervals.length - 1 }
    },
    clearInterval: () => undefined,
    setTimeout: (callback, delayMs) => {
      const entry: FakeTimeout = { callback, delayMs, cancelled: false }
      timeouts.push(entry)
      return entry
    },
    clearTimeout: (handle) => {
      ;(handle as FakeTimeout).cancelled = true
    },
    pending: () => timeouts.filter((entry) => !entry.cancelled),
    fire: (delayMs) => {
      const entry = timeouts.find((item) => !item.cancelled && item.delayMs === delayMs)
      if (!entry) throw new Error(`没有 ${delayMs}ms 的待触发定时器`)
      entry.cancelled = true
      entry.callback()
    },
    intervalCount: () => intervals.length,
  }
}

const receiptOf = (turn: Turn, over: Partial<Receipt> = {}): Receipt => ({
  status: 'succeeded',
  leaseId: turn.leaseId,
  turn: turn.turn,
  output: 'ok',
  usage,
  durationMs: 1,
  sessionId: 'sess-1',
  ...over,
})

const portOf = (
  handler: (turn: Turn, io: ExecutorIO) => Promise<Receipt> | Receipt,
): ExecutorPort => ({
  run: async (turn, io) => handler(turn, io),
})

const runById = (runId: string): Record<string, unknown> | undefined =>
  world.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as unknown as
    Record<string, unknown> | undefined

const taskById = (taskId: string): Task | null =>
  world.store.query('task.byId', { taskId }) as Task | null

const factTypes = (): string[] =>
  (
    world.db.prepare('SELECT type FROM facts ORDER BY seq').all() as unknown as Array<{
      type: string
    }>
  ).map((row) => row.type)

const terminalFacts = (type: string): number =>
  (
    world.db.prepare('SELECT COUNT(*) AS n FROM facts WHERE type = ?').get(type) as unknown as {
      n: number
    }
  ).n

beforeEach(() => {
  commandSeq = 0
  const db = openDatabase(':memory:')
  const store = createStore({ db, kernel })
  store.ensureProjection()
  world = { db, store }
})

afterEach(() => world.db.close())

interface Seeded {
  runtime: Runtime
  taskId: string
  workflowId: string
  run: Record<string, unknown>
  runId: string
}

/** 建「运行时 + 智能体 + agent 单阶段工作流 + 任务」，返回内核入队的 run 行。 */
function seedTask(entryMode: 'agent' | 'none' = 'agent'): Seeded {
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
    // M27：并发窗口在智能体上（这里是 2，允许取消用例同时压多条 run）
    input: { name: 'coder', runtimeId, systemPrompt: 'sys', maxConcurrent: 2 },
  }).facts
  const agentId = (
    agentFacts.find((fact) => fact.type === 'agent.created')?.payload as { agent: Agent }
  ).agent.id

  const workflowFacts = world.store.dispatch({
    type: 'workflow.create',
    commandId: nextCommandId(),
    input: {
      name: 'w',
      stages: [{ name: '执行', entryMode, ...(entryMode === 'agent' ? { agentId } : {}) }],
    },
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
  const run = world.db
    .prepare('SELECT * FROM runs WHERE task_id = ?')
    .get(taskId) as unknown as Record<string, unknown>
  return { runtime, taskId, workflowId, run, runId: String(run.id) }
}

interface Harness {
  scheduler: Scheduler
  timer: FakeTimer
  registry: ProcessRegistry
  killPid: ReturnType<typeof vi.fn<(pid: number) => boolean>>
}

function makeScheduler(
  port: ExecutorPort,
  options: {
    timer?: FakeTimer
    registry?: ProcessRegistry
    executors?: { forRuntime: (runtime: Runtime) => ExecutorPort }
    dispatch?: Parameters<typeof createScheduler>[0]['dispatch']
  } = {},
): Harness {
  const timer = options.timer ?? fakeTimer()
  const registry = options.registry ?? createProcessRegistry(world.db)
  const killPid = vi.fn<(pid: number) => boolean>(() => true)
  const scheduler = createScheduler({
    dispatch: options.dispatch ?? world.store.dispatch,
    runtimes: () => world.store.query('runtimes.all'),
    agents: () => world.store.query('agents.all'),
    executors: options.executors ?? { forRuntime: () => port },
    timer,
    limits: {
      heartbeatMs: 30_000,
      runTimeoutMs: 600_000,
      maxFramesPerBatch: 500,
      cancelGraceMs: GRACE_MS,
      killAfterMs: KILL_AFTER_MS,
    },
    frameFlushMs: FRAME_FLUSH_MS,
    lastFrameSeq: () => 0,
    registry,
    killPid,
    now: () => AT,
  })
  return { scheduler, timer, registry, killPid }
}

/** 让调度器领取任务并开始执行，等到执行器真正被调用。 */
async function startRun(harness: Harness, seeded: Seeded): Promise<void> {
  harness.scheduler.wake()
  await Promise.resolve()
  expect(harness.scheduler.active()).toEqual([seeded.runId])
}

/** 执行器：上报 pid 后挂起，直到 abort 才返回取消回执（模拟配合取消的进程）。 */
const cancellablePort = (): ExecutorPort =>
  portOf(async (turn, io) => {
    io.process?.(4242)
    await new Promise<void>((resolve) => {
      if (turn.signal.aborted) resolve()
      turn.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    return receiptOf(turn, { status: 'cancelled', output: '', errorCode: 'cancelled' })
  })

/** 执行器：上报 pid 后永不返回（模拟忽略取消、卡死的进程），`release()` 交迟到回执。 */
function stuckPort(): { port: ExecutorPort; release: () => void } {
  let settle: () => void = () => undefined
  let seen: Turn | null = null
  const port = portOf((turn, io) => {
    io.process?.(4242)
    seen = turn
    return new Promise<Receipt>((resolve) => {
      settle = () => resolve(receiptOf(seen as unknown as Turn))
    })
  })
  return { port, release: () => settle() }
}

describe('cancel：执行中 run 的取消时序', () => {
  it('宽限内执行器自己交回执：按回执落 cancelled，不杀进程、不留定时器', async () => {
    const seeded = seedTask()
    const harness = makeScheduler(cancellablePort())
    await startRun(harness, seeded)

    harness.scheduler.cancel(seeded.runId)
    await harness.scheduler.idle()

    expect(runById(seeded.runId)).toMatchObject({
      status: 'cancelled',
      error_code: 'cancelled',
      lease_id: null,
    })
    expect(harness.killPid).not.toHaveBeenCalled()
    expect(harness.timer.pending()).toEqual([])
    expect(harness.registry.list()).toEqual([])
    expect(harness.scheduler.active()).toEqual([])
  })

  it('超宽限强杀：先 killPidTree(pid)，再等 killAfterMs 写兜底 cancelled 并清理', async () => {
    const seeded = seedTask()
    const stuck = stuckPort()
    const harness = makeScheduler(stuck.port)
    await startRun(harness, seeded)
    expect(harness.registry.pidOf(seeded.runId)).toBe(4242)

    harness.scheduler.cancel(seeded.runId)
    // 宽限到的第一件事是杀进程树，还没有终态
    harness.timer.fire(GRACE_MS)
    expect(harness.killPid).toHaveBeenCalledWith(4242)
    expect(runById(seeded.runId)?.status).toBe('running')

    harness.timer.fire(KILL_AFTER_MS)

    expect(runById(seeded.runId)).toMatchObject({
      status: 'cancelled',
      error_code: 'cancelled',
      error: '已取消',
    })
    expect(harness.registry.list()).toEqual([])
    expect(harness.scheduler.active()).toEqual([])
    expect(harness.timer.pending()).toEqual([])
    expect(terminalFacts('run.cancelled')).toBe(1)
  })

  it('强杀后仍是执行器的迟到回执：不写第二个终态、不抛错', async () => {
    const seeded = seedTask()
    const stuck = stuckPort()
    const harness = makeScheduler(stuck.port)
    await startRun(harness, seeded)

    harness.scheduler.cancel(seeded.runId)
    harness.timer.fire(GRACE_MS)
    harness.timer.fire(KILL_AFTER_MS)
    const factsBefore = factTypes().length

    // 执行器此时才交回执：调度器已收尾，忽略
    stuck.release()
    await Promise.resolve()
    await Promise.resolve()

    expect(runById(seeded.runId)).toMatchObject({ status: 'cancelled', error_code: 'cancelled' })
    expect(factTypes()).toHaveLength(factsBefore)
    expect(terminalFacts('run.cancelled')).toBe(1)
  })

  it('强杀后执行器才交回执（兜底终态之前）：按回执落终态，撤销等待中的兜底定时器', async () => {
    const seeded = seedTask()
    let releaseReceipt: () => void = () => undefined
    let seen: Turn | null = null
    const port = portOf((turn, io) => {
      io.process?.(4242)
      seen = turn
      return new Promise<Receipt>((resolve) => {
        releaseReceipt = () =>
          resolve(
            receiptOf(seen as unknown as Turn, { status: 'cancelled', errorCode: 'cancelled' }),
          )
      })
    })
    const harness = makeScheduler(port)
    await startRun(harness, seeded)

    harness.scheduler.cancel(seeded.runId)
    harness.timer.fire(GRACE_MS)
    expect(harness.killPid).toHaveBeenCalledWith(4242)
    // 进程被强杀后自己交回执：兜底终态的等待定时器应被撤销
    releaseReceipt()
    await harness.scheduler.idle()

    expect(runById(seeded.runId)).toMatchObject({ status: 'cancelled', error_code: 'cancelled' })
    expect(terminalFacts('run.cancelled')).toBe(1)
    expect(harness.timer.pending()).toEqual([])
    expect(harness.registry.list()).toEqual([])
  })

  it('强杀后执行器迟到的抛错：兜底终态已写，只当收尾信号', async () => {
    const seeded = seedTask()
    let rejectPort: (error: Error) => void = () => undefined
    const port = portOf((_turn, io) => {
      io.process?.(4242)
      return new Promise<Receipt>((_resolve, reject) => {
        rejectPort = reject
      })
    })
    const harness = makeScheduler(port)
    await startRun(harness, seeded)

    harness.scheduler.cancel(seeded.runId)
    harness.timer.fire(GRACE_MS)
    harness.timer.fire(KILL_AFTER_MS)
    const factsBefore = factTypes().length

    rejectPort(new Error('进程被终止'))
    await Promise.resolve()
    await Promise.resolve()

    expect(runById(seeded.runId)).toMatchObject({ status: 'cancelled', error_code: 'cancelled' })
    expect(factTypes()).toHaveLength(factsBefore)
  })

  it('重复 cancel 幂等：只挂一条宽限链、只写一次终态、只杀一次', async () => {
    const seeded = seedTask()
    const stuck = stuckPort()
    const harness = makeScheduler(stuck.port)
    await startRun(harness, seeded)

    harness.scheduler.cancel(seeded.runId)
    harness.scheduler.cancel(seeded.runId)
    harness.scheduler.cancel(seeded.runId)
    expect(harness.timer.pending().filter((entry) => entry.delayMs === GRACE_MS)).toHaveLength(1)

    harness.timer.fire(GRACE_MS)
    harness.timer.fire(KILL_AFTER_MS)
    // 终态后再取消：内核已终态，不重复写事实
    harness.scheduler.cancel(seeded.runId)
    harness.scheduler.cancel(seeded.runId)

    expect(terminalFacts('run.cancelled')).toBe(1)
    expect(harness.killPid).toHaveBeenCalledTimes(1)
    expect(harness.timer.pending()).toEqual([])
  })

  it('pid 缺失（执行器未上报）：宽限到期不杀，仍按 killAfterMs 写兜底终态', async () => {
    const seeded = seedTask()
    const stuck = stuckPort()
    const harness = makeScheduler(stuck.port)
    // 执行前先把 pid 从登记表抹掉（等价于执行器没回调 io.process）
    await startRun(harness, seeded)
    world.db.prepare('UPDATE process_registry SET pid = NULL WHERE run_id = ?').run(seeded.runId)

    harness.scheduler.cancel(seeded.runId)
    harness.timer.fire(GRACE_MS)
    expect(harness.killPid).not.toHaveBeenCalled()

    harness.timer.fire(KILL_AFTER_MS)
    expect(runById(seeded.runId)).toMatchObject({ status: 'cancelled', error_code: 'cancelled' })
    expect(harness.registry.list()).toEqual([])
  })

  it('取消排队中的 run（没有执行器）：直接写兜底终态，不挂取消定时器', async () => {
    const seeded = seedTask()
    const harness = makeScheduler(portOf((turn) => receiptOf(turn)))
    // 不 wake：run 留在 queued
    expect(runById(seeded.runId)?.status).toBe('queued')

    harness.scheduler.cancel(seeded.runId)

    expect(runById(seeded.runId)).toMatchObject({ status: 'cancelled', error_code: 'cancelled' })
    expect(harness.timer.pending()).toEqual([])
    expect(harness.killPid).not.toHaveBeenCalled()
    expect(taskById(seeded.taskId)?.status).toBe('active')
    expect(taskById(seeded.taskId)?.currentStageId).toBe(seeded.run.stage_id)
  })
})

describe('cancel：删除任务 / 工作流前先取消', () => {
  /**
   * 三动词的命令路由（生产入口）：删除类命令在 preflight 里先取消活跃 run 再落删除事实。
   * 写路径仍走 effects.dispatch（run.cancel_requested → scheduler.cancel 走真实链路）。
   */
  function makeRouter(harness: Harness): CommandRouter {
    return createCommandRouter({
      store: world.store,
      dispatch: harnessDispatch(harness),
      executors: { forRuntime: () => null },
      executorDefaults: (key) => ({
        executorKey: key ?? 'dsh',
        command: 'dsh',
        profile: 'multica',
      }),
      hostView: () => null,
    })
  }

  /** IPC 的写入口：effects.dispatch（run.cancel_requested → scheduler.cancel 走真实链路）。 */
  function harnessDispatch(harness: Harness) {
    const effects = createEffects({
      store: world.store,
      scheduler: () => harness.scheduler,
    })
    return (input: unknown) => effects.dispatch(input)
  }

  it('删任务：先 dispatch run.cancel（cancel_requested 先于 task.removed），删除本身不抛错', async () => {
    const seeded = seedTask()
    const stuck = stuckPort()
    const harness = makeScheduler(stuck.port)
    const router = makeRouter(harness)
    await startRun(harness, seeded)

    // 删除命令不抛错：路由先取消活跃 run，再落 task.removed
    await expect(
      router.dispatch({ commandId: nextCommandId(), type: 'task.remove', id: seeded.taskId }),
    ).resolves.toBeDefined()

    const types = factTypes()
    expect(types).toContain('run.cancel_requested')
    expect(types.indexOf('run.cancel_requested')).toBeLessThan(types.indexOf('task.removed'))
    // 任务与 run 都已从投影删除（迟到回执不会复活它们）
    expect(taskById(seeded.taskId)).toBeNull()
    expect(runById(seeded.runId)).toBeUndefined()

    // 执行器迟到的回执：内核 not_found 被调度器吞掉，本地状态清干净
    stuck.release()
    await harness.scheduler.idle()
    expect(harness.scheduler.active()).toEqual([])
    expect(harness.registry.list()).toEqual([])
  })

  it('删工作流：该工作流下所有活跃 run 都被取消后再删', async () => {
    const seeded = seedTask()
    const stuck = stuckPort()
    const harness = makeScheduler(stuck.port)
    const router = makeRouter(harness)
    await startRun(harness, seeded)

    await router.dispatch({
      commandId: nextCommandId(),
      type: 'workflow.remove',
      id: seeded.workflowId,
    })

    const types = factTypes()
    expect(types.filter((type) => type === 'run.cancel_requested')).toHaveLength(1)
    expect(types.indexOf('run.cancel_requested')).toBeLessThan(types.indexOf('workflow.removed'))
    expect(world.store.query('workflows.all')).toEqual([])

    stuck.release()
    await harness.scheduler.idle()
    expect(harness.registry.list()).toEqual([])
  })
})

describe('cancel：退出（cancelAll）', () => {
  it('对活跃 run 立即杀进程树并写取消终态；退出中不再领取新 run', async () => {
    const running = seedTask()
    const stuck = stuckPort()
    const harness = makeScheduler(stuck.port)
    await startRun(harness, running)
    // 退出前又入队一条 run（不领取）：cancelAll 之后不应再被领起来
    const queued = seedTask()
    expect(runById(queued.runId)?.status).toBe('queued')

    harness.scheduler.cancelAll()

    expect(harness.killPid).toHaveBeenCalledWith(4242)
    expect(runById(running.runId)).toMatchObject({
      status: 'cancelled',
      error_code: 'cancelled',
    })
    expect(harness.scheduler.active()).toEqual([])
    expect(harness.registry.list()).toEqual([])

    // draining：再 wake 也不领取排队中的 run（退出期间不起新进程）
    harness.scheduler.wake()
    expect(runById(queued.runId)?.status).toBe('queued')
    await harness.scheduler.idle()
  })

  it('cancelAll：执行器未上报 pid 时跳过杀树，仍写兜底终态并释放 active', async () => {
    const running = seedTask()
    const stuck = stuckPort()
    const harness = makeScheduler(stuck.port)
    await startRun(harness, running)
    // 等价于执行器没有回调 io.process：登记行在，但没有 pid 可杀
    world.db.prepare('UPDATE process_registry SET pid = NULL WHERE run_id = ?').run(running.runId)

    harness.scheduler.cancelAll()

    expect(harness.killPid).not.toHaveBeenCalled()
    expect(runById(running.runId)).toMatchObject({
      status: 'cancelled',
      error_code: 'cancelled',
    })
    expect(harness.scheduler.active()).toEqual([])
    expect(harness.registry.list()).toEqual([])
  })
})
