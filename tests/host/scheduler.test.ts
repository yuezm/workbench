// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decide } from '../../src/kernel/decide'
import { project } from '../../src/kernel/project'
import { viewSpec } from '../../src/kernel/view-spec'
import type { KernelPort } from '../../src/kernel/types'
import type {
  Agent,
  RunRow,
  Runtime,
  RuntimeInput,
  Task,
  WorkflowStage,
} from '../../src/protocol/entities'
import type { ExecutorIO, ExecutorPort, Receipt, Turn } from '../../src/protocol/executor'
import { openDatabase } from '../../src/host/db'
import { createScheduler, type Scheduler, type SchedulerTimer } from '../../src/host/scheduler'
import { createStore, type Store } from '../../src/host/store/index'

const kernel: KernelPort = { decide, project, viewSpec }

interface World {
  db: DatabaseSync
  store: Store
}

let world: World
let commandSeq = 0

/**
 * M10：任务必须挂在项目下。这里每次建一个项目并返回 id（文件夹路径只作数据，
 * 不真建目录；执行器测试不读目录）。
 */
function createProject(): string {
  // 同一库可能多次 seed：名称与路径都要唯一（内核按项目集判重）
  const label = nextCommandId()
  const facts = world.store.dispatch({
    type: 'project.create',
    commandId: `pj-${label}`,
    input: { name: `工作台 ${label}`, path: `D:/work/${label}` },
  }).facts
  return (
    facts.find((fact) => fact.type === 'project.created')?.payload as {
      project: { id: string }
    }
  ).project.id
}

const nextCommandId = (): string => {
  commandSeq += 1
  return `cmd-${commandSeq}`
}

const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }

interface FakeTimeout {
  callback: () => void
  delayMs: number
  cancelled: boolean
}

interface FakeTimer extends SchedulerTimer {
  handlers: Array<() => void>
  /** 心跳 interval 被清理次数 */
  readonly cleared: number
  /** 帧窗口 timeout 被清理次数 */
  readonly clearedTimeouts: number
  /** 触发所有未取消的帧窗口定时器（模拟时间窗到点） */
  fireTimeouts(): void
  /** 尚未触发的帧窗口定时器 */
  pendingTimeouts(): FakeTimeout[]
}

/** 假定时器：记录 interval 回调（测试手动触发心跳）与帧窗口 timeout（手动推进）。 */
function fakeTimer(): FakeTimer {
  const handlers: Array<() => void> = []
  const timeouts: FakeTimeout[] = []
  let cleared = 0
  let clearedTimeouts = 0
  return {
    handlers,
    get cleared() {
      return cleared
    },
    get clearedTimeouts() {
      return clearedTimeouts
    },
    setInterval: (callback) => {
      handlers.push(callback)
      return { handle: handlers.length - 1 }
    },
    clearInterval: () => {
      cleared += 1
    },
    setTimeout: (callback, delayMs) => {
      const entry: FakeTimeout = { callback, delayMs, cancelled: false }
      timeouts.push(entry)
      return entry
    },
    clearTimeout: (handle) => {
      const entry = handle as FakeTimeout
      if (!entry.cancelled) {
        entry.cancelled = true
        clearedTimeouts += 1
      }
    },
    fireTimeouts: () => {
      const pending = timeouts.splice(0).filter((entry) => !entry.cancelled)
      for (const entry of pending) entry.callback()
    },
    pendingTimeouts: () => timeouts.filter((entry) => !entry.cancelled),
  }
}

/** 成功/失败回执：leaseId 与 turn 由 Turn 原样带回。 */
const receiptOf = (turn: Turn, over: Partial<Receipt> = {}): Receipt => ({
  status: 'succeeded',
  leaseId: turn.leaseId,
  turn: turn.turn,
  output: 'ok',
  usage,
  durationMs: 7,
  exitCode: 0,
  sessionId: 'sess-1',
  ...over,
})

