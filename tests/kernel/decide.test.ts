import { describe, expect, it } from 'vitest'
import type { Command } from '../../src/protocol/commands'
import type { Input } from '../../src/protocol/inputs'
import type {
  Agent,
  RunRow,
  Runtime,
  RuntimeProbe,
  StageInput,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import type { FactPayload, FactType } from '../../src/protocol/facts'
import type { HostInput } from '../../src/protocol/inputs'
import { decide } from '../../src/kernel/decide'
import { taskPrompt } from '../../src/kernel/prompt'
import type { Environment, FactDraft, Id, IdKind, Limits, View } from '../../src/kernel/types'

const CREATED = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-02T00:00:00.000Z'
const NOW = '2026-11-04T12:00:00.000Z'
const ACTOR = { kind: 'owner', via: 'ui' } as const

const workflow = (over: Partial<Workflow> = {}): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: '',
  createdAt: CREATED,
  ...over,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-1',
  workflowId: 'wf-1',
  name: '待办',
  position: 0,
  entryMode: 'none',
  agentId: null,
  onCompleteStageId: null,
  onRejectStageId: null,
  ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: 'sys',
  createdAt: CREATED,
  ...over,
})

const probe: RuntimeProbe = {
  state: 'ready',
  path: 'C:/bin/dsh.cmd',
  cliVersion: '1.0.0',
  protocolVersion: 1,
  pluginVersion: null,
  error: null,
  output: '',
  elapsedMs: 5,
  checkedAt: NOW,
}

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: 'dsh',
  profile: 'multica',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 't-1',
  title: '任务',
  description: '',
  workflowId: 'wf-1',
  currentStageId: 'st-1',
  status: 'active',
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

/** 领取中的 run 行（回执链条用例的种子）。 */
const runRow = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  conversationId: null,
  stageId: 'st-1',
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
  prompt: 'p',
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
  leaseUntil: LATER,
  notBefore: null,
  deadlineAt: LATER,
  cancelRequested: false,
  startedAt: NOW,
  endedAt: null,
  createdAt: CREATED,
  ...over,
})

const at = <T extends FactType>(type: T, payload: FactPayload<T>): FactDraft<T> => ({
  type,
  actor: ACTOR,
  at: NOW,
  payload,
})

interface Seed {
  workflows?: Workflow[]
  stages?: WorkflowStage[]
  agents?: Agent[]
  runtimes?: Runtime[]
  tasks?: Task[]
  runs?: RunRow[]
  active?: Id[]
}

const view = (seed: Seed = {}): View => ({
  seq: 7,
  workflows: new Map((seed.workflows ?? []).map((row) => [row.id, row])),
  stages: new Map((seed.stages ?? []).map((row) => [row.id, row])),
  agents: new Map((seed.agents ?? []).map((row) => [row.id, row])),
  runtimes: new Map((seed.runtimes ?? []).map((row) => [row.id, row])),
  tasks: new Map((seed.tasks ?? []).map((row) => [row.id, row])),
  runs: new Map((seed.runs ?? []).map((row) => [row.id, row])),
  conversations: new Map(),
  messages: new Map(),
  activeTaskIds: new Set(seed.active ?? []),
})

/** 与 `host/store/index` 的 `DEFAULT_LIMITS` 同值；内核单测不 import 宿主实现。 */
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

/** 确定性 id 生成器：每类实体独立计数，测试可断言具体 id。 */
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

/** 命令字面量入口：幂等键统一由测试补，各分支按 `type` 保留完整字段。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type CommandDraft = DistributiveOmit<Command, 'commandId'>
const command = (base: CommandDraft): Command => ({ commandId: 'cmd-1', ...base }) as Command
/** 宿主内部输入字面量入口（回执 / 帧 / 领取等，不经 IPC）。 */
const host = (input: HostInput): Input => input

