// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type {
  Agent,
  Conversation,
  Message,
  RunRow,
  Runtime,
  Task,
  Workflow,
  WorkflowStage,
} from '../../../src/protocol/entities'
import type { Command } from '../../../src/protocol/commands'
import type { FactPayload, FactType } from '../../../src/protocol/facts'
import type { Change, Environment, Fact, FactDraft, Id, View } from '../../../src/kernel/types'
import { PROJECTION_TABLES } from '../../../src/host/schema'
import { DEFAULT_LIMITS } from '../../../src/host/store/index'
import { createFakeKernel, defaultDecide, defaultProject } from './fake-kernel'
import { SAMPLE_AT, sample, sampleProbe } from './test-support'

interface Seed {
  workflows?: Workflow[]
  stages?: WorkflowStage[]
  agents?: Agent[]
  runtimes?: Runtime[]
  tasks?: Task[]
  runs?: RunRow[]
  conversations?: Conversation[]
  messages?: Message[]
  active?: Id[]
}

const view = (seed: Seed = {}): View => ({
  seq: 1,
  workflows: new Map((seed.workflows ?? []).map((row) => [row.id, row])),
  stages: new Map((seed.stages ?? []).map((row) => [row.id, row])),
  agents: new Map((seed.agents ?? []).map((row) => [row.id, row])),
  runtimes: new Map((seed.runtimes ?? []).map((row) => [row.id, row])),
  tasks: new Map((seed.tasks ?? []).map((row) => [row.id, row])),
  runs: new Map((seed.runs ?? []).map((row) => [row.id, row])),
  conversations: new Map((seed.conversations ?? []).map((row) => [row.id, row])),
  messages: new Map((seed.messages ?? []).map((row) => [row.id, row])),
  cards: new Map(),
  threads: new Map(),
  activeTaskIds: new Set(seed.active ?? []),
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

/** 确定性 id 生成器：每类实体独立计数，测试可断言具体 id。 */
const env = (): Environment => {
  const counters = new Map<string, number>()
  return {
    timezone: 'Asia/Shanghai',
    limits: DEFAULT_LIMITS,
    nextId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
  }
}

/** 命令字面量入口：幂等键统一由测试补；分布式 Omit 保留各命令的判别字段。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
const command = (base: DistributiveOmit<Command, 'commandId'>): Command =>
  ({ commandId: 'cmd-1', ...base }) as Command

const draft = <T extends FactType>(type: T, payload: FactPayload<T>): FactDraft<T> => ({
  type,
  actor: { kind: 'owner', via: 'ui' },
  at: SAMPLE_AT,
  payload,
})

/** 决策产物没有 seq（由 store 追加），投影用例需要带 seq 的完整事实。 */
const fact = <T extends FactType>(type: T, payload: FactPayload<T>): Fact<T> => ({
  seq: 1,
  ...draft(type, payload),
})

const rejected = (code: string, message: string) => ({ facts: [], reject: { code, message } })

const stagePayloads = (facts: readonly FactDraft[]): WorkflowStage[] =>
  facts
    .filter((item) => item.type === 'stage.created')
    .map((item) => (item.payload as { stage: WorkflowStage }).stage)

describe('defaultDecide：工作流', () => {
  it('workflow.create：阶段下标解析；null/undefined/越界都落到 null', () => {
    const decision = defaultDecide(
      view(),
      command({
        type: 'workflow.create',
        input: {
          name: '研发',
          description: 'd',
          stages: [
            { name: '待办', entryMode: 'none', onCompleteIndex: null, onRejectIndex: undefined },
            { name: '执行', entryMode: 'agent', agentId: 'ag-1', onCompleteIndex: 0 },
            { name: '审核', entryMode: 'user', onCompleteIndex: 99, onRejectIndex: 1 },
          ],
        },
      }),
      SAMPLE_AT,
      env(),
    )

    expect(decision.facts.map((item) => item.type)).toEqual([
      'workflow.created',
      'stage.created',
      'stage.created',
      'stage.created',
    ])
    expect(decision.facts[0]?.payload).toEqual({
      workflow: sample.workflow({
        id: 'workflow-1',
        name: '研发',
        description: 'd',
        createdAt: SAMPLE_AT,
      }),
    })
    const stages = stagePayloads(decision.facts)
    expect(stages.map((stage) => [stage.id, stage.position, stage.name, stage.agentId])).toEqual([
      ['stage-1', 0, '待办', null],
      ['stage-2', 1, '执行', 'ag-1'],
      ['stage-3', 2, '审核', null],
    ])
    expect(stages.map((stage) => [stage.onCompleteStageId, stage.onRejectStageId])).toEqual([
      [null, null],
      ['stage-1', null],
      [null, 'stage-2'],
    ])
  })

  it('workflow.remove：不存在 → not_found；还有任务 → conflict；正常 → 工作流与阶段 tombstone', () => {
    const workflow = sample.workflow()
    expect(
      defaultDecide(view(), command({ type: 'workflow.remove', id: 'wf-1' }), SAMPLE_AT, env()),
    ).toEqual(rejected('not_found', '工作流不存在: wf-1'))

    expect(
      defaultDecide(
        view({ workflows: [workflow], tasks: [sample.task()] }),
        command({ type: 'workflow.remove', id: 'wf-1' }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual(rejected('conflict', '工作流下还有任务'))

    const kept = sample.stage({ id: 'st-2', position: 1 })
    const decision = defaultDecide(
      view({ workflows: [workflow], stages: [sample.stage(), kept] }),
      command({ type: 'workflow.remove', id: 'wf-1' }),
      SAMPLE_AT,
      env(),
    )
    expect(decision.facts.map((item) => item.type)).toEqual([
      'workflow.removed',
      'stage.deleted',
      'stage.deleted',
    ])
    expect(decision.facts[0]?.payload).toEqual({ workflow })
    expect(decision.facts.slice(1).map((item) => item.payload)).toEqual([
      { stage: sample.stage() },
      { stage: kept },
    ])
  })
})

describe('defaultDecide：任务', () => {
  const workflow = sample.workflow()
  const first = sample.stage()
  const second = sample.stage({ id: 'st-2', position: 1 })

  it('task.create：工作流不存在 → not_found；起始阶段不属于 → invalid_input', () => {
    expect(
      defaultDecide(
        view(),
        command({ type: 'task.create', input: { title: 'T', workflowId: 'wf-1' } }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual(rejected('not_found', '工作流不存在: wf-1'))

    expect(
      defaultDecide(
        view({ workflows: [workflow], stages: [first] }),
        command({
          type: 'task.create',
          input: { title: 'T', workflowId: 'wf-1', stageId: 'st-404' },
        }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual(rejected('invalid_input', '起始阶段不属于该工作流'))
  })

  it('task.create：缺省落首阶段；没有阶段时 currentStageId 为 null', () => {
    const withStages = defaultDecide(
      view({ workflows: [workflow], stages: [first, second] }),
      command({ type: 'task.create', input: { title: 'T', workflowId: 'wf-1' } }),
      SAMPLE_AT,
      env(),
    )
    expect(withStages.facts.map((item) => item.type)).toEqual(['task.created'])
    expect((withStages.facts[0]?.payload as { task: Task }).task).toEqual(
      sample.task({
        id: 'task-1',
        title: 'T',
        description: '',
        createdAt: SAMPLE_AT,
        updatedAt: SAMPLE_AT,
      }),
    )

    const noStages = defaultDecide(
      view({ workflows: [workflow] }),
      command({ type: 'task.create', input: { title: 'T', workflowId: 'wf-1' } }),
      SAMPLE_AT,
      env(),
    )
    expect((noStages.facts[0]?.payload as { task: Task }).task.currentStageId).toBeNull()
  })

  it('task.move：任务不存在 / 目标阶段不属于 / 执行中 三种拒绝', () => {
    expect(
      defaultDecide(
        view({ workflows: [workflow], stages: [first] }),
        command({ type: 'task.move', id: 'tk-1', stageId: 'st-1' }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual(rejected('not_found', '任务不存在: tk-1'))

    expect(
      defaultDecide(
        view({ workflows: [workflow], stages: [first], tasks: [sample.task()] }),
        command({ type: 'task.move', id: 'tk-1', stageId: 'st-404' }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual(rejected('invalid_input', '目标阶段不属于该任务的工作流'))

    const otherWorkflowStage = sample.stage({ id: 'st-9', workflowId: 'wf-2' })
    expect(
      defaultDecide(
        view({
          workflows: [workflow],
          stages: [first, otherWorkflowStage],
          tasks: [sample.task()],
        }),
        command({ type: 'task.move', id: 'tk-1', stageId: 'st-9' }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual(rejected('invalid_input', '目标阶段不属于该任务的工作流'))

    expect(
      defaultDecide(
        view({
          workflows: [workflow],
          stages: [first, second],
          tasks: [sample.task()],
          active: ['tk-1'],
        }),
        command({ type: 'task.move', id: 'tk-1', stageId: 'st-2' }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual(rejected('forbidden', '任务执行中，不能移动'))
  })

  it('task.move 正常：事实带 from/to 与移动后的行', () => {
    const decision = defaultDecide(
      view({ workflows: [workflow], stages: [first, second], tasks: [sample.task()] }),
      command({ type: 'task.move', id: 'tk-1', stageId: 'st-2' }),
      SAMPLE_AT,
      env(),
    )

    expect(decision.facts).toEqual([
      draft('task.moved', {
        task: { ...sample.task(), currentStageId: 'st-2', updatedAt: SAMPLE_AT },
        from: 'st-1',
        to: 'st-2',
      }),
    ])
  })

  it('task.remove：不存在 → not_found；正常 → tombstone', () => {
    expect(
      defaultDecide(view(), command({ type: 'task.remove', id: 'tk-1' }), SAMPLE_AT, env()),
    ).toEqual(rejected('not_found', '任务不存在: tk-1'))

    expect(
      defaultDecide(
        view({ tasks: [sample.task()] }),
        command({ type: 'task.remove', id: 'tk-1' }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual({ facts: [draft('task.removed', { task: sample.task() })] })
  })
})

describe('defaultDecide：运行时与智能体', () => {
  it('runtime.create：缺省值回填；显式字段透传', () => {
    const defaults = defaultDecide(
      view(),
      command({ type: 'runtime.create', input: { name: '本机' } }),
      SAMPLE_AT,
      env(),
    )
    expect(defaults.facts).toEqual([
      draft('runtime.created', { runtime: sample.runtime({ id: 'runtime-1', name: '本机' }) }),
    ])

    const explicit = defaultDecide(
      view(),
      command({
        type: 'runtime.create',
        input: {
          name: 'fast',
          command: 'dsh2',
          profile: 'p',
          permissionMode: 'danger-full-access',
          model: 'm',
          reasoningEffort: 'high',
          workdir: 'C:/w',
          maxConcurrent: 4,
          enabled: false,
        },
      }),
      SAMPLE_AT,
      env(),
    )
    expect(explicit.facts[0]?.payload).toEqual({
      runtime: sample.runtime({
        id: 'runtime-1',
        name: 'fast',
        command: 'dsh2',
        profile: 'p',
        permissionMode: 'danger-full-access',
        model: 'm',
        reasoningEffort: 'high',
        workdir: 'C:/w',
        maxConcurrent: 4,
        enabled: false,
      }),
    })
  })

  it('runtime.probed：不存在 → not_found；正常 → 行内 lastProbe 更新', () => {
    expect(
      defaultDecide(
        view(),
        command({ type: 'runtime.probed', id: 'rt-1', probe: sampleProbe }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual(rejected('not_found', '运行时不存在: rt-1'))

    expect(
      defaultDecide(
        view({ runtimes: [sample.runtime()] }),
        command({ type: 'runtime.probed', id: 'rt-1', probe: sampleProbe }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual({
      facts: [draft('runtime.probed', { runtime: sample.runtime({ lastProbe: sampleProbe }) })],
    })
  })

  it('agent.create：运行时不存在 → not_found；正常 → 行与输入一致', () => {
    expect(
      defaultDecide(
        view(),
        command({ type: 'agent.create', input: { name: 'coder', runtimeId: 'rt-404' } }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual(rejected('not_found', '运行时不存在: rt-404'))

    expect(
      defaultDecide(
        view({ runtimes: [sample.runtime()] }),
        command({
          type: 'agent.create',
          input: { name: 'coder', description: 'd', runtimeId: 'rt-1', systemPrompt: 'sys' },
        }),
        SAMPLE_AT,
        env(),
      ),
    ).toEqual({
      facts: [
        draft('agent.created', {
          agent: sample.agent({
            id: 'agent-1',
            name: 'coder',
            description: 'd',
            systemPrompt: 'sys',
            createdAt: SAMPLE_AT,
          }),
        }),
      ],
    })
  })

  it('未覆盖的命令：reject unsupported', () => {
    expect(
      defaultDecide(view(), command({ type: 'task.complete', id: 'tk-1' }), SAMPLE_AT, env()),
    ).toEqual(rejected('unsupported', '假内核未覆盖命令: task.complete'))
    expect(
      defaultDecide(view(), command({ type: 'agent.remove', id: 'ag-1' }), SAMPLE_AT, env()),
    ).toEqual(rejected('unsupported', '假内核未覆盖命令: agent.remove'))
  })
})

describe('defaultProject：事实 → 投影变更', () => {
  const workflow = sample.workflow()
  const stage = sample.stage()
  const agent = sample.agent()
  const runtime = sample.runtime()
  const task = sample.task()

  const cases: Array<[FactType, FactPayload<FactType>, Change[]]> = [
    ['workflow.created', { workflow }, [{ table: 'workflows', key: 'wf-1', row: workflow }]],
    ['workflow.updated', { workflow }, [{ table: 'workflows', key: 'wf-1', row: workflow }]],
    ['workflow.removed', { workflow }, [{ table: 'workflows', key: 'wf-1', row: null }]],
    ['stage.created', { stage }, [{ table: 'workflow_stages', key: 'st-1', row: stage }]],
    ['stage.updated', { stage }, [{ table: 'workflow_stages', key: 'st-1', row: stage }]],
    ['stage.deleted', { stage }, [{ table: 'workflow_stages', key: 'st-1', row: null }]],
    ['agent.created', { agent }, [{ table: 'agents', key: 'ag-1', row: agent }]],
    ['agent.updated', { agent }, [{ table: 'agents', key: 'ag-1', row: agent }]],
    ['agent.removed', { agent }, [{ table: 'agents', key: 'ag-1', row: null }]],
    ['runtime.created', { runtime }, [{ table: 'runtimes', key: 'rt-1', row: runtime }]],
    ['runtime.updated', { runtime }, [{ table: 'runtimes', key: 'rt-1', row: runtime }]],
    ['runtime.probed', { runtime }, [{ table: 'runtimes', key: 'rt-1', row: runtime }]],
    ['runtime.removed', { runtime }, [{ table: 'runtimes', key: 'rt-1', row: null }]],
    ['task.created', { task }, [{ table: 'tasks', key: 'tk-1', row: task }]],
    [
      'task.moved',
      { task, from: 'st-1', to: 'st-1' },
      [{ table: 'tasks', key: 'tk-1', row: task }],
    ],
    ['task.completed', { task }, [{ table: 'tasks', key: 'tk-1', row: task }]],
    ['task.removed', { task }, [{ table: 'tasks', key: 'tk-1', row: null }]],
  ]

  it.each(cases)('%s', (type, payload, expected) => {
    expect(defaultProject(fact(type, payload) as Fact)).toEqual(expected)
  })

  it('未覆盖的事实类型：没有任何投影变更', () => {
    expect(
      defaultProject(
        fact('snapshot.imported', {
          table: 'tasks',
          rows: [task],
          importedFrom: 'v2',
        }),
      ),
    ).toEqual([])
  })
})

describe('createFakeKernel', () => {
  it('默认实现可用，并记录 decide 视图 / viewSpec 输入 / project 事实', () => {
    const kernel = createFakeKernel()
    const input = command({
      type: 'workflow.create',
      input: { name: 'w', stages: [{ name: 's', entryMode: 'none' }] },
    })
    const seeded = view()

    const decision = kernel.decide(seeded, input, SAMPLE_AT, env())

    expect(decision.facts.map((item) => item.type)).toEqual(['workflow.created', 'stage.created'])
    expect(kernel.views).toEqual([seeded])
    expect(kernel.viewSpec(input)).toEqual([...PROJECTION_TABLES])
    expect(kernel.viewSpecInputs).toEqual([input])
    for (const [index, item] of decision.facts.entries())
      kernel.project({ ...item, seq: index + 1 })
    expect(kernel.projected.map((item) => item.type)).toEqual(
      decision.facts.map((item) => item.type),
    )
  })

  it('可整体替换 decide / project / viewSpec，记录数组仍然生效', () => {
    const replacement = command({ type: 'task.remove', id: 'tk-1' })
    const seeded = view()
    const kernel = createFakeKernel({
      decide: () => ({ facts: [], reject: { code: 'forbidden', message: '拒绝' } }),
      project: () => [],
      viewSpec: () => ['tasks'],
    })

    expect(kernel.decide(seeded, replacement, SAMPLE_AT, env())).toEqual(
      rejected('forbidden', '拒绝'),
    )
    expect(kernel.views).toEqual([seeded])
    expect(kernel.viewSpec(replacement)).toEqual(['tasks'])
    expect(kernel.project(fact('task.removed', { task: sample.task() }))).toEqual([])
    expect(kernel.projected).toHaveLength(1)
  })
})
