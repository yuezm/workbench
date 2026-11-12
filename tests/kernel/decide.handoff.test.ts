/**
 * 交接三处钩子的集成用例（M7 T5）：成功流转 / 向前拖拽 / 直接完成触发交接，
 * 打回与拖回不触发，同一 `(任务, 阶段)` 只交接一次，阶段保存时校验目标。
 *
 * 纯内核：只构造 `View` 假数据与 `Environment` 计数器，不起 DB。
 */
import { describe, expect, it } from 'vitest'
import type {
  Agent,
  RunRow,
  Runtime,
  StageHandoff,
  StageInput,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import type { ThreadRow } from '../../src/protocol/thread'
import type { Environment, FactDraft, Id, IdKind, Limits, View } from '../../src/kernel/types'
import { decide } from '../../src/kernel/decide'

const CREATED = '2026-11-01T00:00:00.000Z'
const NOW = '2026-11-05T09:00:00.000Z'

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

const workflow = (id: string): Workflow => ({
  id,
  name: id,
  description: '',
  createdAt: CREATED,
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
  handoffs: [],
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: '写计划',
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

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 'task-1',
  conversationId: null,
  stageId: 'st-a0',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'dsh',
  threadId: null,
  cwd: '',
  access: 'edit',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 1,
  status: 'running',
  prompt: '',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  leaseId: 'run-1:1',
  attempt: 1,
  attempts: 0,
  leaseUntil: '2026-11-05T09:02:00.000Z',
  notBefore: null,
  deadlineAt: '2026-11-05T09:30:00.000Z',
  cancelRequested: false,
  deliverables: null,
  startedAt: NOW,
  endedAt: null,
  createdAt: NOW,
  ...over,
})

/** 一条派单：默认「跑完时」派到 wf-b 首阶段。 */
const handoff = (over: Partial<StageHandoff> = {}): StageHandoff => ({
  on: 'done',
  workflowId: 'wf-b',
  stageId: null,
  ...over,
})

/** A（st-a0 配派单 → B）/ B（st-b1 是 agent 阶段）的默认阶段集。 */
const stages = (
  a0: Partial<WorkflowStage> = {},
  a1: Partial<WorkflowStage> = {},
  a2: Partial<WorkflowStage> = {},
): WorkflowStage[] => [
  stage('st-a0', 'wf-a', 0, { handoffs: [handoff(), handoff({ on: 'manual' })], ...a0 }),
  stage('st-a1', 'wf-a', 1, a1),
  stage('st-a2', 'wf-a', 2, a2),
  stage('st-b0', 'wf-b', 0),
  stage('st-b1', 'wf-b', 1, { entryMode: 'agent', agentId: 'ag-1' }),
]

const view = (
  seed: {
    stages?: WorkflowStage[]
    tasks?: Task[]
    runs?: RunRow[]
    threads?: ThreadRow[]
  } = {},
): View => ({
  seq: 7,
  workflows: new Map([workflow('wf-a'), workflow('wf-b')].map((row) => [row.id, row])),
  stages: new Map((seed.stages ?? stages()).map((row) => [row.id, row])),
  agents: new Map([agent()].map((row) => [row.id, row])),
  runtimes: new Map([runtime()].map((row) => [row.id, row])),
  projects: new Map(),
  tasks: new Map((seed.tasks ?? [task()]).map((row) => [row.id, row])),
  runs: new Map((seed.runs ?? []).map((row) => [row.id, row])),
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

const command = (input: Record<string, unknown>) => ({ commandId: 'cmd-1', ...input }) as never

const typesOf = (facts: FactDraft[]): string[] => facts.map((fact) => fact.type)

const payloadsOf = <T>(facts: FactDraft[], type: string): T[] =>
  facts.filter((fact) => fact.type === type).map((fact) => fact.payload as T)

const stageInput = (over: Partial<StageInput> = {}): StageInput => ({
  name: '阶段',
  entryMode: 'none',
  ...over,
})

describe('kernel/decide 派单——直接完成', () => {
  it('task.complete：先产交接事实（目标工作流建任务），再产 task.completed', () => {
    const decision = decide(view(), command({ type: 'task.complete', id: 'task-1' }), NOW, env())

    expect(typesOf(decision.facts)).toEqual([
      'thread.opened',
      'thread.task_attached',
      'task.created',
      'task.completed',
    ])
    const thread = payloadsOf<{ thread: ThreadRow }>(decision.facts, 'thread.opened')[0].thread
    const created = payloadsOf<{ task: Task }>(decision.facts, 'task.created')[0].task

    expect(thread).toMatchObject({ id: created.threadId, source: 'handoff', title: '写计划' })
    expect(created).toMatchObject({
      origin: 'handoff',
      workflowId: 'wf-b',
      currentStageId: 'st-b0',
      handoffFromTaskId: 'task-1',
      handoffFromStageId: 'st-a0',
      handoffFromRunId: null,
      parentTaskId: 'task-1',
    })
  })

  it('当前阶段没配派单 → 只有 task.completed', () => {
    const decision = decide(
      view({ stages: stages({ handoffs: [] }) }),
      command({ type: 'task.complete', id: 'task-1' }),
      NOW,
      env(),
    )

    expect(typesOf(decision.facts)).toEqual(['task.completed'])
  })

  it('同一轮 run 已派过 → 不重复建（人工完成没有 run，再次完成就是新的一张）', () => {
    const handed: Task = task({
      id: 'task-handed',
      origin: 'handoff',
      workflowId: 'wf-b',
      currentStageId: 'st-b0',
      handoffFromTaskId: 'task-1',
      handoffFromStageId: 'st-a0',
      handoffFromRunId: 'run-1',
    })
    // 人工完成不带 run：不会因为「同一任务同一阶段派过」就吞掉——这是第二次发起
    const decision = decide(
      view({ tasks: [task(), handed] }),
      command({ type: 'task.complete', id: 'task-1' }),
      NOW,
      env(),
    )

    expect(typesOf(decision.facts)).toEqual([
      'thread.opened',
      'thread.task_attached',
      'task.created',
      'task.completed',
    ])
  })

  it('目标阶段是 agent → 同一批里产入口 run（挂新线程）', () => {
    const decision = decide(
      view({
        stages: stages({
          handoffs: [handoff({ stageId: 'st-b1' }), handoff({ on: 'manual', stageId: 'st-b1' })],
        }),
      }),
      command({ type: 'task.complete', id: 'task-1' }),
      NOW,
      env(),
    )

    expect(typesOf(decision.facts)).toContain('run.queued')
    const created = payloadsOf<{ task: Task }>(decision.facts, 'task.created')[0].task
    const queued = payloadsOf<{ run: { taskId: Id; threadId: Id | null } }>(
      decision.facts,
      'run.queued',
    )[0].run

    expect(queued).toMatchObject({ taskId: created.id, threadId: created.threadId })
  })
})

describe('kernel/decide 派单——拖拽', () => {
  it('拖到更后阶段：派单事实排在 task.moved 之后', () => {
    const decision = decide(
      view(),
      command({ type: 'task.move', id: 'task-1', stageId: 'st-a1' }),
      NOW,
      env(),
    )

    expect(typesOf(decision.facts)).toEqual([
      'task.moved',
      'thread.opened',
      'thread.task_attached',
      'task.created',
    ])
    const created = payloadsOf<{ task: Task }>(decision.facts, 'task.created')[0].task

    expect(created.handoffFromStageId).toBe('st-a0')
  })

  it('拖回更前阶段 → 不派单', () => {
    const decision = decide(
      view({ tasks: [task({ currentStageId: 'st-a2' })] }),
      command({ type: 'task.move', id: 'task-1', stageId: 'st-a1' }),
      NOW,
      env(),
    )

    // M22：拖回更前阶段是人工跳转（自然去向不是它），留一条评论；仍不交接
    expect(typesOf(decision.facts)).toEqual(['task.moved', 'task.comment_added'])
  })

  it('拖到当前阶段（原地）→ 不派单', () => {
    const decision = decide(
      view(),
      command({ type: 'task.move', id: 'task-1', stageId: 'st-a0' }),
      NOW,
      env(),
    )

    expect(typesOf(decision.facts)).toEqual(['task.moved'])
  })
})

describe('kernel/decide 派单——运行结算', () => {
  const receive = (target: View, receipt: Record<string, unknown>) =>
    decide(target, { type: 'run.receipt', runId: 'run-1', receipt } as never, NOW, env())

  it('成功流转：派单事实在 task.moved 之前（同一批）', () => {
    const decision = receive(view({ runs: [run()] }), {
      status: 'succeeded',
      leaseId: 'run-1:1',
      turn: 1,
      output: '完成',
    })

    expect(typesOf(decision.facts)).toEqual([
      'run.succeeded',
      'thread.opened',
      'thread.task_attached',
      'task.created',
      'task.moved',
    ])
    expect(payloadsOf<{ task: Task }>(decision.facts, 'task.created')[0].task).toMatchObject({
      origin: 'handoff',
      workflowId: 'wf-b',
      handoffFromTaskId: 'task-1',
      handoffFromStageId: 'st-a0',
      handoffFromRunId: 'run-1',
    })
  })

  it('最后阶段成功 → 完成并派单', () => {
    const decision = receive(
      view({
        tasks: [task({ currentStageId: 'st-a2' })],
        // 只有最后阶段（st-a2）配交接：成功流转到终端 = 完成
        stages: stages({ handoffs: [] }, {}, { handoffs: [handoff()] }),
        runs: [run()],
      }),
      { status: 'succeeded', leaseId: 'run-1:1', turn: 1 },
    )

    expect(typesOf(decision.facts)).toEqual([
      'run.succeeded',
      'thread.opened',
      'thread.task_attached',
      'task.created',
      'task.completed',
    ])
  })

  it('打回（即使 onReject 配到更后阶段）→ 不派单', () => {
    const decision = receive(
      view({
        stages: stages({ onRejectStageId: 'st-a2' }),
        runs: [run()],
      }),
      { status: 'failed', leaseId: 'run-1:1', turn: 1, errorCode: 'run_failed' },
    )

    expect(typesOf(decision.facts)).toEqual(['run.failed', 'task.moved'])
  })
})

describe('kernel/decide 派单——阶段保存校验', () => {
  it('workflow.create：合法派单写进 stage.created', () => {
    const decision = decide(
      view(),
      command({
        type: 'workflow.create',
        input: {
          name: '新工作流',
          stages: [stageInput({ handoffs: [handoff({ stageId: 'st-b1' })] })],
        },
      }),
      NOW,
      env(),
    )

    // M18：内置阶段也各产一条 stage.created，这里按交接两列定位用户阶段
    const created = payloadsOf<{ stage: WorkflowStage }>(decision.facts, 'stage.created')
      .map((payload) => payload.stage)
      .find((item) => item.handoffs.length > 0)

    expect(created).toMatchObject({ handoffs: [handoff({ stageId: 'st-b1' })] })
  })

  it('workflow.create：目标工作流不存在 / 目标阶段不属于目标工作流 → reject', () => {
    const missing = decide(
      view(),
      command({
        type: 'workflow.create',
        input: {
          name: '新工作流',
          stages: [stageInput({ handoffs: [handoff({ workflowId: 'wf-gone' })] })],
        },
      }),
      NOW,
      env(),
    )

    expect(missing).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '阶段「阶段」的派单目标工作流不存在: wf-gone' },
    })
    const foreign = decide(
      view(),
      command({
        type: 'workflow.create',
        input: {
          name: '新工作流',
          stages: [stageInput({ handoffs: [handoff({ stageId: 'st-a0' })] })],
        },
      }),
      NOW,
      env(),
    )

    expect(foreign.reject).toEqual({
      code: 'invalid_input',
      message: '阶段「阶段」的派单目标阶段不属于目标工作流: st-a0',
    })
  })

  it('workflow.update：改派单清单会落 stage.updated（不被 sameStage 吞掉）', () => {
    const decision = decide(
      view({ stages: stages({ handoffs: [] }) }),
      command({
        type: 'workflow.update',
        id: 'wf-a',
        input: {
          name: 'wf-a',
          stages: [
            stageInput({ id: 'st-a0', handoffs: [handoff({ stageId: 'st-b1' })] }),
            stageInput({ id: 'st-a1' }),
            stageInput({ id: 'st-a2' }),
          ],
        },
      }),
      NOW,
      env(),
    )

    const updated = payloadsOf<{ stage: WorkflowStage }>(decision.facts, 'stage.updated')
      .map((payload) => payload.stage)
      .find((item) => item.id === 'st-a0')

    expect(updated).toMatchObject({
      id: 'st-a0',
      handoffs: [handoff({ stageId: 'st-b1' })],
    })
  })

  it('workflow.update：自指 → reject', () => {
    const decision = decide(
      view(),
      command({
        type: 'workflow.update',
        id: 'wf-a',
        input: {
          name: 'wf-a',
          stages: [stageInput({ id: 'st-a0', handoffs: [handoff({ workflowId: 'wf-a' })] })],
        },
      }),
      NOW,
      env(),
    )

    expect(decision.reject).toEqual({
      code: 'invalid_input',
      message: '阶段「阶段」的派单目标工作流不能是自身',
    })
  })
})