describe('kernel/decide 运行时', () => {
  it('runtime.create：契约要求执行器键与命令已确定，事实携带完整行（含 lastProbe: null）', () => {
    expect(
      decide(
        view(),
        command({
          type: 'runtime.create',
          input: { name: ' 本机 ', executorKey: 'dsh', command: ' dsh ' },
        }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('runtime.created', {
          runtime: runtime({
            id: 'runtime-new-1',
            name: '本机',
            profile: '',
            createdAt: NOW,
          }),
        }),
      ],
    })
  })

  it('runtime.create：字段透传、并发上限封顶 8、enabled 显式为 false 才关', () => {
    const decision = decide(
      view(),
      command({
        type: 'runtime.create',
        input: {
          name: 'fast',
          executorKey: 'dsh',
          command: ' dsh2 ',
          profile: ' p2 ',
          argsTemplate: '["--print"]',
          permissionMode: 'danger-full-access',
          model: 'm',
          reasoningEffort: 'high',
          workdir: 'C:/w',
          maxConcurrent: 99,
          enabled: false,
        },
      }),
      NOW,
      env(),
    )

    expect(decision).toEqual({
      facts: [
        at('runtime.created', {
          runtime: runtime({
            id: 'runtime-new-1',
            name: 'fast',
            argsTemplate: '["--print"]',
            command: 'dsh2',
            profile: 'p2',
            permissionMode: 'danger-full-access',
            model: 'm',
            reasoningEffort: 'high',
            workdir: 'C:/w',
            maxConcurrent: 8,
            enabled: false,
            createdAt: NOW,
          }),
        }),
      ],
    })
  })

  it('runtime.create：非法输入 reject，不抛', () => {
    const run = (input: Record<string, unknown>): unknown =>
      decide(
        view({ runtimes: [runtime()] }),
        command({
          type: 'runtime.create',
          input: { executorKey: 'dsh', command: 'dsh', ...input } as unknown as { name: string },
        }),
        NOW,
        env(),
      )

    expect(run({ name: '  ' })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '运行时名称必填' },
    })
    expect(run({ name: 'x', executorKey: '  ' })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '运行时缺少执行器键（executorKey）' },
    })
    expect(run({ name: 'x', command: '  ' })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '运行时缺少启动命令（command）' },
    })
    expect(run({ name: 'x', permissionMode: 'root' })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '不支持的权限模式: root' },
    })
    expect(run({ name: 'x', maxConcurrent: 0 })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '并发上限必须是正整数' },
    })
    expect(run({ name: 'x', maxConcurrent: 1.5 })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '并发上限必须是正整数' },
    })
    expect(run({ name: '本机 dsh' })).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '运行时名称已存在: 本机 dsh' },
    })
  })

  it('runtime.update：保留 createdAt 与 lastProbe，按 patch 覆盖', () => {
    const decision = decide(
      view({ runtimes: [runtime({ lastProbe: probe })] }),
      command({
        type: 'runtime.update',
        id: 'rt-1',
        patch: {
          name: ' 改名 ',
          executorKey: 'dsh',
          argsTemplate: '',
          permissionMode: 'read-only',
          command: ' dsh2 ',
          maxConcurrent: 3,
          model: null,
          reasoningEffort: 'low',
          workdir: 'C:/w2',
          enabled: false,
        },
      }),
      NOW,
      env(),
    )

    expect(decision).toEqual({
      facts: [
        at('runtime.updated', {
          runtime: runtime({
            name: '改名',
            command: 'dsh2',
            permissionMode: 'read-only',
            maxConcurrent: 3,
            reasoningEffort: 'low',
            workdir: 'C:/w2',
            enabled: false,
            lastProbe: probe,
          }),
        }),
      ],
    })
  })

  it('runtime.update：空名字/未给字段沿用旧值；改名撞名 reject', () => {
    const seeded = view({ runtimes: [runtime(), runtime({ id: 'rt-2', name: '另一个' })] })

    expect(
      decide(seeded, command({ type: 'runtime.update', id: 'rt-1', patch: {} }), NOW, env()),
    ).toEqual({ facts: [at('runtime.updated', { runtime: runtime() })] })

    expect(
      decide(
        seeded,
        command({ type: 'runtime.update', id: 'rt-1', patch: { name: '   ' } }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [at('runtime.updated', { runtime: runtime() })] })

    expect(
      decide(
        seeded,
        command({ type: 'runtime.update', id: 'rt-1', patch: { name: '另一个' } }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [], reject: { code: 'conflict', message: '运行时名称已存在: 另一个' } })
  })

  it('runtime.update：目标不存在与枚举/并发非法都 reject', () => {
    const seeded = view({ runtimes: [runtime()] })
    const run = (patch: Record<string, unknown>, id = 'rt-1'): unknown =>
      decide(seeded, command({ type: 'runtime.update', id, patch: patch as never }), NOW, env())

    expect(run({})).not.toHaveProperty('reject')
    expect(run({}, 'rt-404')).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '运行时不存在: rt-404' },
    })
    expect(run({ executorKey: '  ' })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '运行时缺少执行器键（executorKey）' },
    })
    expect(run({ permissionMode: 'root' })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '不支持的权限模式: root' },
    })
    expect(run({ maxConcurrent: 0 })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '并发上限必须是正整数' },
    })
  })

  it('runtime.probed：写入完整行，lastProbe 是行的一部分', () => {
    expect(
      decide(
        view({ runtimes: [runtime()] }),
        command({ type: 'runtime.probed', id: 'rt-1', probe }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [at('runtime.probed', { runtime: runtime({ lastProbe: probe }) })] })

    expect(
      decide(view(), command({ type: 'runtime.probed', id: 'rt-404', probe }), NOW, env()),
    ).toEqual({ facts: [], reject: { code: 'not_found', message: '运行时不存在: rt-404' } })
  })

  it('runtime.remove：被智能体引用时拒绝；存在则 tombstone；不存在静默', () => {
    expect(
      decide(
        view({ runtimes: [runtime()], agents: [agent()] }),
        command({ type: 'runtime.remove', id: 'rt-1' }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '运行时被智能体引用，无法删除: rt-1' },
    })

    expect(
      decide(
        view({ runtimes: [runtime()] }),
        command({ type: 'runtime.remove', id: 'rt-1' }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [at('runtime.removed', { runtime: runtime() })] })

    expect(decide(view(), command({ type: 'runtime.remove', id: 'rt-404' }), NOW, env())).toEqual({
      facts: [],
    })
  })
})

