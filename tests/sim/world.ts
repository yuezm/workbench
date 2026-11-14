/**
 * 随机世界（sim）：把「命令 + 宿主输入」的随机序列喂给**真内核 + 真 store + 真 SQLite**。
 *
 * 与逐模块性质测试的分工：性质测试证明单个纯函数在任意坏输入下不破约定；
 * 这里证明**跨模块的状态机**在任意合法序列下不破系统不变量（见 `./invariants`）。
 *
 * 三条自律：
 * 1. 只用确定性随机（`./rng`）与注入的时钟 / id，失败可原样复现；
 * 2. 生成器按库里已有实体取目标，取不到就跳过（不制造无意义的 reject）；
 * 3. `reject` 只记账不断言——随机序列里出现「内核拒绝」是正常结果，不变量只看被接受的路径。
 */
import type { DatabaseSync } from 'node:sqlite'
import { createStore, type Store } from '../../src/host/store'
import { decide } from '../../src/kernel/decide'
import { nextWakeAt } from '../../src/kernel/core/next-wake'
import { project } from '../../src/kernel/scopes/project'
import { viewSpec } from '../../src/kernel/scopes/view-spec'
import type { Input } from '../../src/protocol/inputs'
import type { AutomationRule } from '../../src/protocol/rules'
import { createMemoryDb } from '../host/store/test-support'
import { checkInvariants, type Violation } from './invariants'
import { createRng, type Rng } from './rng'

export interface Rejection {
  type: string
  message: string
}

export interface SimWorld {
  db: DatabaseSync
  store: Store
  rng: Rng
  /** 虚拟时钟：每步前进 1 秒，偶尔跳 5 分钟（把租约 / 退避 / cron 赶到点） */
  clock: { now(): string }
  counter: { next(): number }
  accepted: Map<string, number>
  rejected: Rejection[]
}

const rows = <T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T[] =>
  db.prepare(sql).all(...params) as unknown as T[]

const START = Date.UTC(2026, 0, 1, 0, 0, 0)

const TIMEZONE = 'UTC'

/** 建库 + 底座（运行时 / 智能体 / 项目 / 三阶段工作流），返回可用的世界。 */
export function createWorld(seed: number): SimWorld {
  const db = createMemoryDb()
  let tickMs = 0
  const clock = { now: (): string => new Date(START + tickMs).toISOString() }
  let idSeq = 0
  const store = createStore({
    db,
    kernel: { decide, project, viewSpec, nextWakeAt },
    now: () => clock.now(),
    newId: () => {
      idSeq += 1
      return `id-${String(idSeq).padStart(4, '0')}`
    },
    timezone: TIMEZONE,
  })
  store.ensureProjection()

  const world: SimWorld = {
    db,
    store,
    rng: createRng(seed),
    clock,
    counter: {
      next: (): number => {
        tickMs += 1
        return tickMs
      },
    },
    accepted: new Map(),
    rejected: [],
  }

  seedBase(world)
  return world
}

/** 底座：一条命令运行时、一个智能体、一个项目、一个有 agent 阶段的工作流。 */
function seedBase(world: SimWorld): void {
  dispatch(world, {
    type: 'runtime.create',
    commandId: 'seed-rt',
    input: { name: '本地命令', executorKey: 'command', command: 'echo' },
  })
  const runtimeId = firstId(world.db, 'runtimes')
  dispatch(world, {
    type: 'agent.create',
    commandId: 'seed-ag',
    input: { name: '实现者', runtimeId, permissionMode: 'workspace-write' },
  })
  const agentId = firstId(world.db, 'agents')
  dispatch(world, {
    type: 'project.create',
    commandId: 'seed-pj',
    input: { name: '仿真项目', path: 'D:/sim' },
  })
  dispatch(world, {
    type: 'workflow.create',
    commandId: 'seed-wf',
    input: {
      name: '仿真流程',
      stages: [
        { name: '待办', entryMode: 'none' },
        { name: '进行中', entryMode: 'agent', agentId },
        { name: '收尾', entryMode: 'none' },
      ],
    },
  })
}