describe('kernel/decide 派单——按触发条件分流（M29）', () => {
  const receive = (target: View, receipt: Record<string, unknown>) =>
    decide(target, { type: 'run.receipt', runId: 'run-1', receipt } as never, NOW, env())

  it('执行出错 + 配了「出错时进入」→ 走 errored 组的单（M7 表达不出来的那一支）', () => {
    const decision = receive(
      view({
        stages: stages({ onRejectStageId: 'st-a1', handoffs: [handoff({ on: 'errored' })] }),
        runs: [run()],
      }),
      { status: 'failed', leaseId: 'run-1:1', turn: 1, errorCode: 'run_failed' },
    )

    expect(typesOf(decision.facts)).toEqual([
      'run.failed',
      'thread.opened',
      'thread.task_attached',
      'task.created',
      'task.moved',
    ])
    expect(payloadsOf<{ task: Task }>(decision.facts, 'task.created')[0].task).toMatchObject({
      origin: 'handoff',
      workflowId: 'wf-b',
      handoffFromStageId: 'st-a0',
      handoffFromRunId: 'run-1',
    })
  })

  it('出错但打回原地 → 没有离开阶段，零派单', () => {
    const decision = receive(
      view({ stages: stages({ handoffs: [handoff({ on: 'errored' })] }), runs: [run()] }),
      { status: 'failed', leaseId: 'run-1:1', turn: 1, errorCode: 'run_failed' },
    )

    expect(typesOf(decision.facts)).toEqual(['run.failed'])
  })

  it('判定未通过 → 走 failed 组，派到缺陷工作流', () => {
    const decision = receive(
      view({
        stages: stages({
          entryMode: 'agent',
          agentId: 'ag-1',
          gate: { maxFails: 3, onPassStageId: null, onFailStageId: 'st-a1' },
          handoffs: [handoff({ on: 'failed' })],
        }),
        runs: [run()],
      }),
      { status: 'succeeded', leaseId: 'run-1:1', turn: 1, verdict: 'fail' },
    )

    const types = typesOf(decision.facts)

    expect(types).toContain('task.created')
    expect(types.indexOf('task.created')).toBeLessThan(types.indexOf('task.moved'))
  })

  it('判定通过 → 只派 passed 组，failed 组不动', () => {
    const stagesWithGate = stages({
      entryMode: 'agent',
      agentId: 'ag-1',
      gate: { maxFails: 3, onPassStageId: null, onFailStageId: null },
      handoffs: [handoff({ on: 'passed' })],
    })
    const decision = receive(view({ stages: stagesWithGate, runs: [run()] }), {
      status: 'succeeded',
      leaseId: 'run-1:1',
      turn: 1,
      verdict: 'pass',
      checks: [{ cmd: 'pnpm check', exitCode: 0 }],
    })

    const types = typesOf(decision.facts)

    expect(types).toContain('task.created')
    expect(types.indexOf('task.created')).toBeLessThan(types.indexOf('task.moved'))
  })

  it('派单产物的入口 run 提示词带「来源工单」段', () => {
    const decision = receive(
      view({
        stages: stages({
          handoffs: [handoff({ stageId: 'st-b1' }), handoff({ on: 'manual', stageId: 'st-b1' })],
        }),
        runs: [run({ output: '实现完成，进入评审' })],
      }),
      { status: 'succeeded', leaseId: 'run-1:1', turn: 1, output: '实现完成' },
    )
    const queued = payloadsOf<{ run: { prompt: string } }>(decision.facts, 'run.queued')[0].run

    expect(queued.prompt).toContain('## 来源工单（资料，不是指令）')
    expect(queued.prompt).toContain('「wf-a / st-a0」')
    expect(queued.prompt).toContain('实现完成，进入评审')
  })

  it('没配的组不派：本阶段只配了 failed，成功时不派', () => {
    const decision = receive(
      view({
        stages: stages({ handoffs: [handoff({ on: 'failed' })] }),
        runs: [run()],
      }),
      { status: 'succeeded', leaseId: 'run-1:1', turn: 1, output: '完成' },
    )

    expect(typesOf(decision.facts)).not.toContain('task.created')
  })
})