describe('kernel/decide 智能体', () => {
  it('agent.create：默认描述/提示词为空、事实为完整行', () => {
    expect(
      decide(
        view({ runtimes: [runtime()] }),
        command({ type: 'agent.create', input: { name: ' 实现者 ', runtimeId: 'rt-1' } }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('agent.created', {
          agent: agent({ id: 'agent-new-1', name: '实现者', systemPrompt: '', createdAt: NOW }),
        }),
      ],
    })

    expect(
      decide(
        view({ runtimes: [runtime()] }),
        command({
          type: 'agent.create',
          input: {
            name: '实现者',
            description: '负责实现',
            runtimeId: 'rt-1',
            systemPrompt: '提示词',
          },
        }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('agent.created', {
          agent: agent({
            id: 'agent-new-1',
            name: '实现者',
            description: '负责实现',
            systemPrompt: '提示词',
            createdAt: NOW,
          }),
        }),
      ],
    })
  })

  it('agent.create：名称必填、运行时必须存在', () => {
    const run = (input: Record<string, unknown>): unknown =>
      decide(
        view({ runtimes: [runtime()] }),
        command({ type: 'agent.create', input: input as { name: string; runtimeId: string } }),
        NOW,
        env(),
      )

    expect(run({ name: '', runtimeId: 'rt-1' })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '智能体名称必填' },
    })
    expect(run({ name: 'a', runtimeId: 'rt-404' })).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '运行时不存在: rt-404' },
    })
  })

  it('agent.update：patch 局部覆盖；未给 runtimeId 不校验', () => {
    const seeded = view({ agents: [agent()], runtimes: [runtime()] })

    expect(
      decide(
        seeded,
        command({
          type: 'agent.update',
          id: 'ag-1',
          patch: { name: ' 新名字 ', description: 'd2' },
        }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('agent.updated', {
          agent: agent({ name: '新名字', description: 'd2' }),
        }),
      ],
    })

    expect(
      decide(
        seeded,
        command({ type: 'agent.update', id: 'ag-1', patch: { runtimeId: '' as never } }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [at('agent.updated', { agent: agent() })] })
  })

  it('agent.update：目标不存在 / 运行时不存在都 reject', () => {
    const seeded = view({ agents: [agent()], runtimes: [runtime()] })

    expect(
      decide(seeded, command({ type: 'agent.update', id: 'ag-404', patch: {} }), NOW, env()),
    ).toEqual({ facts: [], reject: { code: 'not_found', message: '智能体不存在: ag-404' } })

    expect(
      decide(
        seeded,
        command({ type: 'agent.update', id: 'ag-1', patch: { runtimeId: 'rt-404' } }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [], reject: { code: 'not_found', message: '运行时不存在: rt-404' } })
  })

  it('agent.remove：被阶段引用时拒绝；存在则 tombstone；不存在静默', () => {
    expect(
      decide(
        view({ agents: [agent()], stages: [stage({ agentId: 'ag-1', entryMode: 'agent' })] }),
        command({ type: 'agent.remove', id: 'ag-1' }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '智能体被工作流阶段或对话引用，无法删除: ag-1' },
    })

    expect(
      decide(
        view({ agents: [agent()] }),
        command({ type: 'agent.remove', id: 'ag-1' }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [at('agent.removed', { agent: agent() })] })

    expect(decide(view(), command({ type: 'agent.remove', id: 'ag-404' }), NOW, env())).toEqual({
      facts: [],
    })
  })
})

describe('kernel/decide 工作流', () => {
  it('workflow.create：阶段 id 稳定生成、下标目标解析、三种 entry_mode 全覆盖', () => {
    expect(
      decide(
        view({ agents: [agent()] }),
        command({
          type: 'workflow.create',
          input: {
            name: ' 研发 ',
            description: '描述',
            stages: [
              { name: ' 待办 ', entryMode: 'none' },
              { name: '实现', entryMode: 'agent', agentId: 'ag-1', onCompleteIndex: 2 },
              { name: '验收', entryMode: 'user', onRejectIndex: 0 },
            ],
          },
        }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('workflow.created', {
          workflow: workflow({
            id: 'workflow-new-1',
            name: '研发',
            description: '描述',
            createdAt: NOW,
          }),
        }),
        at('stage.created', {
          stage: stage({
            id: 'stage-new-1',
            workflowId: 'workflow-new-1',
            name: '待办',
            position: 0,
          }),
        }),
        at('stage.created', {
          stage: stage({
            id: 'stage-new-2',
            workflowId: 'workflow-new-1',
            name: '实现',
            position: 1,
            entryMode: 'agent',
            agentId: 'ag-1',
            onCompleteStageId: 'stage-new-3',
          }),
        }),
        at('stage.created', {
          stage: stage({
            id: 'stage-new-3',
            workflowId: 'workflow-new-1',
            name: '验收',
            position: 2,
            entryMode: 'user',
            onRejectStageId: 'stage-new-1',
          }),
        }),
      ],
    })
  })

  it('workflow.create：名称必填、阶段集合校验、智能体必须存在', () => {
    const run = (input: Record<string, unknown>): unknown =>
      decide(
        view({ agents: [agent()] }),
        command({ type: 'workflow.create', input: input as never }),
        NOW,
        env(),
      )

    expect(run({ name: '', stages: [{ name: 'a', entryMode: 'none' }] })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '工作流名称必填' },
    })
    expect(run({ name: 'w', stages: [] })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '工作流至少需要一个阶段' },
    })
    expect(run({ name: 'w', stages: [{ name: 's', entryMode: 'agent' }] })).toEqual({
      facts: [],
      reject: {
        code: 'invalid_input',
        message: '阶段「s」设为交给智能体时必须选择智能体',
      },
    })
    expect(
      run({ name: 'w', stages: [{ name: 's', entryMode: 'agent', agentId: 'ag-404' }] }),
    ).toEqual({ facts: [], reject: { code: 'not_found', message: '智能体不存在: ag-404' } })
  })

  it('workflow.update：按 id 差量——保留 id 更新、新阶段新 id、缺失旧阶段 tombstone、任务按 position 重挂', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [
        stage({ id: 'st-1', position: 0, name: '待办' }),
        stage({ id: 'st-2', position: 1, name: '实现', entryMode: 'agent', agentId: 'ag-1' }),
      ],
      agents: [agent()],
      tasks: [
        task({ id: 't-1', currentStageId: 'st-1' }),
        task({ id: 't-2', currentStageId: 'st-2', createdAt: LATER }),
        task({ id: 't-3', currentStageId: null }),
      ],
    })

    expect(
      decide(
        seeded,
        command({
          type: 'workflow.update',
          id: 'wf-1',
          input: {
            name: '研发v2',
            stages: [
              { id: 'st-2', name: '实现', entryMode: 'agent', agentId: 'ag-1', onRejectIndex: 1 },
              { name: '验收', entryMode: 'user', onRejectIndex: 0 },
            ],
          },
        }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('workflow.updated', {
          workflow: workflow({ name: '研发v2' }),
        }),
        at('stage.deleted', { stage: stage({ id: 'st-1', position: 0, name: '待办' }) }),
        at('stage.updated', {
          stage: stage({
            id: 'st-2',
            position: 0,
            name: '实现',
            entryMode: 'agent',
            agentId: 'ag-1',
            onRejectStageId: 'stage-new-1',
          }),
        }),
        at('stage.created', {
          stage: stage({
            id: 'stage-new-1',
            position: 1,
            name: '验收',
            entryMode: 'user',
            onRejectStageId: 'st-2',
          }),
        }),
        at('task.moved', {
          task: task({ id: 't-1', currentStageId: 'st-2' }),
          from: 'st-1',
          to: 'st-2',
        }),
      ],
    })
  })

  it('workflow.update：无 id 的提交等价整表重建，任务按旧 position 回挂', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1', position: 0 }), stage({ id: 'st-2', position: 1 })],
      tasks: [
        task({ id: 't-1', currentStageId: 'st-1' }),
        task({ id: 't-2', currentStageId: 'st-2', createdAt: LATER }),
      ],
    })

    expect(
      decide(
        seeded,
        command({
          type: 'workflow.update',
          id: 'wf-1',
          input: {
            name: '研发',
            stages: [
              { name: 'A', entryMode: 'none' },
              { name: 'B', entryMode: 'none' },
            ],
          },
        }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('workflow.updated', { workflow: workflow() }),
        at('stage.deleted', { stage: stage({ id: 'st-1', position: 0 }) }),
        at('stage.deleted', { stage: stage({ id: 'st-2', position: 1 }) }),
        at('stage.created', {
          stage: stage({ id: 'stage-new-1', name: 'A', position: 0 }),
        }),
        at('stage.created', {
          stage: stage({ id: 'stage-new-2', name: 'B', position: 1 }),
        }),
        at('task.moved', {
          task: task({ id: 't-1', currentStageId: 'stage-new-1' }),
          from: 'st-1',
          to: 'stage-new-1',
        }),
        at('task.moved', {
          task: task({ id: 't-2', currentStageId: 'stage-new-2', createdAt: LATER }),
          from: 'st-2',
          to: 'stage-new-2',
        }),
      ],
    })
  })

  it('workflow.update：阶段集合与名称未变时只发 workflow.updated（阶段不重建）', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1', position: 0, name: '待办' })],
    })

    expect(
      decide(
        seeded,
        command({
          type: 'workflow.update',
          id: 'wf-1',
          input: { name: '研发', stages: [{ id: 'st-1', name: '待办', entryMode: 'none' }] },
        }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [at('workflow.updated', { workflow: workflow() })] })
  })

  it('workflow.update：非法输入与守卫（名称/阶段/存在性/活跃 run/智能体/阶段 id）', () => {
    const seed: Seed = {
      workflows: [workflow()],
      stages: [stage({ id: 'st-1' })],
      agents: [agent()],
      tasks: [task({ id: 't-1' })],
    }
    const seeded = view(seed)
    const validStages: StageInput[] = [{ id: 'st-1', name: '待办', entryMode: 'none' }]
    const run = (over: Record<string, unknown>, target = seeded): unknown =>
      decide(
        target,
        command({
          type: 'workflow.update',
          id: 'wf-1',
          input: { name: '研发', stages: validStages, ...over },
        }),
        NOW,
        env(),
      )

    expect(run({ name: '' })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '工作流名称必填' },
    })
    expect(run({ stages: [] })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '工作流至少需要一个阶段' },
    })
    expect(
      decide(
        view({ workflows: [], stages: [stage()] }),
        command({
          type: 'workflow.update',
          id: 'wf-404',
          input: { name: 'x', stages: [{ name: 'a', entryMode: 'none' }] },
        }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [], reject: { code: 'not_found', message: '工作流不存在: wf-404' } })
    expect(run({}, view({ ...seed, active: ['t-1'] }))).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '工作流有执行中的任务，无法修改阶段: wf-1' },
    })
    expect(
      decide(
        seeded,
        command({
          type: 'workflow.update',
          id: 'wf-1',
          input: { name: 'x', stages: [{ name: 'a', entryMode: 'agent', agentId: 'ag-404' }] },
        }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [], reject: { code: 'not_found', message: '智能体不存在: ag-404' } })
    expect(
      run({
        stages: [
          { id: 'st-1', name: 'a', entryMode: 'none' },
          { id: 'st-1', name: 'b', entryMode: 'none' },
        ],
      }),
    ).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '阶段 id 重复: st-1' },
    })
    expect(run({ stages: [{ id: 'st-404', name: 'a', entryMode: 'none' }] })).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '阶段 id 不存在: st-404' },
    })
  })

  it('workflow.remove：级联发 stage/task tombstone（不依赖 SQL 级联）', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1', position: 0 }), stage({ id: 'st-2', position: 1 })],
      tasks: [
        task({ id: 't-1', currentStageId: 'st-2', createdAt: LATER }),
        task({ id: 't-2', currentStageId: 'st-1' }),
      ],
    })

    expect(decide(seeded, command({ type: 'workflow.remove', id: 'wf-1' }), NOW, env())).toEqual({
      facts: [
        at('workflow.removed', { workflow: workflow() }),
        at('stage.deleted', { stage: stage({ id: 'st-1', position: 0 }) }),
        at('stage.deleted', { stage: stage({ id: 'st-2', position: 1 }) }),
        at('task.removed', { task: task({ id: 't-2', currentStageId: 'st-1' }) }),
        at('task.removed', {
          task: task({ id: 't-1', currentStageId: 'st-2', createdAt: LATER }),
        }),
      ],
    })

    expect(decide(view(), command({ type: 'workflow.remove', id: 'wf-404' }), NOW, env())).toEqual({
      facts: [],
    })
  })
})

