/**
 * 派单事实用例（M29，M7 交接的重做）：去重、链深、建任务事实、保存校验。
 *
 * 只构造 `View` 假数据，不起 DB；触发条件与目标解析的纯函数用例见
 * `tests/kernel/workflow/stage-handoffs.test.ts`，`decide` 三处钩子的集成用例见
 * `tests/kernel/decide.handoff.test.ts`。
 */
import { describe, expect, it } from 'vitest'
import type {
  Agent,
  Runtime,
  StageHandoff,
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
  handoffOnExit,
  handedOffAlready,
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
  exits: {},
  judge: null,
  handoffs: [],
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
  handoffFromRunId: null,
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

const handoff = (over: Partial<StageHandoff> = {}): StageHandoff => ({
  on: 'done',
  workflowId: 'wf-b',
  stageId: null,
  ...over,
})

/**
 * 两工作流：A（st-a0 配派单）→ B（st-b0 / st-b1，st-b1 是 agent 阶段）。
 * `over` 覆盖 st-a0 的字段，`handoffs` 直接给派单清单。
 */
const baseView = (handoffs: StageHandoff[] = [handoff()]): View =>
  view({
    workflows: [workflow('wf-a'), workflow('wf-b')],
    stages: [
      stage('st-a0', 'wf-a', 0, { handoffs }),
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

/** 视图里的 st-a0（来源阶段）；派单事实都从它身上取配置。 */
const sourceStage = (seeded: View): WorkflowStage => seeded.stages.get('st-a0') as WorkflowStage

const exit = (
  seeded: View,
  source: Task,
  guard: 'done' | 'errored' | 'passed' | 'failed' | 'manual',
  options?: { forward?: boolean; runId?: string | null },
): FactDraft[] =>
  handoffOnExit(seeded, source, sourceStage(seeded), guard, NOW, env(), OWNER, options)

describe('kernel/handoff 去重与链深', () => {
  it('同一轮 run 已派过 → 不重复建；另一轮 / 人工离开不算', () => {
    const handed = task('t-2', {
      origin: 'handoff',
      workflowId: 'wf-b',
      currentStageId: 'st-b0',
      handoffFromTaskId: 't-1',
      handoffFromStageId: 'st-a0',
      handoffFromRunId: 'run-9',
    })

    expect(handedOffAlready(view({ tasks: [handed] }), 'run-9')).toBe(true)
    // 另一轮 run：同一阶段第二次成功要能再派一张
    expect(handedOffAlready(view({ tasks: [handed] }), 'run-10')).toBe(false)
    expect(handedOffAlready(view(), 'run-9')).toBe(false)
    // 人工离开没有 run：不去重，每次拖动 / 完成都是一次独立发起
    expect(handedOffAlready(view({ tasks: [handed] }), null)).toBe(false)
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

  it(`链深上限 ${HANDOFF_MAX_DEPTH}：第 9 层不再派单，第 8 层仍可`, () => {
    const chainOf = (depth: number): Task[] => {
      const rows: Task[] = [task('t-1')]
      for (let index = 2; index <= depth + 1; index += 1) {
        rows.push(
          task(`t-${index}`, {
            origin: 'handoff',
            handoffFromTaskId: `t-${index - 1}`,
            handoffFromStageId: 'st-a0',
            handoffFromRunId: null,
          }),
        )
      }
      return rows
    }

    // 来源任务深度 7 → 新任务第 8 层，允许
    const atLimit = withTasks(baseView(), chainOf(HANDOFF_MAX_DEPTH - 1))
    const allowed = exit(
      atLimit,
      task(`t-${HANDOFF_MAX_DEPTH}`, {
        origin: 'handoff',
        handoffFromTaskId: `t-${HANDOFF_MAX_DEPTH - 1}`,
        handoffFromStageId: 'st-a0',
        handoffFromRunId: null,
      }),
      'done',
    )

    expect(allowed.map((fact) => fact.type)).toContain('task.created')
    // 来源任务深度 8 → 新任务第 9 层，拒绝
    const atCap = withTasks(baseView(), chainOf(HANDOFF_MAX_DEPTH))
    const blocked = exit(
      atCap,
      task(`t-${HANDOFF_MAX_DEPTH + 1}`, {
        origin: 'handoff',
        handoffFromTaskId: `t-${HANDOFF_MAX_DEPTH}`,
        handoffFromStageId: 'st-a0',
        handoffFromRunId: null,
      }),
      'done',
    )

    expect(blocked).toEqual([])
  })
})

describe('kernel/handoff 触发条件分组', () => {
  it('只派命中这一组的单：done 配的不在 errored 时派', () => {
    const seeded = baseView([handoff({ on: 'done' })])

    expect(exit(seeded, task('t-1'), 'done').length).toBeGreaterThan(0)
    expect(exit(seeded, task('t-1'), 'errored')).toEqual([])
    expect(exit(seeded, task('t-1'), 'manual', { forward: true })).toEqual([])
  })

  it('同一阶段可以同时配「成功派 A、失败派 B」：各走各的', () => {
    const seeded = view({
      workflows: [workflow('wf-a'), workflow('wf-ok'), workflow('wf-bad')],
      stages: [
        stage('st-a0', 'wf-a', 0, {
          entryMode: 'agent',
          agentId: 'ag-1',
          judge: { maxFails: 3 },

          exits: {},
          handoffs: [
            handoff({ on: 'passed', workflowId: 'wf-ok' }),
            handoff({ on: 'failed', workflowId: 'wf-bad' }),
          ],
        }),
        stage('st-ok0', 'wf-ok', 0),
        stage('st-bad0', 'wf-bad', 0),
      ],
      agents: [agent()],
      runtimes: [runtime()],
    })
    const source = task('t-1')

    const passed = exit(seeded, source, 'passed')

    expect(
      payloadsOf<{ task: Task }>(passed, 'task.created').map((item) => item.task.workflowId),
    ).toEqual(['wf-ok'])

    const failed = exit(seeded, source, 'failed')

    expect(
      payloadsOf<{ task: Task }>(failed, 'task.created').map((item) => item.task.workflowId),
    ).toEqual(['wf-bad'])
  })

  it('同一触发条件可扇出到多个目标：一批里建多条任务', () => {
    const seeded = view({
      workflows: [workflow('wf-a'), workflow('wf-b'), workflow('wf-c')],
      stages: [
        stage('st-a0', 'wf-a', 0, {
          handoffs: [
            handoff({ on: 'done', workflowId: 'wf-b' }),
            handoff({ on: 'done', workflowId: 'wf-c' }),
          ],
        }),
        stage('st-b0', 'wf-b', 0),
        stage('st-c0', 'wf-c', 0),
      ],
    })

    const created = payloadsOf<{ task: Task }>(exit(seeded, task('t-1'), 'done'), 'task.created')

    expect(created.map((item) => item.task.workflowId)).toEqual(['wf-b', 'wf-c'])
  })

  it('manual 的「仅向前」：拖回更前阶段不派单', () => {
    const seeded = baseView([handoff({ on: 'manual' })])

    expect(exit(seeded, task('t-1'), 'manual', { forward: true }).length).toBeGreaterThan(0)
    expect(exit(seeded, task('t-1'), 'manual', { forward: false })).toEqual([])
  })

  it('同一轮已派过 / 目标工作流已删 → 零事实', () => {
    const handed = task('t-2', {
      origin: 'handoff',
      workflowId: 'wf-b',
      currentStageId: 'st-b0',
      handoffFromTaskId: 't-1',
      handoffFromStageId: 'st-a0',
      handoffFromRunId: 'run-9',
    })

    expect(exit(withTasks(baseView(), [handed]), task('t-1'), 'done', { runId: 'run-9' })).toEqual(
      [],
    )
    expect(exit(baseView([handoff({ workflowId: 'wf-gone' })]), task('t-1'), 'done')).toEqual([])
  })

  it('同一阶段第二次成功（新一轮 run）→ 再派一张；人工离开也不去重', () => {
    const handed = task('t-2', {
      origin: 'handoff',
      workflowId: 'wf-b',
      currentStageId: 'st-b0',
      handoffFromTaskId: 't-1',
      handoffFromStageId: 'st-a0',
      handoffFromRunId: 'run-9',
    })
    const seeded = withTasks(baseView([handoff({ on: 'done' }), handoff({ on: 'manual' })]), [
      handed,
    ])

    const again = exit(seeded, task('t-1'), 'done', { runId: 'run-10' })

    expect(payloadsOf<{ task: Task }>(again, 'task.created')).toHaveLength(1)
    // 人工拖两次 → 两张单
    expect(
      payloadsOf<{ task: Task }>(exit(seeded, task('t-1'), 'manual'), 'task.created'),
    ).toHaveLength(1)
  })
})

describe('kernel/handoff 建任务事实', () => {
  it('目标工作流建任务 + 新隐式线程（source=handoff）+ 挂线程', () => {
    const facts = exit(baseView(), task('t-1'), 'done')

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
      handoffFromRunId: null,
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
    const facts = exit(baseView([handoff({ stageId: 'st-b1' })]), task('t-1'), 'done')
    const created = payloadsOf<{ task: Task }>(facts, 'task.created')[0].task
    const run = payloadsOf<{ run: { taskId: Id; threadId: Id | null; turn: number } }>(
      facts,
      'run.queued',
    )[0].run

    expect(run).toMatchObject({ taskId: created.id, threadId: created.threadId, turn: 1 })
  })

  it('目标阶段不是 agent → 零 run.queued', () => {
    const types = exit(baseView(), task('t-1'), 'done').map((fact) => fact.type)

    expect(types).not.toContain('run.queued')
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
      validateStageHandoffs(seeded, 'wf-a', [input({ handoffs: [handoff({ stageId: 'st-b1' })] })]),
    ).toBeNull()
    expect(validateStageHandoffs(seeded, 'wf-a', [input()])).toBeNull()
  })

  it('自指 / 目标工作流不存在 / 目标阶段不属于目标工作流 / 终态派单 → 明确文案', () => {
    const seeded = baseView()

    expect(
      validateStageHandoffs(seeded, 'wf-a', [
        input({ handoffs: [handoff({ workflowId: 'wf-a' })] }),
      ]),
    ).toBe('阶段「阶段」的派单目标工作流不能是自身')
    expect(
      validateStageHandoffs(seeded, 'wf-a', [
        input({ handoffs: [handoff({ workflowId: 'wf-gone' })] }),
      ]),
    ).toBe('阶段「阶段」的派单目标工作流不存在: wf-gone')
    expect(
      validateStageHandoffs(seeded, 'wf-a', [input({ handoffs: [handoff({ stageId: 'st-a0' })] })]),
    ).toBe('阶段「阶段」的派单目标阶段不属于目标工作流: st-a0')
    // 目标阶段已被删（视图里查不到）：同一个文案，不当作合法
    expect(
      validateStageHandoffs(seeded, 'wf-a', [
        input({ handoffs: [handoff({ stageId: 'st-gone' })] }),
      ]),
    ).toBe('阶段「阶段」的派单目标阶段不属于目标工作流: st-gone')
    expect(
      validateStageHandoffs(seeded, 'wf-a', [input({ builtin: 'done', handoffs: [handoff()] })]),
    ).toBe('内置阶段「阶段」不允许派单')
  })
})

describe('派单任务标题（M7 覆盖补充）', () => {
  it('超长标题按 200 码点截断', () => {
    const facts = exit(baseView(), task('t-long', { title: 'x'.repeat(250) }), 'done')
    const created = facts.find((fact) => fact.type === 'task.created')
    expect(created).toBeDefined()
    const payload = created?.payload as { task: Task }
    expect(payload.task.title).toHaveLength(200)
  })

  it('纯空白标题保留原值兜底（不回落到空串）', () => {
    const facts = exit(baseView(), task('t-blank', { title: '   ' }), 'done')
    const created = facts.find((fact) => fact.type === 'task.created')
    const payload = created?.payload as { task: Task }
    expect(payload.task.title).toBe('   ')
  })
})

describe('kernel/handoff 事实内容', () => {
  it('描述按 2000 码点截断后带进新任务', () => {
    const facts = exit(baseView(), task('t-d', { description: 'y'.repeat(2100) }), 'done')
    const created = payloadsOf<{ task: Task }>(facts, 'task.created')[0].task

    expect(created.description).toHaveLength(2000)
    expect(created.title).toBe('任务 t-d')
  })

  it('沿用来源任务的项目（同一工作目录）', () => {
    const facts = exit(baseView(), task('t-p', { projectId: 'pj-1' }), 'done')
    const created = payloadsOf<{ task: Task }>(facts, 'task.created')[0].task

    expect(created.projectId).toBe('pj-1')
  })

  it('扇出到两个工作流：两条任务、两条独立线程', () => {
    const seeded = view({
      workflows: [workflow('wf-a'), workflow('wf-b'), workflow('wf-c')],
      stages: [
        stage('st-a0', 'wf-a', 0, {
          handoffs: [
            handoff({ on: 'done', workflowId: 'wf-b' }),
            handoff({ on: 'done', workflowId: 'wf-c' }),
          ],
        }),
        stage('st-b0', 'wf-b', 0),
        stage('st-c0', 'wf-c', 0),
      ],
    })
    const created = payloadsOf<{ task: Task }>(
      exit(seeded, task('t-1'), 'done'),
      'task.created',
    ).map((item) => item.task)

    expect(created).toHaveLength(2)
    expect(new Set(created.map((item) => item.threadId)).size).toBe(2)
    expect(created[0].id).not.toBe(created[1].id)
  })
})