function firstId(db: DatabaseSync, table: string): string {
  const row = rows<{ id: string }>(db, `SELECT id FROM ${table} ORDER BY id LIMIT 1`)[0]
  if (row === undefined) throw new Error(`底座建不起来：${table} 空`)
  return row.id
}

let commandSeq = 0
const commandId = (): string => {
  commandSeq += 1
  return `cmd-${commandSeq}`
}

/** 一次 dispatch：成功计入 accepted，reject 记账（不抛给调用方）。 */
function dispatch(world: SimWorld, raw: Record<string, unknown>): void {
  const type = String(raw['type'])
  const input = { ...raw } as unknown as Input
  try {
    world.store.dispatch(input)
    world.accepted.set(type, (world.accepted.get(type) ?? 0) + 1)
  } catch (error) {
    world.rejected.push({ type, message: error instanceof Error ? error.message : String(error) })
  }
}

const list = (
  world: SimWorld,
  sql: string,
  ...params: Array<string | number>
): Array<Record<string, string | number | null>> =>
  rows<Record<string, string | number | null>>(world.db, sql, ...params)

const activeTasks = (world: SimWorld): string[] =>
  list(world, "SELECT id FROM tasks WHERE status = 'active' ORDER BY id").map((row) =>
    String(row['id']),
  )

const allTasks = (world: SimWorld): string[] =>
  list(world, 'SELECT id FROM tasks ORDER BY id').map((row) => String(row['id']))

const openCards = (world: SimWorld): Array<{ id: string; options: number }> =>
  list(world, "SELECT id, options_json FROM cards WHERE status = 'open' ORDER BY id").map(
    (row) => ({
      id: String(row['id']),
      options: (JSON.parse(String(row['options_json'] ?? '[]')) as unknown[]).length,
    }),
  )

const runningRuns = (world: SimWorld): Array<{ id: string; lease: string; turn: number }> =>
  list(world, "SELECT id, lease_id, turn FROM runs WHERE status = 'running' ORDER BY id").map(
    (row) => ({
      id: String(row['id']),
      lease: String(row['lease_id']),
      turn: Number(row['turn']),
    }),
  )

const liveRuns = (world: SimWorld): string[] =>
  list(
    world,
    "SELECT id FROM runs WHERE status IN ('queued', 'running', 'waiting') ORDER BY id",
  ).map((row) => String(row['id']))