describe('kernel/decide 任务', () => {
  it('task.create：默认进首阶段（按 position），空 stageId 走缺省', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-2', position: 1 }), stage({ id: 'st-1', position: 0 })],
    })

    expect(
      decide(
        seeded,
        command({ type: 'task.create', input: { title: ' 写计划 ', workflowId: 'wf-1' } }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('task.created', {
          task: task({
            id: 'task-new-1',
            title: '写计划',
            currentStageId: 'st-1',
            createdAt: NOW,
            updatedAt: NOW,
          }),
        }),
      ],
    })

    expect(
      decide(
        seeded,
        command({
          type: 'task.create',
          input: { title: 't', workflowId: 'wf-1', stageId: 'st-2' },
        }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('task.created', {
          task: task({
            id: 'task-new-1',
            title: 't',
            description: '',
            currentStageId: 'st-2',
            createdAt: NOW,
            updatedAt: NOW,
          }),
        }),
      ],
    })

    expect(
      decide(
        seeded,
        command({ type: 'task.create', input: { title: 't', workflowId: 'wf-1', stageId: '' } }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('task.created', {
          task: task({
            id: 'task-new-1',
            title: 't',
            currentStageId: 'st-1',
            createdAt: NOW,
            updatedAt: NOW,
          }),
        }),
      ],
    })
  })

  it('task.create：工作流没有任何阶段时 currentStageId 落 null', () => {
    expect(
      decide(
        view({ workflows: [workflow()] }),
        command({ type: 'task.create', input: { title: 't', workflowId: 'wf-1' } }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('task.created', {
          task: task({
            id: 'task-new-1',
            title: 't',
            currentStageId: null,
            createdAt: NOW,
            updatedAt: NOW,
          }),
        }),
      ],
    })
  })

  it('task.create：标题必填、工作流必须存在、起始阶段必须属于该工作流', () => {
    const seeded = view({
      workflows: [workflow(), workflow({ id: 'wf-2' })],
      stages: [stage({ id: 'st-1' }), stage({ id: 'st-9', workflowId: 'wf-2' })],
    })
    const run = (input: Record<string, unknown>): unknown =>
      decide(seeded, command({ type: 'task.create', input: input as never }), NOW, env())

    expect(run({ title: ' ', workflowId: 'wf-1' })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '任务标题必填' },
    })
    expect(run({ title: 't', workflowId: 'wf-404' })).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '工作流不存在: wf-404' },
    })
    expect(run({ title: 't', workflowId: 'wf-1', stageId: 'st-9' })).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '起始阶段不属于该工作流: st-9' },
    })
  })

  it('task.move：落点即目标，from/to 进事实，updatedAt 刷新', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [
        stage({ id: 'st-1', position: 0 }),
        stage({ id: 'st-2', position: 1, entryMode: 'agent', agentId: 'ag-1' }),
      ],
      agents: [agent()],
      tasks: [task({ id: 't-1' })],
    })

    expect(
      decide(seeded, command({ type: 'task.move', id: 't-1', stageId: 'st-2' }), NOW, env()),
    ).toEqual({
      facts: [
        at('task.moved', {
          task: task({ id: 't-1', currentStageId: 'st-2', updatedAt: NOW }),
          from: 'st-1',
          to: 'st-2',
        }),
      ],
    })
  })

  it('task.move：拖到当前阶段原地零效果（单条事实 from=to，不产其它事实）', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1' })],
      tasks: [task({ id: 't-1' })],
    })

    expect(
      decide(seeded, command({ type: 'task.move', id: 't-1', stageId: 'st-1' }), NOW, env()),
    ).toEqual({
      facts: [
        at('task.moved', {
          task: task({ id: 't-1', updatedAt: NOW }),
          from: 'st-1',
          to: 'st-1',
        }),
      ],
    })
  })

  it('task.move：已完成任务不再改阶段，但仍刷新 updatedAt', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1', position: 0 }), stage({ id: 'st-2', position: 1 })],
      tasks: [task({ id: 't-1', status: 'completed' })],
    })

    expect(
      decide(seeded, command({ type: 'task.move', id: 't-1', stageId: 'st-2' }), NOW, env()),
    ).toEqual({
      facts: [
        at('task.moved', {
          task: task({ id: 't-1', status: 'completed', updatedAt: NOW }),
          from: 'st-1',
          to: 'st-1',
        }),
      ],
    })
  })

  it('task.move：任务/工作流不存在、当前阶段无效、执行中、目标阶段无效都 reject', () => {
    const other = stage({ id: 'st-9', workflowId: 'wf-2' })
    const seed: Seed = {
      workflows: [workflow(), workflow({ id: 'wf-2' })],
      stages: [stage({ id: 'st-1', position: 0 }), other],
      tasks: [task({ id: 't-1' }), task({ id: 't-2', currentStageId: null, createdAt: LATER })],
    }
    const seeded = view(seed)
    const run = (id: string, stageId: string, target = seeded): unknown =>
      decide(target, command({ type: 'task.move', id, stageId }), NOW, env())

    expect(run('t-404', 'st-1')).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '任务不存在: t-404' },
    })
    expect(run('t-2', 'st-1')).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '任务当前阶段无效' },
    })
    expect(run('t-1', 'st-1', view({ ...seed, active: ['t-1'] }))).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '执行中的阶段不能拖动' },
    })
    expect(run('t-1', 'st-9')).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '目标阶段无效: st-9' },
    })
    expect(
      decide(
        view({ workflows: [workflow()], stages: [stage()], tasks: [task({ id: 't-1' })] }),
        command({ type: 'task.move', id: 't-1', stageId: 'st-1' }),
        NOW,
        env(),
      ),
    ).not.toHaveProperty('reject')
    expect(
      decide(
        view({ workflows: [], stages: [stage()], tasks: [task({ workflowId: 'wf-404' })] }),
        command({ type: 'task.move', id: 't-1', stageId: 'st-1' }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [], reject: { code: 'not_found', message: '工作流不存在: wf-404' } })
  })

  it('task.complete：置为 completed 并刷新 updatedAt；已完成再完成也发事实', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1' })],
      tasks: [task({ id: 't-1' }), task({ id: 't-2', status: 'completed', createdAt: LATER })],
    })

    expect(decide(seeded, command({ type: 'task.complete', id: 't-1' }), NOW, env())).toEqual({
      facts: [
        at('task.completed', { task: task({ id: 't-1', status: 'completed', updatedAt: NOW }) }),
      ],
    })

    expect(decide(seeded, command({ type: 'task.complete', id: 't-2' }), NOW, env())).toEqual({
      facts: [
        at('task.completed', {
          task: task({ id: 't-2', status: 'completed', createdAt: LATER, updatedAt: NOW }),
        }),
      ],
    })
  })

  it('task.complete：任务/工作流不存在、当前阶段无效、执行中都 reject', () => {
    const seed: Seed = {
      workflows: [workflow()],
      stages: [stage({ id: 'st-1' })],
      tasks: [task({ id: 't-1' }), task({ id: 't-2', currentStageId: null, createdAt: LATER })],
    }
    const seeded = view(seed)

    expect(decide(view(), command({ type: 'task.complete', id: 't-404' }), NOW, env())).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '任务不存在: t-404' },
    })
    expect(decide(seeded, command({ type: 'task.complete', id: 't-2' }), NOW, env())).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '任务当前阶段无效' },
    })
    expect(
      decide(
        view({ ...seed, active: ['t-1'] }),
        command({ type: 'task.complete', id: 't-1' }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [], reject: { code: 'conflict', message: '执行中的阶段不能完成' } })
    expect(
      decide(
        view({ workflows: [], stages: [stage()], tasks: [task({ workflowId: 'wf-404' })] }),
        command({ type: 'task.complete', id: 't-1' }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [], reject: { code: 'not_found', message: '工作流不存在: wf-404' } })
  })

  it('task.remove：tombstone；不存在静默', () => {
    expect(
      decide(
        view({ tasks: [task({ id: 't-1' })] }),
        command({ type: 'task.remove', id: 't-1' }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [at('task.removed', { task: task({ id: 't-1' }) })] })

    expect(decide(view(), command({ type: 'task.remove', id: 't-404' }), NOW, env())).toEqual({
      facts: [],
    })
  })

  it('task.remove：同 queueSeq / createdAt 的 run 按 id 排序删除（D13 事实序稳定）', () => {
    const result = decide(
      view({
        tasks: [task({ id: 't-1' })],
        runs: [
          runRow({ id: 'run-b', queueSeq: 1, createdAt: CREATED }),
          runRow({ id: 'run-a', queueSeq: 1, createdAt: CREATED }),
        ],
      }),
      command({ type: 'task.remove', id: 't-1' }),
      NOW,
      env(),
    )

    expect(result.facts.map((fact) => fact.type)).toEqual([
      'run.removed',
      'run.removed',
      'task.removed',
    ])
    expect(
      result.facts.slice(0, 2).map((fact) => (fact.payload as { runId: string }).runId),
    ).toEqual(['run-a', 'run-b'])
  })
})