const portOf = (
  handler: (turn: Turn, io: ExecutorIO) => Promise<Receipt> | Receipt,
): ExecutorPort => ({
  run: async (turn, io) => handler(turn, io),
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

function makeScheduler(
  port: ExecutorPort,
  overrides: Partial<Parameters<typeof createScheduler>[0]> = {},
): Scheduler {
  return createScheduler({
    dispatch: (input) => world.store.dispatch(input),
    runtimes: () => world.store.query('runtimes.all'),
    executors: { forRuntime: () => port },
    timer: fakeTimer(),
    limits: { heartbeatMs: 1_000, runTimeoutMs: 10_000, maxFramesPerBatch: 500 },
    ...overrides,
  })
}

// ---------- 种子（全部走真实决策路径，run 由内核进入效果产生） ----------

function createRuntime(input: Partial<RuntimeInput> & { name: string }): Runtime {
  const facts = world.store.dispatch({
    type: 'runtime.create',
    commandId: nextCommandId(),
    input: { executorKey: 'dsh', command: 'dsh', ...input },
  }).facts
  const id = (
    facts.find((fact) => fact.type === 'runtime.created')?.payload as { runtime: Runtime }
  ).runtime.id
  return world.store.query('runtimes.all').find((runtime) => runtime.id === id) as Runtime
}

function createAgent(runtimeId: string, systemPrompt = 'sys'): Agent {
  const facts = world.store.dispatch({
    type: 'agent.create',
    commandId: nextCommandId(),
    input: { name: 'coder', runtimeId, systemPrompt },
  }).facts
  const id = (facts.find((fact) => fact.type === 'agent.created')?.payload as { agent: Agent })
    .agent.id
  return world.store.query('agents.all').find((agent) => agent.id === id) as Agent
}

interface Seeded {
  runtime: Runtime
  agent: Agent
  task: Task
  workflowId: string
  /** M10：任务所属项目（运行工作目录取它的 path） */
  projectId: string
  stages: { first: string; second: string }
  runId: string
}

/**
 * 建一条「运行时 + 智能体 + 两阶段工作流（首阶段 agent、次阶段 none）+ 任务」的世界；
 * 任务进入 agent 首阶段时，内核自动入队一条 run（T10 把进入效果搬进内核）。
 */
function seed(maxConcurrent = 1, runtimePatch: Partial<RuntimeInput> = {}): Seeded {
  const runtime = createRuntime({ name: 'rt-' + commandSeq, maxConcurrent, ...runtimePatch })
  const agent = createAgent(runtime.id)
  const workflowFacts = world.store.dispatch({
    type: 'workflow.create',
    commandId: nextCommandId(),
    input: {
      name: 'w',
      stages: [
        { name: '执行', entryMode: 'agent', agentId: agent.id },
        { name: '完成', entryMode: 'none' },
      ],
    },
  }).facts
  const workflowId = (
    workflowFacts.find((fact) => fact.type === 'workflow.created')?.payload as {
      workflow: { id: string }
    }
  ).workflow.id
  const stageIds = workflowFacts
    .filter((fact) => fact.type === 'stage.created')
    .map((fact) => (fact.payload as { stage: WorkflowStage }).stage)
    .sort((left, right) => left.position - right.position)
    .map((stage) => stage.id)
  const projectId = createProject()
  const taskFacts = world.store.dispatch({
    type: 'task.create',
    commandId: nextCommandId(),
    input: { title: 'T', description: 'd', workflowId, projectId },
  }).facts
  const task = (taskFacts.find((fact) => fact.type === 'task.created')?.payload as { task: Task })
    .task
  const run = dbRun(task.id)
  return {
    runtime,
    agent,
    task,
    workflowId,
    projectId,
    stages: { first: stageIds[0], second: stageIds[1] },
    runId: String(run.id),
  }
}

/** 任务的第 index 条 run 行（按入队顺序）。 */
function dbRun(taskId: string, index = 0): Record<string, unknown> {
  const rows = world.db
    .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY created_at, rowid')
    .all(taskId) as unknown as Array<Record<string, unknown>>
  const row = rows[index]
  if (!row) throw new Error('没有 run 行')
  return row
}

const runById = (runId: string): Record<string, unknown> | undefined =>
  world.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as unknown as
    Record<string, unknown> | undefined

const eventRows = (runId: string): Array<Record<string, unknown>> =>
  world.db
    .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq')
    .all(runId) as unknown as Array<Record<string, unknown>>

/** 事实日志里的类型序列（断言帧/回执/终态的事实先后）。 */
const factTypes = (): string[] =>
  (
    world.db.prepare('SELECT type FROM facts ORDER BY seq').all() as unknown as Array<{
      type: string
    }>
  ).map((row) => row.type)

interface FrameFact {
  seq: number
  runId: string
  turn: number
  frames: Array<Record<string, unknown>>
}

/** `run.frames` 事实（按事实 seq 升序），payload 反序列化后返回。 */
const frameFacts = (runId?: string): FrameFact[] =>
  (
    world.db
      .prepare("SELECT seq, payload FROM facts WHERE type = 'run.frames' ORDER BY seq")
      .all() as unknown as Array<{
      seq: number
      payload: string
    }>
  )
    .map((row) => {
      const payload = JSON.parse(row.payload) as {
        runId: string
        turn: number
        frames: Array<Record<string, unknown>>
      }
      return { seq: row.seq, ...payload }
    })
    .filter((fact) => runId === undefined || fact.runId === runId)

/** 某人 run 已写的最大帧 seq（模拟装配根注入的 `lastFrameSeq`）。 */
const maxFrameSeq = (runId: string): number =>
  (
    world.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM run_events WHERE run_id = ?')
      .get(runId) as unknown as { n: number }
  ).n

/** 执行中按 turn 发起一次执行（测试跨 turn 的 seq 连续性用）。 */
const claimedRow = (runId: string): RunRow => {
  const row = runById(runId)
  if (!row) throw new Error('缺少 run 行')
  return {
    id: String(row.id),
    runtimeId: row.runtime_id === null ? null : String(row.runtime_id),
    leaseId: row.lease_id === null ? null : String(row.lease_id),
    turn: Number(row.turn),
    status: row.status as RunRow['status'],
  } as unknown as RunRow
}

const runStatuses = (taskId: string): string[] =>
  (
    world.db
      .prepare('SELECT status FROM runs WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId) as unknown as Array<{ status: string }>
  ).map((row) => row.status)

const currentStage = (taskId: string): string | null =>
  (world.store.query('task.byId', { taskId }) as Task | null)?.currentStageId ?? null

const dispatch = (input: unknown): void => {
  world.store.dispatch(input)
}

beforeEach(() => {
  commandSeq = 0
  const db = openDatabase(':memory:')
  const store = createStore({ db, kernel })
  store.ensureProjection()
  world = { db, store }
})

afterEach(() => {
  vi.useRealTimers()
  world.db.close()
})

describe('createScheduler：执行一轮', () => {
  it('成功：run 全字段落库、任务推进到下一阶段', async () => {
    const seeded = seed()
    const scheduler = makeScheduler(portOf((turn) => receiptOf(turn, { output: 'ab' })))

    scheduler.wake()
    await scheduler.idle()

    const run = runById(seeded.runId)
    expect(run).toMatchObject({
      status: 'succeeded',
      output: 'ab',
      error: null,
      error_code: null,
      exit_code: 0,
      session_id: 'sess-1',
      duration_ms: 7,
      lease_id: null,
      deadline_at: null,
    })
    expect(typeof run?.started_at).toBe('string')
    expect(typeof run?.ended_at).toBe('string')
    expect(run?.usage_json).toBe(JSON.stringify(usage))
    expect(currentStage(seeded.task.id)).toBe(seeded.stages.second)
  })

  it('rearmClock：领取与收尾后重排唯一定时器（租约/超时/退避靠它排期）', async () => {
    const seeded = seed()
    const rearmClock = vi.fn()
    const scheduler = makeScheduler(
      portOf((turn) => receiptOf(turn)),
      { rearmClock },
    )

    scheduler.wake()
    await scheduler.idle()

    // 至少两次：execute 开始（把 leaseUntil/deadlineAt 纳入排期）+ finishOnce（下一跳后移）
    expect(rearmClock.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(runById(seeded.runId)).toMatchObject({ status: 'succeeded' })
  })

  it('未注入进程登记表：执行器回报 pid 时走 noop 登记，不影响终态', async () => {
    const seeded = seed()
    const scheduler = makeScheduler(
      portOf((turn, io) => {
        io.process?.(1234)
        return receiptOf(turn)
      }),
    )

    scheduler.wake()
    await scheduler.idle()

    expect(runById(seeded.runId)).toMatchObject({ status: 'succeeded' })
  })

  it('帧：io.emit 的事件按宿主 seq 入 run_events，超出单批上限分包', async () => {
    const seeded = seed()
    const scheduler = makeScheduler(
      portOf((turn, io) => {
        io.emit({ seq: 99, type: 'text', text: 'a' })
        io.emit({ seq: 100, type: 'text', text: 'b' })
        io.emit({ seq: 101, type: 'status', status: 'running' })
        return receiptOf(turn)
      }),
      { limits: { heartbeatMs: 1_000, runTimeoutMs: 10_000, maxFramesPerBatch: 2 } },
    )

    scheduler.wake()
    await scheduler.idle()

    const frames = eventRows(seeded.runId)
    expect(frames.map((row) => row.seq)).toEqual([1, 2, 3])
    expect(JSON.parse(String(frames[0]?.payload_json))).toEqual({ text: 'a' })
    expect(JSON.parse(String(frames[2]?.payload_json))).toEqual({ status: 'running' })
    const factCount = (
      world.db
        .prepare("SELECT COUNT(*) AS n FROM facts WHERE type = 'run.frames'")
        .get() as unknown as {
        n: number
      }
    ).n
    expect(factCount).toBe(2)
  })

  it('帧 seq 从已有最大 seq 继续（重跑不覆盖历史）', async () => {
    const seeded = seed()
    world.db
      .prepare(
        'INSERT INTO run_events (run_id, seq, type, payload_json, created_at) VALUES (?,?,?,?,?)',
      )
      .run(seeded.runId, 5, 'text', JSON.stringify({ text: 'old' }), '2026-01-01T00:00:00.000Z')
    const scheduler = makeScheduler(
      portOf((turn, io) => {
        io.emit({ seq: 1, type: 'text', text: 'new' })
        return receiptOf(turn)
      }),
      { lastFrameSeq: () => 5 },
    )

    scheduler.wake()
    await scheduler.idle()

    expect(eventRows(seeded.runId).map((row) => row.seq)).toEqual([5, 6])
  })

  it('不注入 timer / limits / lastFrameSeq：用默认值也能跑完', async () => {
    const seeded = seed()
    const scheduler = makeScheduler(
      portOf((turn) => receiptOf(turn)),
      {
        timer: undefined,
        limits: undefined,
        lastFrameSeq: undefined,
      },
    )

    scheduler.wake()
    await scheduler.idle()

    expect(runById(seeded.runId)).toMatchObject({ status: 'succeeded' })
  })

  it('执行器抛错：宿主兜底 failed/executor_lost，run 不悬空', async () => {
    const seeded = seed()
    const scheduler = makeScheduler(
      portOf(() => {
        throw new Error('执行器不可达')
      }),
    )

    scheduler.wake()
    await scheduler.idle()

    expect(runById(seeded.runId)).toMatchObject({
      status: 'failed',
      error_code: 'executor_lost',
      error: '执行器不可达',
      lease_id: null,
    })
  })

  it('取消：abort 信号后按回执落 cancelled', async () => {
    const seeded = seed()
    let observed: AbortSignal | null = null
    const gate = deferred()
    const scheduler = makeScheduler(
      portOf(async (turn) => {
        observed = turn.signal
        await gate.promise
        return receiptOf(turn, { status: 'cancelled', output: '', errorCode: 'cancelled' })
      }),
    )

    scheduler.wake()
    await Promise.resolve()
    scheduler.cancel(seeded.runId)
    gate.resolve()
    await scheduler.idle()

    expect((observed as unknown as AbortSignal).aborted).toBe(true)
    expect(runById(seeded.runId)).toMatchObject({ status: 'cancelled', error_code: 'cancelled' })
  })

  it('取消时执行器抛错：兜底 cancelled 而不是 executor_lost', async () => {
    const seeded = seed()
    const gate = deferred()
    const scheduler = makeScheduler(
      portOf(async () => {
        await gate.promise
        throw new Error('进程被终止')
      }),
    )

    scheduler.wake()
    await Promise.resolve()
    scheduler.cancel(seeded.runId)
    gate.resolve()
    await scheduler.idle()

    expect(runById(seeded.runId)).toMatchObject({
      status: 'cancelled',
      error_code: 'cancelled',
      error: '进程被终止',
    })
  })

  it('心跳：定时续租延长 lease_until，结束后清掉定时器', async () => {
    const seeded = seed()
    const timer = fakeTimer()
    const gate = deferred()
    const scheduler = makeScheduler(
      portOf(async (turn) => {
        await gate.promise
        return receiptOf(turn)
      }),
      { timer },
    )

    scheduler.wake()
    await Promise.resolve()
    const before = String(runById(seeded.runId)?.lease_until)
    expect(timer.handlers).toHaveLength(1)
    timer.handlers[0]()
    const after = String(runById(seeded.runId)?.lease_until)
    expect(after > before).toBe(true)

    gate.resolve()
    await scheduler.idle()
    expect(timer.cleared).toBe(1)
  })

  it('任务在 run 期间被删除：回执无处落库也不抛，执行记录随事实删除', async () => {
    const seeded = seed()
    const gate = deferred()
    const scheduler = makeScheduler(
      portOf(async (turn) => {
        await gate.promise
        return receiptOf(turn)
      }),
    )

    scheduler.wake()
    await Promise.resolve()
    dispatch({ type: 'task.remove', commandId: nextCommandId(), id: seeded.task.id })
    gate.resolve()
    await scheduler.idle()

    expect(runById(seeded.runId)).toBeUndefined()
    expect(scheduler.active()).toEqual([])
  })
})

describe('createScheduler：领取与并发', () => {
  it('同一运行时按 maxConcurrent 限流，完成后自动领取下一条', async () => {
    const seeded = seed(1)
    const secondFacts = world.store.dispatch({
      type: 'task.create',
      commandId: nextCommandId(),
      input: {
        title: 'T2',
        workflowId: seeded.workflowId,
        projectId: seeded.projectId,
        stageId: seeded.stages.first,
      },
    }).facts
    const secondTaskId = (
      secondFacts.find((fact) => fact.type === 'task.created')?.payload as { task: Task }
    ).task.id

    const releases = new Map<string, Deferred>()
    let peak = 0
    let active = 0
    const scheduler = makeScheduler(
      portOf(async (turn) => {
        active += 1
        peak = Math.max(peak, active)
        const gate = deferred()
        releases.set(turn.runId, gate)
        await gate.promise
        active -= 1
        return receiptOf(turn)
      }),
    )

    scheduler.wake()
    await Promise.resolve()
    expect(peak).toBe(1)
    expect(runStatuses(seeded.task.id)).toEqual(['running'])
    expect(runStatuses(secondTaskId)).toEqual(['queued'])

    const firstRunId = [...releases.keys()][0] as string
    releases.get(firstRunId)?.resolve()
    await vi.waitFor(() => expect(releases.size).toBe(2))
    const secondRunId = [...releases.keys()][1] as string
    releases.get(secondRunId)?.resolve()
    await scheduler.idle()

    expect(peak).toBe(1)
    expect(runStatuses(seeded.task.id)).toEqual(['succeeded'])
    expect(runStatuses(secondTaskId)).toEqual(['succeeded'])
  })

  it('不同运行时并行执行', async () => {
    const first = seed(1)
    const second = seed(1)
    const releases = new Map<string, Deferred>()
    let peak = 0
    let active = 0
    const scheduler = makeScheduler(
      portOf(async (turn) => {
        active += 1
        peak = Math.max(peak, active)
        const gate = deferred()
        releases.set(turn.runId, gate)
        await gate.promise
        active -= 1
        return receiptOf(turn)
      }),
    )

    scheduler.wake()
    await Promise.resolve()
    expect(peak).toBe(2)

    for (const gate of releases.values()) gate.resolve()
    await scheduler.idle()
    expect(runById(first.runId)?.status).toBe('succeeded')
    expect(runById(second.runId)?.status).toBe('succeeded')
  })

  it('重复 wake 不会重复领取或重复执行', async () => {
    const seeded = seed()
    const execute = vi.fn((turn: Turn) => receiptOf(turn))
    const scheduler = makeScheduler(portOf(execute))

    scheduler.wake()
    scheduler.wake()
    scheduler.wake()
    await scheduler.idle()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(runById(seeded.runId)?.status).toBe('succeeded')
  })

  it('停用的运行时不会被领取：run 保持 queued，执行器不调用', async () => {
    const seeded = seed()
    dispatch({
      type: 'runtime.update',
      commandId: nextCommandId(),
      id: seeded.runtime.id,
      patch: { enabled: false },
    })
    const execute = vi.fn()
    const scheduler = makeScheduler(portOf(execute))

    scheduler.wake()
    await scheduler.idle()

    expect(execute).not.toHaveBeenCalled()
    expect(runById(seeded.runId)).toMatchObject({ status: 'queued' })
  })

  it('接管已领取的 run：运行时缺失时由宿主兜底 failed/runtime_missing', async () => {
    const seeded = seed()
    world.store.dispatch({ type: 'run.claim', runtimeId: seeded.runtime.id, capacity: 1 })
    const claimed = runById(seeded.runId) as Record<string, unknown>
    expect(claimed.status).toBe('running')

    // 运行时被删后 runs.runtime_id 置空（FK 的 ON DELETE SET NULL）：start 判 missing
    world.db.exec('PRAGMA foreign_keys = OFF')
    world.db.prepare('UPDATE runs SET runtime_id = NULL WHERE id = ?').run(seeded.runId)
    world.db.exec('PRAGMA foreign_keys = ON')

    const execute = vi.fn()
    const scheduler = makeScheduler(portOf(execute))
    scheduler.start({
      id: seeded.runId,
      runtimeId: null,
      leaseId: String(claimed.lease_id),
      turn: Number(claimed.turn),
      status: 'running',
    } as unknown as RunRow)
    await scheduler.idle()

    expect(execute).not.toHaveBeenCalled()
    expect(runById(seeded.runId)).toMatchObject({
      status: 'failed',
      error_code: 'runtime_missing',
    })
  })

  it('接管已领取的 run：运行时已停用时兜底 failed/runtime_disabled', async () => {
    const seeded = seed()
    world.store.dispatch({ type: 'run.claim', runtimeId: seeded.runtime.id, capacity: 1 })
    const claimed = runById(seeded.runId) as Record<string, unknown>
    dispatch({
      type: 'runtime.update',
      commandId: nextCommandId(),
      id: seeded.runtime.id,
      patch: { enabled: false },
    })

    const execute = vi.fn()
    const scheduler = makeScheduler(portOf(execute))
    scheduler.start({
      id: seeded.runId,
      runtimeId: seeded.runtime.id,
      leaseId: String(claimed.lease_id),
      turn: Number(claimed.turn),
      status: 'running',
    } as unknown as RunRow)
    await scheduler.idle()

    expect(execute).not.toHaveBeenCalled()
    expect(runById(seeded.runId)).toMatchObject({
      status: 'failed',
      error_code: 'runtime_disabled',
    })
  })
})

describe('createScheduler：阶段链', () => {
  it('链式阶段：成功后自动进入下一 agent 阶段并跑完', async () => {
    const runtime = createRuntime({ name: 'chain', maxConcurrent: 1 })
    const agent = createAgent(runtime.id)
    const workflowFacts = world.store.dispatch({
      type: 'workflow.create',
      commandId: nextCommandId(),
      input: {
        name: 'chain',
        stages: [
          { name: '执行1', entryMode: 'agent', agentId: agent.id },
          { name: '执行2', entryMode: 'agent', agentId: agent.id },
        ],
      },
    }).facts
    const workflowId = (
      workflowFacts.find((fact) => fact.type === 'workflow.created')?.payload as {
        workflow: { id: string }
      }
    ).workflow.id
    const projectId = createProject()
    const taskFacts = world.store.dispatch({
      type: 'task.create',
      commandId: nextCommandId(),
      input: { title: 'T', workflowId, projectId },
    }).facts
    const taskId = (
      taskFacts.find((fact) => fact.type === 'task.created')?.payload as { task: Task }
    ).task.id

    const execute = vi.fn((turn: Turn) => receiptOf(turn))
    const scheduler = makeScheduler(portOf(execute))

    scheduler.wake()
    await scheduler.idle()

    expect(execute).toHaveBeenCalledTimes(2)
    expect(runStatuses(taskId)).toEqual(['succeeded', 'succeeded'])
    expect((world.store.query('task.byId', { taskId }) as Task).status).toBe('completed')
  })
})

describe('createScheduler：诊断', () => {
  it('active() 暴露执行中的 run；没有执行时 idle 立即完成', async () => {
    const seeded = seed()
    const gate = deferred()
    const scheduler = makeScheduler(
      portOf(async (turn) => {
        await gate.promise
        return receiptOf(turn)
      }),
    )

    await scheduler.idle()
    scheduler.wake()
    await Promise.resolve()
    expect(scheduler.active()).toEqual([seeded.runId])

    gate.resolve()
    await scheduler.idle()
    expect(scheduler.active()).toEqual([])
  })
})

describe('createScheduler：Turn 与旁路会话', () => {
  it('Turn 取运行时配置的模型/推理强度；io.session 的会话兜底回执', async () => {
    const seeded = seed(1, { model: 'provider/x', reasoningEffort: 'high', workdir: 'C:/work' })
    let captured: Turn | null = null
    const scheduler = makeScheduler(
      portOf((turn, io) => {
        captured = turn
        io.session?.('sess-observed')
        return receiptOf(turn, { sessionId: undefined })
      }),
    )

    scheduler.wake()
    await scheduler.idle()

    const turn = captured as unknown as Turn
    expect(turn.model).toEqual({ provider: 'provider', id: 'x' })
    expect(turn.effort).toBe('high')
    // M10：任务挂在项目下，工作目录取项目文件夹（优先于运行时 workdir）
    const projectPath = world.store
      .query('projects.all')
      .find((item) => item.id === seeded.projectId)?.path
    expect(projectPath).toBeDefined()
    expect(turn.cwd).toBe(projectPath)
    expect(turn.timeoutMs).toBe(10_000)
    expect(turn.runId).toBe(seeded.runId)
    expect(runById(seeded.runId)?.session_id).toBe('sess-observed')
  })

  it('wake 重入：领取过程中再次 wake 只合并在下一轮，不重复执行', async () => {
    const seeded = seed(1)
    const box: { current?: Scheduler } = {}
    let reentered = false
    const execute = vi.fn((turn: Turn) => receiptOf(turn))
    const scheduler = makeScheduler(portOf(execute), {
      dispatch: (input) => {
        if ((input as { type?: string }).type === 'run.claim' && !reentered) {
          reentered = true
          box.current?.wake()
        }
        return world.store.dispatch(input)
      },
    })
    box.current = scheduler

    scheduler.wake()
    await scheduler.idle()

    expect(reentered).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(runById(seeded.runId)?.status).toBe('succeeded')
  })
})

describe('createScheduler：防御性分支', () => {
  it('同一 run 重复 start：第一次执行中不再重复派发', async () => {
    const seeded = seed()
    world.store.dispatch({ type: 'run.claim', runtimeId: seeded.runtime.id, capacity: 1 })
    const claimed = runById(seeded.runId) as Record<string, unknown>
    const row = {
      id: seeded.runId,
      runtimeId: seeded.runtime.id,
      leaseId: String(claimed.lease_id),
      turn: Number(claimed.turn),
      status: 'running',
    } as unknown as RunRow

    const gate = deferred()
    const execute = vi.fn(async (turn: Turn) => {
      await gate.promise
      return receiptOf(turn)
    })
    const scheduler = makeScheduler(portOf(execute))

    scheduler.start(row)
    scheduler.start(row)
    await Promise.resolve()
    expect(execute).toHaveBeenCalledTimes(1)

    gate.resolve()
    await scheduler.idle()
    expect(runById(seeded.runId)?.status).toBe('succeeded')
  })

  it('异常数据：租约为空的 run 不挂心跳，执行器照常派发', async () => {
    const seeded = seed()
    world.store.dispatch({ type: 'run.claim', runtimeId: seeded.runtime.id, capacity: 1 })
    const timer = fakeTimer()
    const execute = vi.fn((turn: Turn) => receiptOf(turn))
    const scheduler = makeScheduler(portOf(execute), { timer })

    scheduler.start({
      id: seeded.runId,
      runtimeId: seeded.runtime.id,
      leaseId: null,
      turn: 1,
      status: 'running',
    } as unknown as RunRow)
    await scheduler.idle()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(timer.handlers).toHaveLength(0)
  })

  it('pump：run.claim 返回非 run.claimed 事实时跳过启动（不派发执行器）', async () => {
    const seeded = seed()
    const execute = vi.fn()
    const scheduler = makeScheduler(portOf(execute), {
      dispatch: (input) => {
        if ((input as { type?: string }).type === 'run.claim') {
          return { facts: [{ type: 'run.skipped' }] } as never
        }
        return world.store.dispatch(input)
      },
    })

    scheduler.wake()
    await scheduler.idle()

    expect(execute).not.toHaveBeenCalled()
    expect(runById(seeded.runId)).toMatchObject({ status: 'queued' })
  })
})

/** 异常数据：租约为空的 run 行（id / turn 与投影行一致，只是没有租约）。 */
const leaseLessRow = (seeded: Seeded, overrides: Partial<RunRow> = {}): RunRow =>
  ({
    id: seeded.runId,
    runtimeId: seeded.runtime.id,
    leaseId: null,
    turn: 1,
    status: 'queued',
    ...overrides,
  }) as unknown as RunRow

describe('createScheduler：无租约 run 的兜底终态', () => {
  it('运行时不存在：兜底 failed/runtime_missing（租约缺省不拦终态写入）', async () => {
    const seeded = seed()
    const scheduler = makeScheduler(portOf((turn) => receiptOf(turn)))

    scheduler.start({ ...leaseLessRow(seeded), runtimeId: 'rt-missing' })
    await scheduler.idle()

    expect(runById(seeded.runId)).toMatchObject({
      status: 'failed',
      error_code: 'runtime_missing',
    })
    expect(scheduler.active()).toEqual([])
  })

  it('聊天 run 拿不到完整历史：Turn.fallbackPrompt 为 null（不伪造提示词）', async () => {
    const seeded = seed()
    const gate = deferred()
    const captured: Turn[] = []
    const scheduler = makeScheduler(
      portOf(async (turn) => {
        captured.push(turn)
        await gate.promise
        return receiptOf(turn)
      }),
      { chatFallbackPrompt: () => null },
    )

    scheduler.start(leaseLessRow(seeded, { purpose: 'chat', conversationId: 'cv-1' }))
    await Promise.resolve()

    expect(captured[0]?.purpose).toBe('chat')
    expect(captured[0]?.fallbackPrompt).toBeNull()

    gate.resolve()
    await scheduler.idle()
  })

  it('取消无租约 run：宽限与强杀等待都到期后写兜底 cancelled', async () => {
    const seeded = seed()
    const timer = fakeTimer()
    const gate = deferred()
    const scheduler = makeScheduler(
      portOf(async (turn) => {
        await gate.promise
        return receiptOf(turn)
      }),
      { timer },
    )

    scheduler.start(leaseLessRow(seeded))
    await Promise.resolve()
    scheduler.cancel(seeded.runId)

    // 宽限到期：没有登记 pid，不杀进程，挂强杀等待
    timer.fireTimeouts()
    expect(runById(seeded.runId)?.status).toBe('queued')

    // 强杀等待到期：宿主写兜底 cancelled（租约为空所以不带 leaseId）
    timer.fireTimeouts()
    await scheduler.idle()

    expect(runById(seeded.runId)).toMatchObject({
      status: 'cancelled',
      error_code: 'cancelled',
      error: '已取消',
    })
    gate.resolve()
  })

  it('取消时执行器抛空消息错误：错误文案回退「已取消」', async () => {
    const seeded = seed()
    const gate = deferred()
    const scheduler = makeScheduler(
      portOf(async () => {
        await gate.promise
        throw new Error('')
      }),
    )

    scheduler.start(leaseLessRow(seeded))
    await Promise.resolve()
    scheduler.cancel(seeded.runId)
    gate.resolve()
    await scheduler.idle()

    expect(runById(seeded.runId)).toMatchObject({
      status: 'cancelled',
      error_code: 'cancelled',
      error: '已取消',
    })
  })

  it('未取消时执行器抛错（无租约 run）：兜底 failed/executor_lost 并带原始错误', async () => {
    const seeded = seed()
    const scheduler = makeScheduler(
      portOf(() => {
        throw new Error('boom')
      }),
    )

    scheduler.start(leaseLessRow(seeded))
    await scheduler.idle()

    expect(runById(seeded.runId)).toMatchObject({
      status: 'failed',
      error_code: 'executor_lost',
      error: 'boom',
    })
  })
})

describe('createScheduler：帧批量入账（T12）', () => {
  it('运行中按时间窗 flush：16ms 到点写 run.frames，不必等终态', async () => {
    const seeded = seed()
    const gate = deferred()
    const timer = fakeTimer()
    const scheduler = makeScheduler(
      portOf(async (turn, io) => {
        io.emit({ seq: 1, type: 'text', text: 'a' })
        io.emit({ seq: 2, type: 'text', text: 'b' })
        await gate.promise
        return receiptOf(turn)
      }),
      { timer },
    )

    scheduler.wake()
    await Promise.resolve()
    // 还没到时间窗：帧只在缓冲里，没有写事实
    expect(eventRows(seeded.runId)).toHaveLength(0)
    expect(timer.pendingTimeouts().map((entry) => entry.delayMs)).toEqual([16])

    timer.fireTimeouts()

    // 窗口到点即入账；此时 run 仍在执行
    expect(eventRows(seeded.runId).map((row) => row.seq)).toEqual([1, 2])
    expect(runById(seeded.runId)?.status).toBe('running')

    gate.resolve()
    await scheduler.idle()
    expect(runById(seeded.runId)?.status).toBe('succeeded')
    expect(timer.pendingTimeouts()).toEqual([])
  })

  it('缓冲达到 maxFramesPerBatch 立即 flush，不等时间窗', async () => {
    const seeded = seed()
    const gate = deferred()
    const timer = fakeTimer()
    const scheduler = makeScheduler(
      portOf(async (turn, io) => {
        io.emit({ seq: 1, type: 'text', text: 'a' })
        io.emit({ seq: 2, type: 'text', text: 'b' })
        await gate.promise
        return receiptOf(turn)
      }),
      { timer, limits: { heartbeatMs: 1_000, runTimeoutMs: 10_000, maxFramesPerBatch: 2 } },
    )

    scheduler.wake()
    await Promise.resolve()

    expect(eventRows(seeded.runId).map((row) => row.seq)).toEqual([1, 2])
    // 满批 flush 时把挂着的窗口定时器也清掉，避免多余的空 flush
    expect(timer.pendingTimeouts()).toEqual([])

    gate.resolve()
    await scheduler.idle()
    expect(eventRows(seeded.runId)).toHaveLength(2)
  })

  it('超过单批上限：分包成多条 run.frames，帧数与顺序不丢（D7）', async () => {
    const seeded = seed()
    const total = 501
    const scheduler = makeScheduler(
      portOf((turn, io) => {
        // 执行器本地 seq 全是同一个值：宿主必须丢弃、按到达顺序重新分配
        for (let index = 0; index < total; index += 1) {
          io.emit({ seq: 999, type: 'text', text: `f${index}` })
        }
        return receiptOf(turn)
      }),
    )

    scheduler.wake()
    await scheduler.idle()

    const facts = frameFacts(seeded.runId)
    expect(facts.map((fact) => fact.frames.length)).toEqual([500, 1])
    expect(facts.every((fact) => fact.frames.length <= 500)).toBe(true)

    const rows = eventRows(seeded.runId)
    expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1))
    expect(
      rows.map((row) => (JSON.parse(String(row.payload_json)) as { text: string }).text),
    ).toEqual(Array.from({ length: total }, (_, index) => `f${index}`))
  })

  it('终态前 flush 剩余帧：run.frames 事实先于终态事实', async () => {
    const seeded = seed()
    const scheduler = makeScheduler(
      portOf((turn, io) => {
        io.emit({ seq: 1, type: 'text', text: 'a' })
        io.emit({ seq: 2, type: 'status', status: 'running' })
        return receiptOf(turn)
      }),
    )

    scheduler.wake()
    await scheduler.idle()

    const lifecycle = factTypes().filter((type) =>
      ['run.frames', 'run.succeeded', 'run.failed', 'run.cancelled'].includes(type),
    )
    expect(lifecycle).toEqual(['run.frames', 'run.succeeded'])
    expect(eventRows(seeded.runId).map((row) => row.seq)).toEqual([1, 2])
  })

  it('终态后不再接受帧：迟到的 emit 不写 run_events / 事实', async () => {
    const seeded = seed()
    let captured: ExecutorIO | null = null
    const scheduler = makeScheduler(
      portOf((turn, io) => {
        captured = io
        io.emit({ seq: 1, type: 'text', text: 'a' })
        return receiptOf(turn)
      }),
    )

    scheduler.wake()
    await scheduler.idle()
    const eventsBefore = eventRows(seeded.runId)
    const factsBefore = factTypes().length

    ;(captured as unknown as ExecutorIO).emit({ seq: 2, type: 'text', text: 'late' })

    expect(eventRows(seeded.runId)).toEqual(eventsBefore)
    expect(factTypes()).toHaveLength(factsBefore)
  })

  it('seq 跨批 / 跨 turn 全局单调：起始 = 已有最大 seq + 1，执行器本地 seq 丢弃', async () => {
    const seeded = seed()
    world.store.dispatch({ type: 'run.claim', runtimeId: seeded.runtime.id, capacity: 1 })
    const row = claimedRow(seeded.runId)
    let round = 0
    const scheduler = makeScheduler(
      portOf((turn, io) => {
        round += 1
        for (let index = 0; index < 4; index += 1) {
          io.emit({ seq: index + 1, type: 'text', text: `r${round}-${index}` })
        }
        return receiptOf(turn)
      }),
      {
        limits: { heartbeatMs: 1_000, runTimeoutMs: 10_000, maxFramesPerBatch: 2 },
        lastFrameSeq: maxFrameSeq,
      },
    )

    // 第一轮（turn 1）：两批（2 + 2），seq 1–4
    scheduler.start(row)
    await scheduler.idle()

    // 模拟 waiting 回答后续接（T6 的重置路径）：同一 run 回到 running、turn 2，
    // 再交给调度器执行；本轮执行器本地 seq 又从 1 开始，宿主必须接着编号。
    world.db
      .prepare("UPDATE runs SET status = 'running', turn = 2, lease_id = ? WHERE id = ?")
      .run(`${seeded.runId}:2`, seeded.runId)
    scheduler.start({ ...row, turn: 2, leaseId: `${seeded.runId}:2` })
    await scheduler.idle()

    const rows = eventRows(seeded.runId)
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(
      rows.map((row) => (JSON.parse(String(row.payload_json)) as { text: string }).text),
    ).toEqual(['r1-0', 'r1-1', 'r1-2', 'r1-3', 'r2-0', 'r2-1', 'r2-2', 'r2-3'])
  })

  it('结束后清理帧窗口定时器：无待触发回调，心跳 interval 只清一次', async () => {
    seed()
    const gate = deferred()
    const timer = fakeTimer()
    const scheduler = makeScheduler(
      portOf(async (turn, io) => {
        io.emit({ seq: 1, type: 'text', text: 'a' })
        await gate.promise
        return receiptOf(turn)
      }),
      { timer },
    )

    scheduler.wake()
    await Promise.resolve()
    expect(timer.pendingTimeouts()).toHaveLength(1)

    gate.resolve()
    await scheduler.idle()

    expect(timer.pendingTimeouts()).toEqual([])
    expect(timer.clearedTimeouts).toBe(1)
    expect(timer.cleared).toBe(1)
  })

  it('rebuild 后 run_events 与实时写入逐行全等（多批帧 + 终态）', async () => {
    const seeded = seed()
    const scheduler = makeScheduler(
      portOf((turn, io) => {
        for (let index = 0; index < 5; index += 1) {
          io.emit({ seq: 1, type: 'text', text: `f${index}` })
        }
        return receiptOf(turn)
      }),
      { limits: { heartbeatMs: 1_000, runTimeoutMs: 10_000, maxFramesPerBatch: 2 } },
    )

    scheduler.wake()
    await scheduler.idle()

    const selectEvents =
      'SELECT run_id, seq, type, payload_json, created_at FROM run_events ORDER BY run_id, seq'
    const before = world.db.prepare(selectEvents).all()
    expect(frameFacts(seeded.runId)).toHaveLength(3)

    world.store.rebuild()

    expect(world.db.prepare(selectEvents).all()).toEqual(before)
    expect(world.store.query('runs.active-by-task', { taskId: seeded.task.id })).toEqual([])
  })
})

describe('createScheduler：默认定时器与帧窗口收尾（T12b）', () => {
  it('不注入 timer：默认 systemTimer 按 16ms 窗口 flush，终态前清掉待触发窗口', async () => {
    vi.useFakeTimers()
    const seeded = seed()
    const gate = deferred()
    const scheduler = makeScheduler(
      portOf(async (turn, io) => {
        io.emit({ seq: 1, type: 'text', text: 'a' })
        io.emit({ seq: 2, type: 'text', text: 'b' })
        await gate.promise
        // 窗口 flush 之后再来的帧：终态前要清掉新挂的窗口定时器（默认 clearTimeout）
        io.emit({ seq: 3, type: 'text', text: 'c' })
        return receiptOf(turn)
      }),
      { timer: undefined },
    )

    scheduler.wake()
    await vi.advanceTimersByTimeAsync(0)
    // 还没到时间窗：帧只在缓冲里
    expect(eventRows(seeded.runId)).toHaveLength(0)

    vi.advanceTimersByTime(15)
    expect(eventRows(seeded.runId)).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(eventRows(seeded.runId).map((row) => row.seq)).toEqual([1, 2])
    expect(runById(seeded.runId)?.status).toBe('running')

    gate.resolve()
    await scheduler.idle()

    expect(eventRows(seeded.runId).map((row) => row.seq)).toEqual([1, 2, 3])
    expect(runById(seeded.runId)?.status).toBe('succeeded')
    // 心跳 interval 与帧窗口 timeout 都已清理
    expect(vi.getTimerCount()).toBe(0)
  })

  it('注入 timer 缺 clearTimeout：窗口清理回退系统 clearTimeout，帧不丢', async () => {
    const seeded = seed()
    const gate = deferred()
    const timer: SchedulerTimer = {
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 1,
    }
    const scheduler = makeScheduler(
      portOf(async (turn, io) => {
        io.emit({ seq: 1, type: 'text', text: 'a' })
        await gate.promise
        return receiptOf(turn)
      }),
      { timer },
    )

    scheduler.wake()
    await Promise.resolve()
    expect(eventRows(seeded.runId)).toHaveLength(0)

    gate.resolve()
    await scheduler.idle()

    expect(eventRows(seeded.runId).map((row) => row.seq)).toEqual([1])
    expect(runById(seeded.runId)?.status).toBe('succeeded')
  })

  it('未注入登记表：取消宽限到期 pidOf 走缺省 null，强杀后写 cancelled', async () => {
    const seeded = seed()
    const gate = deferred()
    const timer = fakeTimer()
    const scheduler = makeScheduler(
      portOf(async (turn) => {
        await gate.promise
        return receiptOf(turn)
      }),
      { timer },
    )

    scheduler.wake()
    await Promise.resolve()
    scheduler.cancel(seeded.runId)
    // 宽限到期：缺省登记表 pidOf 返回 null → 不杀进程，挂强杀等待
    timer.fireTimeouts()
    expect(runById(seeded.runId)?.status).toBe('running')
    // 强杀等待到期：宿主写兜底 cancelled
    timer.fireTimeouts()
    await scheduler.idle()

    expect(runById(seeded.runId)?.status).toBe('cancelled')
    expect(runById(seeded.runId)?.error_code).toBe('cancelled')
    gate.resolve()
  })
})

describe('createScheduler：执行器插件缺失与取消收尾的空窗（M3）', () => {
  it('运行时 executorKey 未注册：forRuntime 返回 null → failed/runtime_missing，执行器不调用', async () => {
    const seeded = seed()
    const execute = vi.fn((turn: Turn) => receiptOf(turn))
    const rearm = vi.fn()
    const scheduler = makeScheduler(portOf(execute), {
      executors: { forRuntime: () => null },
      rearmClock: rearm,
    })

    scheduler.wake()
    await scheduler.idle()

    expect(execute).not.toHaveBeenCalled()
    expect(runById(seeded.runId)).toMatchObject({
      status: 'failed',
      error_code: 'runtime_missing',
    })
    // 文案带未注册的 key，便于用户定位配置
    expect(String(runById(seeded.runId)?.error)).toContain('dsh')
    expect(rearm).toHaveBeenCalled()
  })

  it('注入 timer 缺 setTimeout：帧窗口回退系统 setTimeout，帧不丢', async () => {
    vi.useFakeTimers()
    const seeded = seed()
    const gate = deferred()
    const timer: SchedulerTimer = {
      setInterval: () => 0,
      clearInterval: () => undefined,
      clearTimeout: () => undefined,
    }
    const scheduler = makeScheduler(
      portOf(async (turn, io) => {
        io.emit({ seq: 1, type: 'text', text: 'a' })
        await gate.promise
        return receiptOf(turn)
      }),
      { timer },
    )

    scheduler.wake()
    await vi.advanceTimersByTimeAsync(0)
    // 窗口未到：帧只在缓冲里（回退的系统 setTimeout 由假时钟接管）
    expect(eventRows(seeded.runId)).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(16)
    expect(eventRows(seeded.runId).map((row) => row.seq)).toEqual([1])

    gate.resolve()
    await scheduler.idle()
    expect(runById(seeded.runId)?.status).toBe('succeeded')
  })

  it('timer 缺 clearTimeout：收尾后宽限定时器才触发，看到已收尾就停手', async () => {
    const seeded = seed()
    const base = fakeTimer()
    // 注入 timer 没有 clearTimeout：收尾清理回退系统 clearTimeout（对假句柄是 no-op）
    const timer: SchedulerTimer = {
      setInterval: base.setInterval,
      clearInterval: base.clearInterval,
      setTimeout: base.setTimeout,
    }
    const gate = deferred()
    const scheduler = makeScheduler(
      portOf(async (turn) => {
        await gate.promise
        return receiptOf(turn, { status: 'cancelled', errorCode: 'cancelled' })
      }),
      { timer },
    )

    scheduler.wake()
    await Promise.resolve()
    scheduler.cancel(seeded.runId)
    // 宽限内执行器自己交回执：收尾把 cancelTimers 置空，但假定时器没被真正清掉
    gate.resolve()
    await scheduler.idle()
    expect(runById(seeded.runId)).toMatchObject({ status: 'cancelled' })

    const factsBefore = factTypes().length
    base.fireTimeouts()
    // 已收尾：宽限回调直接返回，不杀进程、不写第二个终态
    expect(factTypes()).toHaveLength(factsBefore)
    expect(runById(seeded.runId)).toMatchObject({ status: 'cancelled' })
  })

  it('timer 缺 clearTimeout：强杀等待中收到回执，kill 定时器触发时看到已收尾就停手', async () => {
    const seeded = seed()
    const base = fakeTimer()
    const timer: SchedulerTimer = {
      setInterval: base.setInterval,
      clearInterval: base.clearInterval,
      setTimeout: base.setTimeout,
    }
    const gate = deferred()
    const scheduler = makeScheduler(
      portOf(async (turn) => {
        await gate.promise
        return receiptOf(turn, { status: 'cancelled', errorCode: 'cancelled' })
      }),
      { timer, killPid: vi.fn(() => true) },
    )

    scheduler.wake()
    await Promise.resolve()
    scheduler.cancel(seeded.runId)
    // 宽限到期：挂上强杀等待定时器（缺省登记表 pid 为 null，不杀进程）
    base.fireTimeouts()
    expect(runById(seeded.runId)?.status).toBe('running')

    // 强杀等待期间执行器交回执：终态先落，cancelTimers 置空
    gate.resolve()
    await scheduler.idle()
    expect(runById(seeded.runId)).toMatchObject({ status: 'cancelled' })

    const factsBefore = factTypes().length
    base.fireTimeouts()
    // 已收尾：强杀等待回调直接返回，不写第二个终态
    expect(factTypes()).toHaveLength(factsBefore)
    expect(runById(seeded.runId)).toMatchObject({ status: 'cancelled' })
  })
})