/** 一步：按权重挑一件事做；返回是否真的执行了（取不到目标时跳过）。 */
export function step(world: SimWorld): boolean {
  const stageOfWorkflow = list(
    world,
    'SELECT id, workflow_id, entry_mode FROM workflow_stages ORDER BY workflow_id, position',
  )
  const workflowIds = [...new Set(stageOfWorkflow.map((row) => String(row['workflow_id'])))]
  const projectIds = list(world, 'SELECT id FROM projects ORDER BY id').map((row) =>
    String(row['id']),
  )
  const runtimeIds = list(world, 'SELECT id FROM runtimes ORDER BY id').map((row) =>
    String(row['id']),
  )
  const agentIds = list(world, 'SELECT id FROM agents ORDER BY id').map((row) => String(row['id']))
  const threadIds = list(world, 'SELECT id FROM threads ORDER BY id').map((row) =>
    String(row['id']),
  )
  const conversationIds = list(world, 'SELECT id FROM conversations ORDER BY id').map((row) =>
    String(row['id']),
  )
  const ruleIds = list(world, 'SELECT id FROM rule_sets LIMIT 1').length
  const tasks = activeTasks(world)
  const everyTask = allTasks(world)
  const cards = openCards(world)
  const running = runningRuns(world)
  const live = liveRuns(world)

  const n = world.rng.int(1, 100)

  if (n <= 12) {
    const workflowId = world.rng.pick(workflowIds)
    if (workflowId === null) return false
    dispatch(world, {
      type: 'task.create',
      commandId: commandId(),
      input: {
        title: `任务 ${world.rng.int(1, 999)}`,
        description: world.rng.chance(0.4) ? '描述' : '',
        workflowId,
        projectId: world.rng.pick(projectIds),
        parentTaskId: world.rng.chance(0.15) ? world.rng.pick(tasks) : null,
      },
    })
    return true
  }

  if (n <= 22) {
    const taskId = world.rng.pick(tasks)
    if (taskId === null) return false
    const stageId = world.rng.pick(
      list(
        world,
        `SELECT s.id AS id FROM workflow_stages s JOIN tasks t ON t.workflow_id = s.workflow_id WHERE t.id = ?`,
        taskId,
      ).map((row) => String(row['id'])),
    )
    if (stageId === null) return false
    dispatch(world, { type: 'task.move', commandId: commandId(), id: taskId, stageId })
    return true
  }

  if (n <= 27) {
    const taskId = world.rng.pick(tasks)
    if (taskId === null) return false
    dispatch(world, { type: 'task.complete', commandId: commandId(), id: taskId })
    return true
  }

  if (n <= 30) {
    const taskId = world.rng.pick(tasks)
    if (taskId === null) return false
    dispatch(world, { type: 'task.stop', commandId: commandId(), id: taskId })
    return true
  }

  if (n <= 33) {
    const taskId = world.rng.pick(everyTask)
    if (taskId === null) return false
    dispatch(world, { type: 'task.remove', commandId: commandId(), id: taskId })
    return true
  }

  if (n <= 39) {
    const taskId = world.rng.pick(everyTask)
    if (taskId === null) return false
    dispatch(world, {
      type: 'task.comment',
      commandId: commandId(),
      taskId,
      text: `反馈 ${world.rng.int(1, 99)}`,
      rerun: world.rng.chance(0.3),
    })
    return true
  }

  if (n <= 43) {
    const taskId = world.rng.pick(tasks)
    if (taskId === null) return false
    dispatch(world, { type: 'task.rerun', commandId: commandId(), id: taskId })
    return true
  }

  if (n <= 55) {
    const runtimeId = world.rng.pick(runtimeIds)
    if (runtimeId === null) return false
    dispatch(world, { type: 'run.claim', runtimeId, capacity: world.rng.int(1, 3) })
    return true
  }

  if (n <= 58) {
    const run = world.rng.pick(running)
    if (run === null) return false
    dispatch(world, { type: 'run.heartbeat', runId: run.id, leaseId: run.lease })
    return true
  }

  if (n <= 70) {
    const run = world.rng.pick(running)
    if (run === null) return false
    const ask = world.rng.chance(0.3)
    const status = ask
      ? 'succeeded'
      : (world.rng.pick(['succeeded', 'failed', 'cancelled'] as const) ?? 'succeeded')
    dispatch(world, {
      type: 'run.receipt',
      runId: run.id,
      receipt: {
        status,
        leaseId: run.lease,
        turn: run.turn,
        output: `输出 ${world.rng.int(1, 99)}`,
        sessionId: world.rng.chance(0.6) ? `sess-${world.rng.int(1, 5)}` : undefined,
        usage: {
          inputTokens: world.rng.int(1, 500),
          outputTokens: world.rng.int(1, 500),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        ask: ask
          ? [
              {
                title: '选一个',
                text: '怎么走？',
                options: ['甲', '乙'],
                key: `k-${world.rng.int(1, 3)}`,
              },
            ]
          : undefined,
        events: world.rng.chance(0.25)
          ? [
              {
                source: 'sim',
                type: world.rng.pick(['sim.ping', 'sim.alert']) ?? 'sim.ping',
                subject: `s-${world.rng.int(1, 5)}`,
              },
            ]
          : undefined,
        spawn: world.rng.chance(0.15)
          ? [{ subject: `子任务 ${world.rng.int(1, 9)}`, key: `sp-${world.rng.int(1, 3)}` }]
          : undefined,
        later: world.rng.chance(0.1) ? new Date(START + 3_600_000).toISOString() : undefined,
        notes: world.rng.chance(0.2) ? [`笔记 ${world.rng.int(1, 9)}`] : undefined,
      },
    })
    return true
  }

  if (n <= 73) {
    const runId = world.rng.pick(live)
    if (runId === null) return false
    dispatch(world, { type: 'run.cancel', runId })
    return true
  }

  if (n <= 75) {
    const run = world.rng.pick(running)
    if (run === null) return false
    dispatch(world, {
      type: 'run.host_settled',
      runId: run.id,
      leaseId: run.lease,
      turn: run.turn,
      status: 'failed',
      errorCode: 'timeout',
      error: '仿真兜底终态',
    })
    return true
  }

  if (n <= 82) {
    const card = world.rng.pick(cards.filter((item) => item.options > 0))
    if (card === null) return false
    dispatch(world, {
      type: 'card.answer',
      commandId: commandId(),
      cardId: card.id,
      optionIndex: world.rng.int(0, card.options - 1),
      note: world.rng.chance(0.3) ? '补充说明' : undefined,
    })
    return true
  }

  if (n <= 85) {
    const card = world.rng.pick(cards)
    if (card === null) return false
    dispatch(world, { type: 'card.resolve', commandId: commandId(), cardId: card.id })
    return true
  }

  if (n <= 90) {
    dispatch(world, { type: 'clock.tick' })
    return true
  }

  if (n <= 95) {
    const source = world.rng.pick(['sim', 'github']) ?? 'sim'
    dispatch(world, {
      type: 'event.received',
      event: {
        source,
        type: world.rng.pick(['sim.ping', 'sim.alert', 'issues.opened']) ?? 'sim.ping',
        subject: `evt-${world.rng.int(1, 6)}`,
        summary: '外部事件摘要',
        detail: '事件正文（资料）',
      },
      hops: world.rng.chance(0.1) ? 8 : 1,
    })
    return true
  }

  if (n <= 97) {
    const workflowId = world.rng.pick(workflowIds)
    const agentStage = list(
      world,
      "SELECT id FROM workflow_stages WHERE entry_mode = 'agent' ORDER BY id LIMIT 1",
    )[0]
    if (workflowId === null || agentStage === undefined) return false
    const rules: AutomationRule[] = [
      {
        id: 'rule-sim',
        name: '仿真规则',
        when: { source: 'sim', types: ['sim.ping', 'sim.alert'] },
        to: { workflowId, stageId: String(agentStage['id']) },
        enabled: world.rng.chance(0.8),
      },
    ]
    dispatch(world, { type: 'rules.replace', commandId: commandId(), rules })
    return true
  }

  if (n <= 98) {
    if (ruleIds === 0) return false
    dispatch(world, { type: 'rule.trigger', commandId: commandId(), ruleId: 'rule-sim' })
    return true
  }

  if (n <= 99) {
    const threadId = world.rng.pick(threadIds)
    if (threadId === null) return false
    dispatch(
      world,
      world.rng.chance(0.5)
        ? { type: 'thread.note', commandId: commandId(), threadId, text: '线程笔记' }
        : { type: 'thread.close', commandId: commandId(), threadId },
    )
    return true
  }

  const conversationId = world.rng.pick(conversationIds)
  if (conversationId !== null) {
    dispatch(world, {
      type: 'chat.send',
      commandId: commandId(),
      conversationId,
      content: '再说一句',
    })
    return true
  }
  const agentId = world.rng.pick(agentIds)
  if (agentId === null) return false
  dispatch(world, { type: 'chat.create', commandId: commandId(), agentId, title: '仿真对话' })
  return true
}

/** 跑 steps 步，每步结束检查一次不变量；返回首个违规（没有就是 null）与实跑步数。 */
export function runSim(
  world: SimWorld,
  steps: number,
): { violations: Violation[]; executed: number } {
  let executed = 0
  for (let index = 0; index < steps; index += 1) {
    if (step(world)) executed += 1
    // 偶尔跳 5 分钟：租约过期、退避到期、cron 到点才会被 `clock.tick` 消费
    if (world.rng.chance(0.05)) world.counter.next()
    const violations = checkInvariants(world.db)
    if (violations.length > 0) return { violations, executed }
  }
  return { violations: checkInvariants(world.db), executed }
}