describe('kernel/decide 进入效果（run.queued）', () => {
  /** agent 阶段 + 智能体 + 运行时齐全的种子。 */
  const agentView = (over: Partial<Seed> = {}): View =>
    view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1', entryMode: 'agent', agentId: 'ag-1' })],
      agents: [agent()],
      runtimes: [runtime({ workdir: 'C:/work' })],
      ...over,
    })

  const entryRun = (facts: FactDraft[], id = 'run-new-1') => {
    const fact = facts.find((item) => item.type === 'run.queued')
    expect(fact, '应产 run.queued').toBeDefined()
    const run = (fact?.payload as { run: RunRow }).run
    expect(run.id).toBe(id)
    return run
  }

  it('task.create 进 agent 阶段：同批产 run.queued，行字段与提示词逐字正确', () => {
    expect(
      decide(
        agentView(),
        command({ type: 'task.create', input: { title: '写计划', workflowId: 'wf-1' } }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        at('task.created', {
          task: task({
            id: 'task-new-1',
            title: '写计划',
            currentStageId: 'st-1',
            createdAt: NOW,
            updatedAt: NOW,
          }),
        }),
        at('run.queued', {
          run: {
            id: 'run-new-1',
            purpose: 'stage',
            taskId: 'task-new-1',
            conversationId: null,
            stageId: 'st-1',
            agentId: 'ag-1',
            runtimeId: 'rt-1',
            ruleId: null,
            rulesVersion: 0,
            executorKey: 'dsh',
            threadId: null,
            cwd: 'C:/work',
            access: 'edit',
            skill: null,
            promptRef: null,
            eventIds: [],
            hops: 0,
            turn: 1,
            resumeSessionId: null,
            threadContextRef: null,
            queueSeq: 0,
            status: 'queued',
            prompt: 'sys\n\n# 任务：写计划\n\n# 阶段：待办',
            output: '',
            error: null,
            errorCode: null,
            exitCode: null,
            sessionId: null,
            usage: null,
            durationMs: null,
            leaseId: null,
            attempt: 0,
            attempts: 0,
            leaseUntil: null,
            notBefore: null,
            deadlineAt: null,
            cancelRequested: false,
            startedAt: null,
            endedAt: null,
            createdAt: NOW,
          },
        }),
      ],
    })
  })

  it('user / none 入口：只建任务，不产 run.queued', () => {
    for (const entryMode of ['user', 'none'] as const) {
      const decision = decide(
        agentView({ stages: [stage({ id: 'st-1', entryMode })] }),
        command({ type: 'task.create', input: { title: 't', workflowId: 'wf-1' } }),
        NOW,
        env(),
      )
      expect(decision.facts.map((fact) => fact.type)).toEqual(['task.created'])
    }
  })

  it('缺智能体 / 缺运行时：只建任务，不产 run.queued', () => {
    const missingAgent = decide(
      agentView({ agents: [] }),
      command({ type: 'task.create', input: { title: 't', workflowId: 'wf-1' } }),
      NOW,
      env(),
    )
    expect(missingAgent.facts.map((fact) => fact.type)).toEqual(['task.created'])

    const missingRuntime = decide(
      agentView({ runtimes: [] }),
      command({ type: 'task.create', input: { title: 't', workflowId: 'wf-1' } }),
      NOW,
      env(),
    )
    expect(missingRuntime.facts.map((fact) => fact.type)).toEqual(['task.created'])

    const noAgentBound = decide(
      agentView({ stages: [stage({ id: 'st-1', entryMode: 'agent', agentId: null })] }),
      command({ type: 'task.create', input: { title: 't', workflowId: 'wf-1' } }),
      NOW,
      env(),
    )
    expect(noAgentBound.facts.map((fact) => fact.type)).toEqual(['task.created'])
  })

  it('权限模式映射到 access：read-only→read、workspace-write→edit、danger-full-access→full', () => {
    const cases = [
      ['read-only', 'read'],
      ['workspace-write', 'edit'],
      ['danger-full-access', 'full'],
    ] as const
    for (const [permissionMode, access] of cases) {
      const decision = decide(
        agentView({ runtimes: [runtime({ permissionMode })] }),
        command({ type: 'task.create', input: { title: 't', workflowId: 'wf-1' } }),
        NOW,
        env(),
      )
      expect(entryRun(decision.facts).access).toBe(access)
    }
  })

  it('task.move 进 agent 阶段：任务事实 + run.queued（提示词用目标阶段名）', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [
        stage({ id: 'st-1', position: 0 }),
        stage({ id: 'st-2', position: 1, name: '实现', entryMode: 'agent', agentId: 'ag-1' }),
      ],
      agents: [agent()],
      runtimes: [runtime()],
      tasks: [task({ id: 't-1' })],
    })

    const decision = decide(
      seeded,
      command({ type: 'task.move', id: 't-1', stageId: 'st-2' }),
      NOW,
      env(),
    )

    expect(decision.facts.map((fact) => fact.type)).toEqual(['task.moved', 'run.queued'])
    const run = entryRun(decision.facts)
    expect(run).toMatchObject({
      taskId: 't-1',
      stageId: 'st-2',
      agentId: 'ag-1',
      runtimeId: 'rt-1',
      status: 'queued',
      turn: 1,
      attempt: 0,
      queueSeq: 0,
    })
    expect(run.prompt).toBe('sys\n\n# 任务：任务\n\n# 阶段：实现')
  })

  it('task.move 原地（from===to）或已完成任务：不产 run.queued', () => {
    const sameStage = decide(
      view({
        workflows: [workflow()],
        stages: [stage({ id: 'st-1', entryMode: 'agent', agentId: 'ag-1' })],
        agents: [agent()],
        runtimes: [runtime()],
        tasks: [task({ id: 't-1', currentStageId: 'st-1' })],
      }),
      command({ type: 'task.move', id: 't-1', stageId: 'st-1' }),
      NOW,
      env(),
    )
    expect(sameStage.facts.map((fact) => fact.type)).toEqual(['task.moved'])

    const completed = decide(
      agentView({
        stages: [
          stage({ id: 'st-1', position: 0 }),
          stage({ id: 'st-2', position: 1, entryMode: 'agent', agentId: 'ag-1' }),
        ],
        tasks: [task({ id: 't-1', status: 'completed' })],
      }),
      command({ type: 'task.move', id: 't-1', stageId: 'st-2' }),
      NOW,
      env(),
    )
    expect(completed.facts.map((fact) => fact.type)).toEqual(['task.moved'])
  })

  it('同一任务每次进入 agent 阶段都重新建 run（往返两次各一条）', () => {
    const base = {
      workflows: [workflow()],
      stages: [
        stage({ id: 'st-1', position: 0 }),
        stage({ id: 'st-2', position: 1, entryMode: 'agent', agentId: 'ag-1' }),
      ],
      agents: [agent()],
      runtimes: [runtime()],
    }
    const first = decide(
      view({ ...base, tasks: [task({ id: 't-1', currentStageId: 'st-1' })] }),
      command({ type: 'task.move', id: 't-1', stageId: 'st-2' }),
      NOW,
      env(),
    )
    const back = decide(
      view({ ...base, tasks: [task({ id: 't-1', currentStageId: 'st-2' })] }),
      command({ type: 'task.move', id: 't-1', stageId: 'st-1' }),
      NOW,
      env(),
    )
    const again = decide(
      view({ ...base, tasks: [task({ id: 't-1', currentStageId: 'st-1' })] }),
      command({ type: 'task.move', id: 't-1', stageId: 'st-2' }),
      NOW,
      env(),
    )

    expect(first.facts.map((fact) => fact.type)).toEqual(['task.moved', 'run.queued'])
    expect(back.facts.map((fact) => fact.type)).toEqual(['task.moved'])
    expect(again.facts.map((fact) => fact.type)).toEqual(['task.moved', 'run.queued'])
  })

  it('回执成功流转到 agent 阶段：run.succeeded + task.moved + 下一轮 run.queued', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [
        stage({
          id: 'st-1',
          position: 0,
          entryMode: 'agent',
          agentId: 'ag-1',
          onCompleteStageId: 'st-2',
        }),
        stage({ id: 'st-2', position: 1, name: '实现', entryMode: 'agent', agentId: 'ag-1' }),
      ],
      agents: [agent()],
      runtimes: [runtime()],
      tasks: [task({ id: 't-1' })],
      runs: [runRow({ id: 'run-1' })],
      active: ['t-1'],
    })

    const decision = decide(
      seeded,
      host({
        type: 'run.receipt',
        runId: 'run-1',
        receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1, output: 'done' },
      }),
      NOW,
      env(),
    )

    expect(decision.facts.map((fact) => fact.type)).toEqual([
      'run.succeeded',
      'task.moved',
      'run.queued',
    ])
    const moved = decision.facts[1]?.payload as { from: string | null; to: string | null }
    expect(moved).toMatchObject({ from: 'st-1', to: 'st-2' })
    const queued = entryRun(decision.facts)
    expect(queued).toMatchObject({ taskId: 't-1', stageId: 'st-2', status: 'queued' })
    expect(queued.prompt).toBe('sys\n\n# 任务：任务\n\n# 阶段：实现')
    // 进入效果由宿主调度器发起（actor 标明来源）
    expect(decision.facts[2]?.actor).toEqual({ kind: 'host', via: 'scheduler' })
  })

  it('回执失败打回到另一个 agent 阶段：同样产下一轮 run.queued', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [
        stage({ id: 'st-0', position: 0, name: '重做', entryMode: 'agent', agentId: 'ag-1' }),
        stage({
          id: 'st-1',
          position: 1,
          entryMode: 'agent',
          agentId: 'ag-1',
          onRejectStageId: 'st-0',
        }),
      ],
      agents: [agent()],
      runtimes: [runtime()],
      tasks: [task({ id: 't-1' })],
      runs: [runRow({ id: 'run-1' })],
      active: ['t-1'],
    })

    const decision = decide(
      seeded,
      host({
        type: 'run.receipt',
        runId: 'run-1',
        receipt: {
          status: 'failed',
          leaseId: 'run-1:1',
          turn: 1,
          errorCode: 'exit_nonzero',
          error: '退出码 1',
        },
      }),
      NOW,
      env(),
    )

    expect(decision.facts.map((fact) => fact.type)).toEqual([
      'run.failed',
      'task.moved',
      'run.queued',
    ])
    expect(entryRun(decision.facts)).toMatchObject({ stageId: 'st-0', taskId: 't-1' })
  })

  it('回执失败打回原地 / 取消：零流转、不重建 run', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1', entryMode: 'agent', agentId: 'ag-1' })],
      agents: [agent()],
      runtimes: [runtime()],
      tasks: [task({ id: 't-1' })],
      runs: [runRow({ id: 'run-1' })],
      active: ['t-1'],
    })

    const failed = decide(
      seeded,
      host({
        type: 'run.receipt',
        runId: 'run-1',
        receipt: { status: 'failed', leaseId: 'run-1:1', turn: 1, errorCode: 'run_failed' },
      }),
      NOW,
      env(),
    )
    expect(failed.facts.map((fact) => fact.type)).toEqual(['run.failed'])

    const cancelled = decide(
      seeded,
      host({
        type: 'run.receipt',
        runId: 'run-1',
        receipt: { status: 'cancelled', leaseId: 'run-1:1', turn: 1, errorCode: 'cancelled' },
      }),
      NOW,
      env(),
    )
    expect(cancelled.facts.map((fact) => fact.type)).toEqual(['run.cancelled'])
  })
})

