/**
 * 交接纯函数用例（M7 T5）：目标解析、去重、链深、建任务事实、保存校验。
 *
 * 只构造 `View` 假数据，不起 DB；`decide` 三处钩子的集成用例见
 * `tests/kernel/decide.handoff.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import type {
  Agent,
  Runtime,
  StageInput,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import type { ThreadRow } from '../../src/protocol/thread'
import type { Environment, FactDraft, Id, IdKind, Limits, View } from '../../src/kernel/types'
import {
  HANDOFF_MAX_DEPTH,
  handoffDepth,
  handoffFacts,
  handoffOnExit,
  handedOffAlready,
  handoffTargetOf,
  validateStageHandoffs,
} from '../../src/kernel/handoff'

const CREATED = '2026-11-01T00:00:00.000Z'
const NOW = '2026-11-05T09:00:00.000Z'
const OWNER = { kind: 'owner', via: 'ui' } as const

const LIMITS: Limits = {
  maxStagesPerWorkflow: 50,
  maxArrayLength: 500,
  maxHops: 8,
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 300_000,
  backoffCapMs: 3_600_000,
  runTimeoutMs: 1_800_000,
  cancelGraceMs: 3_000,
  killAfterMs: 2_000,
  maxFramesPerBatch: 500,
}

const env = (): Environment => {
  const counters = new Map<IdKind, number>()
  return {
    timezone: 'Asia/Shanghai',
    limits: LIMITS,
    nextId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-new-${next}`
    },
  }
}

const workflow = (id: string, over: Partial<Workflow> = {}): Workflow => ({
  id,
  name: id,
  description: '',
  createdAt: CREATED,
  ...over,
})

const stage = (
  id: string,
  workflowId: string,
  position: number,
  over: Partial<WorkflowStage> = {},
): WorkflowStage => ({
  id,
  workflowId,
  name: id,
  position,
  entryMode: 'none',
  agentId: null,
  onCompleteStageId: null,
  onRejectStageId: null,
  handoffWorkflowId: null,
  handoffStageId: null,
  ...over,
})

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `任务 ${id}`,
  description: '',
  workflowId: 'wf-a',
  projectId: null,
  currentStageId: 'st-a0',
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: null,
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const agent = (): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '',
  // 执行配置在智能体上（运行时只管连接）
  model: null,
  reasoningEffort: null,
  maxConcurrent: 2,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: CREATED,
})

const runtime = (): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: 'dsh',
  profile: 'multica',
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
})

const view = (
  seed: {
    workflows?: Workflow[]
    stages?: WorkflowStage[]
    tasks?: Task[]
    agents?: Agent[]
    runtimes?: Runtime[]
    threads?: ThreadRow[]
  } = {},
): View => ({
  seq: 7,
  workflows: new Map((seed.workflows ?? []).map((row) => [row.id, row])),
  stages: new Map((seed.stages ?? []).map((row) => [row.id, row])),
  agents: new Map((seed.agents ?? []).map((row) => [row.id, row])),
  runtimes: new Map((seed.runtimes ?? []).map((row) => [row.id, row])),
  projects: new Map(),
  tasks: new Map((seed.tasks ?? []).map((row) => [row.id, row])),
  runs: new Map(),
  cards: new Map(),
  conversations: new Map(),
  messages: new Map(),
  threads: new Map((seed.threads ?? []).map((row) => [row.id, row])),
  taskComments: new Map(),
  reviewReports: new Map(),
  activeTaskIds: new Set(),
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

/** 两工作流：A（st-a0 配交接）→ B（st-b0 / st-b1，st-b1 是 agent 阶段）。 */
const baseView = (over: Partial<WorkflowStage> = {}, targetStageId: string | null = null): View =>
  view({
    workflows: [workflow('wf-a'), workflow('wf-b')],
    stages: [
      stage('st-a0', 'wf-a', 0, {
        handoffWorkflowId: 'wf-b',
        handoffStageId: targetStageId,
        ...over,
      }),
      stage('st-a1', 'wf-a', 1),
      stage('st-b0', 'wf-b', 0),
      stage('st-b1', 'wf-b', 1, { entryMode: 'agent', agentId: 'ag-1' }),
    ],
    agents: [agent()],
    runtimes: [runtime()],
  })

/** 把任务塞进既有视图（`View` 的投影都是 Map，展开后按 id 覆盖 tasks 切片）。 */
const withTasks = (base: View, rows: Task[]): View => ({
  ...base,
  tasks: new Map(rows.map((row) => [row.id, row])),
})

const payloadsOf = <T>(facts: FactDraft[], type: string): T[] =>
  facts.filter((fact) => fact.type === type).map((fact) => fact.payload as T)