describe('kernel/decide run.frames', () => {
  it('执行中的 run：帧按宿主分配的 seq 原样入账（actor 标调度器）', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage()],
      tasks: [task({ id: 't-1' })],
      runs: [runRow({ id: 'run-1' })],
    })
    const frames = [
      { runId: 'run-1', seq: 1, type: 'text' as const, text: 'hi' },
      { runId: 'run-1', seq: 2, type: 'status' as const, status: 'running' },
    ]

    expect(
      decide(seeded, host({ type: 'run.frames', runId: 'run-1', turn: 1, frames }), NOW, env()),
    ).toEqual({
      facts: [
        {
          type: 'run.frames',
          actor: { kind: 'host', via: 'scheduler' },
          at: NOW,
          payload: { runId: 'run-1', turn: 1, frames },
        },
      ],
    })
  })

  it('终态 / 不存在 / 轮次不匹配：静默零事实', () => {
    const terminal = view({
      tasks: [task({ id: 't-1' })],
      runs: [runRow({ id: 'run-1', status: 'succeeded' })],
    })
    const frames = [{ runId: 'run-1', seq: 1, type: 'text' as const, text: 'x' }]

    expect(
      decide(terminal, host({ type: 'run.frames', runId: 'run-1', turn: 1, frames }), NOW, env()),
    ).toEqual({ facts: [] })

    expect(
      decide(view(), host({ type: 'run.frames', runId: 'ghost', turn: 1, frames }), NOW, env()),
    ).toEqual({ facts: [] })

    const running = view({ tasks: [task({ id: 't-1' })], runs: [runRow({ id: 'run-1' })] })
    const otherTurn = frames.map((frame) => ({ ...frame }))
    expect(
      decide(
        running,
        host({ type: 'run.frames', runId: 'run-1', turn: 2, frames: otherTurn }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [] })
  })
})

describe('kernel/prompt taskPrompt', () => {
  it('空段过滤：空 systemPrompt / 空描述不产生多余空行', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1', name: '执行', entryMode: 'agent', agentId: 'ag-1' })],
      agents: [agent({ systemPrompt: '' })],
      runtimes: [runtime()],
    })
    const decision = decide(
      seeded,
      command({ type: 'task.create', input: { title: 'T', workflowId: 'wf-1' } }),
      NOW,
      env(),
    )
    const queued = decision.facts.find((fact) => fact.type === 'run.queued')
    const run = (queued?.payload as { run: RunRow }).run
    expect(run.prompt).toBe('# 任务：T\n\n# 阶段：执行')
  })

  it('描述非空时按「智能体 → 任务 → 描述 → 阶段」顺序、两两空行分隔', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1', name: '执行', entryMode: 'agent', agentId: 'ag-1' })],
      agents: [agent({ systemPrompt: 'sys' })],
      runtimes: [runtime()],
    })
    const decision = decide(
      seeded,
      command({
        type: 'task.create',
        input: { title: 'T', description: '做点事', workflowId: 'wf-1' },
      }),
      NOW,
      env(),
    )
    const queued = decision.facts.find((fact) => fact.type === 'run.queued')
    const run = (queued?.payload as { run: RunRow }).run
    expect(run.prompt).toBe('sys\n\n# 任务：T\n\n做点事\n\n# 阶段：执行')
  })
})