describe('kernel/handoff 目标解析', () => {
  it('阶段没配交接 / 目标工作流已删 / 目标是自身 → null', () => {
    const plain = handoffTargetOf(baseView({ handoffWorkflowId: null }), task('t-1'), 'st-a0')

    expect(plain).toBeNull()
    const missing = handoffTargetOf(
      baseView({ handoffWorkflowId: 'wf-gone' }),
      task('t-1'),
      'st-a0',
    )

    expect(missing).toBeNull()
    const self = handoffTargetOf(baseView({ handoffWorkflowId: 'wf-a' }), task('t-1'), 'st-a0')

    expect(self).toBeNull()
  })

  it('handoffStageId 为空 → 目标工作流首阶段（按 position）', () => {
    expect(handoffTargetOf(baseView(), task('t-1'), 'st-a0')).toEqual({
      workflowId: 'wf-b',
      stageId: 'st-b0',
    })
  })

  it('handoffStageId 指定目标阶段；已不属目标工作流 → null', () => {
    expect(handoffTargetOf(baseView({}, 'st-b1'), task('t-1'), 'st-a0')).toEqual({
      workflowId: 'wf-b',
      stageId: 'st-b1',
    })
    // 目标阶段被删（或错指到别的工作流的阶段）：防御性零事实
    expect(handoffTargetOf(baseView({}, 'st-gone'), task('t-1'), 'st-a0')).toBeNull()
  })

  it('目标工作流没有阶段 → null（无处落地）', () => {
    const empty = view({
      workflows: [workflow('wf-a'), workflow('wf-b')],
      stages: [stage('st-a0', 'wf-a', 0, { handoffWorkflowId: 'wf-b' })],
    })

    expect(handoffTargetOf(empty, task('t-1'), 'st-a0')).toBeNull()
    // 阶段行本身不存在（任务当前阶段已失效）
    expect(handoffTargetOf(baseView(), task('t-1'), 'st-gone')).toBeNull()
  })
})

describe('kernel/handoff 去重与链深', () => {
  it('同一 (来源任务, 阶段) 已存在交接产物 → 视为已交接', () => {
    const handed = task('t-2', {
      origin: 'handoff',
      workflowId: 'wf-b',
      currentStageId: 'st-b0',
      handoffFromTaskId: 't-1',
      handoffFromStageId: 'st-a0',
    })

    expect(handedOffAlready(view({ tasks: [handed] }), 't-1', 'st-a0')).toBe(true)
    // 同任务但不同阶段不算
    expect(handedOffAlready(view({ tasks: [handed] }), 't-1', 'st-a1')).toBe(false)
    expect(handedOffAlready(view(), 't-1', 'st-a0')).toBe(false)
  })

  it('链深沿 handoffFromTaskId 回溯；非交接任务为 0；环不无限循环', () => {
    expect(handoffDepth(view(), task('t-1'))).toBe(0)
    const rows = [
      task('t-1'),
      task('t-2', { handoffFromTaskId: 't-1', handoffFromStageId: 'st-a0' }),
      task('t-3', { handoffFromTaskId: 't-2', handoffFromStageId: 'st-a0' }),
    ]
    const chain = withTasks(view(), rows)

    expect(handoffDepth(chain, rows[2])).toBe(2)
    const cyclicRows = [
      task('t-1', { handoffFromTaskId: 't-2' }),
      task('t-2', { handoffFromTaskId: 't-1' }),
    ]
    const cyclic = withTasks(view(), cyclicRows)

    expect(handoffDepth(cyclic, cyclicRows[0])).toBe(1)
    // 祖先任务已删（视图里查不到）：回溯到能查到的层数为准，不抛错
    const orphan = task('t-2', { handoffFromTaskId: 't-gone' })
    const orphaned = withTasks(view(), [orphan])

    expect(handoffDepth(orphaned, orphan)).toBe(1)
  })

  it(`链深上限 ${HANDOFF_MAX_DEPTH}：第 9 层不再交接，第 8 层仍可`, () => {
    const chainOf = (depth: number): Task[] => {
      const rows: Task[] = [task('t-1')]
      for (let index = 2; index <= depth + 1; index += 1) {
        rows.push(
          task(`t-${index}`, {
            origin: 'handoff',
            handoffFromTaskId: `t-${index - 1}`,
            handoffFromStageId: 'st-a0',
          }),
        )
      }
      return rows
    }

    // 来源任务深度 7 → 新任务第 8 层，允许
    const atLimit = withTasks(baseView(), chainOf(HANDOFF_MAX_DEPTH - 1))
    const allowed = handoffFacts(
      atLimit,
      task(`t-${HANDOFF_MAX_DEPTH}`, {
        origin: 'handoff',
        handoffFromTaskId: `t-${HANDOFF_MAX_DEPTH - 1}`,
        handoffFromStageId: 'st-a0',
      }),
      'st-a0',
      NOW,
      env(),
      OWNER,
    )

    expect(allowed.map((fact) => fact.type)).toContain('task.created')
    // 来源任务深度 8 → 新任务第 9 层，拒绝
    const atCap = withTasks(baseView(), chainOf(HANDOFF_MAX_DEPTH))
    const blocked = handoffFacts(
      atCap,
      task(`t-${HANDOFF_MAX_DEPTH + 1}`, {
        origin: 'handoff',
        handoffFromTaskId: `t-${HANDOFF_MAX_DEPTH}`,
        handoffFromStageId: 'st-a0',
      }),
      'st-a0',
      NOW,
      env(),
      OWNER,
    )

    expect(blocked).toEqual([])
  })
})

describe('kernel/handoff 建任务事实', () => {
  it('目标工作流建任务 + 新隐式线程（source=handoff）+ 挂线程', () => {
    const facts = handoffFacts(baseView(), task('t-1'), 'st-a0', NOW, env(), OWNER)

    expect(facts.map((fact) => fact.type)).toEqual([
      'thread.opened',
      'thread.task_attached',
      'task.created',
    ])
    const thread = payloadsOf<{ thread: ThreadRow }>(facts, 'thread.opened')[0].thread
    const created = payloadsOf<{ task: Task }>(facts, 'task.created')[0].task
    const attached = payloadsOf<{ thread: ThreadRow; taskId: Id }>(facts, 'thread.task_attached')[0]

    expect(thread).toMatchObject({
      id: created.threadId,
      source: 'handoff',
      externalRef: null,
      title: '任务 t-1',
      status: 'open',
      // `thread.opened` 携带的是挂任务之前的行，任务随 `thread.task_attached` 进来
      taskIds: [],
      rootTaskIds: [],
    })
    expect(created).toMatchObject({
      origin: 'handoff',
      workflowId: 'wf-b',
      currentStageId: 'st-b0',
      title: '任务 t-1',
      labels: [],
      ruleId: null,
      externalRef: null,
      parentTaskId: 't-1',
      handoffFromTaskId: 't-1',
      handoffFromStageId: 'st-a0',
      status: 'active',
    })
    expect(attached).toMatchObject({ taskId: created.id, ruleId: null })
    expect(attached.thread.taskIds).toEqual([created.id])
    expect(attached.thread.rootTaskIds).toEqual([created.id])
    // 不回写来源任务：整批只有「新建任务」一条任务事实，且不指向来源任务
    const taskFacts = facts.filter((fact) => fact.type.startsWith('task.'))

    expect(taskFacts.map((fact) => fact.type)).toEqual(['task.created'])
    expect(taskFacts.map((fact) => (fact.payload as { task: Task }).task.id)).toEqual([created.id])
  })

  it('目标阶段是 agent → 入口 run 挂在新线程上（turn=1）', () => {
    const facts = handoffFacts(baseView({}, 'st-b1'), task('t-1'), 'st-a0', NOW, env(), OWNER)
    const created = payloadsOf<{ task: Task }>(facts, 'task.created')[0].task
    const run = payloadsOf<{ run: { taskId: Id; threadId: Id | null; turn: number } }>(
      facts,
      'run.queued',
    )[0].run

    expect(run).toMatchObject({ taskId: created.id, threadId: created.threadId, turn: 1 })
  })

  it('目标阶段不是 agent → 零 run.queued', () => {
    const types = handoffFacts(baseView(), task('t-1'), 'st-a0', NOW, env(), OWNER).map(
      (fact) => fact.type,
    )

    expect(types).not.toContain('run.queued')
  })

  it('已交接 / 目标失效 → 零事实', () => {
    const handed = task('t-2', {
      origin: 'handoff',
      workflowId: 'wf-b',
      currentStageId: 'st-b0',
      handoffFromTaskId: 't-1',
      handoffFromStageId: 'st-a0',
    })
    const seeded = withTasks(baseView(), [handed])

    expect(handoffFacts(seeded, task('t-1'), 'st-a0', NOW, env(), OWNER)).toEqual([])
    expect(
      handoffFacts(
        baseView({ handoffWorkflowId: 'wf-gone' }),
        task('t-1'),
        'st-a0',
        NOW,
        env(),
        OWNER,
      ),
    ).toEqual([])
  })

  it('handoffOnExit：成功且向前才交接，打回 / 原地 / 拖回零事实', () => {
    const seeded = view({
      workflows: [workflow('wf-a'), workflow('wf-b')],
      stages: [
        stage('st-a0', 'wf-a', 0),
        stage('st-a1', 'wf-a', 1, { handoffWorkflowId: 'wf-b' }),
        stage('st-a2', 'wf-a', 2),
        stage('st-b0', 'wf-b', 0),
      ],
      agents: [agent()],
      runtimes: [runtime()],
    })
    const from = stage('st-a1', 'wf-a', 1, { handoffWorkflowId: 'wf-b' })
    const earlier = stage('st-a0', 'wf-a', 0)
    const later = stage('st-a2', 'wf-a', 2)

    expect(
      handoffOnExit(seeded, task('t-1'), from, later, true, NOW, env(), OWNER).length,
    ).toBeGreaterThan(0)
    expect(handoffOnExit(seeded, task('t-1'), from, earlier, true, NOW, env(), OWNER)).toEqual([])
    expect(handoffOnExit(seeded, task('t-1'), from, from, true, NOW, env(), OWNER)).toEqual([])
    // 打回即使配到更后阶段也不交接
    expect(handoffOnExit(seeded, task('t-1'), from, later, false, NOW, env(), OWNER)).toEqual([])
  })
})