describe('kernel/prompt taskPrompt（无阶段名）', () => {
  it('stageName 为 null 时不拼阶段段', () => {
    expect(
      taskPrompt(agent({ systemPrompt: 'sys' }), task({ title: 'T', description: 'd' }), null),
    ).toBe('sys\n\n# 任务：T\n\nd')
  })
})

describe('kernel/decide 引用扫描', () => {
  it('runtime.remove：多智能体时只拦截真正引用它的那个', () => {
    const other = runtime({ id: 'rt-2', name: '另一个运行时' })
    const second = agent({ id: 'ag-2', runtimeId: 'rt-2' })
    const seeded = view({
      runtimes: [runtime(), other],
      agents: [agent(), second],
    })

    // 第一个智能体不引用 rt-2：扫描继续，最终命中第二个
    expect(decide(seeded, command({ type: 'runtime.remove', id: 'rt-2' }), NOW, env())).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '运行时被智能体引用，无法删除: rt-2' },
    })
  })

  it('agent.remove：前序阶段绑了别的智能体时仍识别出后续引用', () => {
    const second = agent({ id: 'ag-2' })
    const seeded = view({
      runtimes: [runtime()],
      agents: [agent(), second],
      stages: [
        stage({ id: 'st-1', position: 0, agentId: 'ag-1' }),
        stage({ id: 'st-2', position: 1, agentId: 'ag-2' }),
      ],
    })

    expect(decide(seeded, command({ type: 'agent.remove', id: 'ag-2' }), NOW, env())).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '智能体被工作流阶段或对话引用，无法删除: ag-2' },
    })
  })
})