describe('kernel/handoff 阶段保存校验', () => {
  const input = (over: Partial<StageInput> = {}): StageInput => ({
    name: '阶段',
    entryMode: 'none',
    ...over,
  })

  it('目标工作流存在、阶段属于它 → 合法', () => {
    const seeded = baseView()

    expect(
      validateStageHandoffs(seeded, 'wf-a', [
        input({ handoffWorkflowId: 'wf-b', handoffStageId: 'st-b1' }),
      ]),
    ).toBeNull()
    expect(validateStageHandoffs(seeded, 'wf-a', [input({ handoffWorkflowId: 'wf-b' })])).toBeNull()
    expect(validateStageHandoffs(seeded, 'wf-a', [input()])).toBeNull()
  })

  it('自指 / 目标工作流不存在 / 目标阶段不属于目标工作流 / 只给阶段 → 明确文案', () => {
    const seeded = baseView()

    expect(validateStageHandoffs(seeded, 'wf-a', [input({ handoffWorkflowId: 'wf-a' })])).toBe(
      '阶段「阶段」的交接目标工作流不能是自身',
    )
    expect(validateStageHandoffs(seeded, 'wf-a', [input({ handoffWorkflowId: 'wf-gone' })])).toBe(
      '阶段「阶段」的交接目标工作流不存在: wf-gone',
    )
    expect(
      validateStageHandoffs(seeded, 'wf-a', [
        input({ handoffWorkflowId: 'wf-b', handoffStageId: 'st-a0' }),
      ]),
    ).toBe('阶段「阶段」的交接目标阶段不属于目标工作流: st-a0')
    expect(validateStageHandoffs(seeded, 'wf-a', [input({ handoffStageId: 'st-b0' })])).toBe(
      '阶段「阶段」的交接目标阶段缺少目标工作流',
    )
  })
})

describe('交接任务标题（M7 覆盖补充）', () => {
  it('超长标题按 200 码点截断', () => {
    const facts = handoffFacts(
      baseView(),
      task('t-long', { title: 'x'.repeat(250) }),
      'st-a0',
      NOW,
      env(),
      OWNER,
    )
    const created = facts.find((fact) => fact.type === 'task.created')
    expect(created).toBeDefined()
    const payload = created?.payload as { task: Task }
    expect(payload.task.title).toHaveLength(200)
  })

  it('纯空白标题保留原值兜底（不回落到空串）', () => {
    const facts = handoffFacts(
      baseView(),
      task('t-blank', { title: '   ' }),
      'st-a0',
      NOW,
      env(),
      OWNER,
    )
    const created = facts.find((fact) => fact.type === 'task.created')
    const payload = created?.payload as { task: Task }
    expect(payload.task.title).toBe('   ')
  })
})

describe('kernel/handoff 目标阶段缺失（脏投影）', () => {
  it('handoffOnExit：目标阶段在投影里找不到 → 零事实（不当作「完成」，宁可不交接）', () => {
    const seeded = view({
      workflows: [workflow('wf-a'), workflow('wf-b')],
      stages: [
        stage('st-a0', 'wf-a', 0),
        stage('st-a1', 'wf-a', 1, { handoffWorkflowId: 'wf-b' }),
        stage('st-b0', 'wf-b', 0),
      ],
      agents: [agent()],
      runtimes: [runtime()],
    })
    const from = stage('st-a1', 'wf-a', 1, { handoffWorkflowId: 'wf-b' })

    expect(handoffOnExit(seeded, task('t-1'), from, undefined, true, NOW, env(), OWNER)).toEqual([])
  })
})
