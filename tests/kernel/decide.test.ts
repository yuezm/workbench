import { describe, expect, it } from 'vitest'
import type { Command } from '../../src/protocol/commands'
import type { Input } from '../../src/protocol/inputs'
import type {
  Agent,
  BuiltinStageKey,
  Conversation,
  Project,
  RunRow,
  Runtime,
  RuntimeProbe,
  StageInput,
  Card,
  Task,
  Workflow,
  WorkflowStage,
} from '../../src/protocol/entities'
import { BUILTIN_STAGE_NAMES } from '../../src/protocol/entities'
import type { FactPayload, FactType } from '../../src/protocol/facts'
import type { ThreadRow } from '../../src/protocol/thread'
import type { HostInput } from '../../src/protocol/inputs'
import { decide } from '../../src/kernel/decide'
import { naturalStageLabel } from '../../src/kernel/commands/task'
import { indexTarget, sameInstructions } from '../../src/kernel/commands/workflow'
import {
  interruptRuleText,
  outputContractText,
  receiptBlockHint,
  taskPrompt,
  taskReceiptKeys,
} from '../../src/kernel/prompt'
import { BASE_RECEIPT_KEYS } from '../../src/protocol/receipt-keys'
import type { Environment, FactDraft, Id, IdKind, Limits, View } from '../../src/kernel/types'

const CREATED = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-02T00:00:00.000Z'
const NOW = '2026-11-04T12:00:00.000Z'
const ACTOR = { kind: 'owner', via: 'ui' } as const
/** 阶段任务提示词末尾固定追加的回执块说明（M4 D4）。 */
const HINT = receiptBlockHint(taskReceiptKeys({ gate: null, acceptance: [] }, { threadId: null }))
/** 建任务会开隐式线程：回执比普通阶段多一个 notes 出口（M24 裁剪） */
const THREAD_HINT = receiptBlockHint(
  taskReceiptKeys({ gate: null, acceptance: [] }, { threadId: 'th-1' }),
)
/** 阶段任务提示词里的打断规则段（M19）。 */
const INTERRUPT = interruptRuleText()
/** 本轮正文段（M27）：挂线程的阶段才有。 */
const CONTRACT = outputContractText()

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
  // M18：内置键（null = 自己添加的阶段）；投影行恒有该字段
  builtin: null,
  agentId: null,
  onCompleteStageId: null,
  onRejectStageId: null,
  handoffWorkflowId: null,
  handoffStageId: null,
  subtaskStageId: null,
  onChildrenSettled: null,
  spawnPolicy: null,
  instructions: '',
  acceptance: [],
  maxRounds: null,
  runTimeoutMs: null,
  gate: null,
  ...over,
})

/** M18：内置阶段行（四件套之一）。 */
const builtinStage = (
  key: BuiltinStageKey,
  position: number,
  over: Partial<WorkflowStage> = {},
): WorkflowStage =>
  stage({
    id: `bs-${key}`,
    name: BUILTIN_STAGE_NAMES[key],
    builtin: key,
    position,
    ...over,
  })

/** M18：无用户阶段的四件套（待办 0 / 已阻塞 1 / 已完成 2 / 已取消 3）。 */
const builtinStages = (): WorkflowStage[] => [
  builtinStage('todo', 0),
  builtinStage('blocked', 1),
  builtinStage('done', 2),
  builtinStage('cancelled', 3),
]

/** M10：项目行（任务的容器与执行工作目录；默认项目 pj-1 供 task.create 使用）。 */
const project = (over: Partial<Project> = {}): Project => ({
  id: 'pj-1',
  name: '工作台',
  path: 'D:/work',
  description: '',
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: 'sys',
  // 执行配置在智能体上（运行时只管连接）
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: CREATED,
  ...over,
})

/** 对话行（`conversations.agent_id` 是 ON DELETE RESTRICT：智能体被对话引用时不允许删） */
const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'cv-1',
  title: '对话',
  agentId: 'ag-1',
  projectId: null,
  sessionId: null,
  createdAt: CREATED,
  updatedAt: CREATED,
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
  projectId: null,
  currentStageId: 'st-1',
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: null,
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  gateFails: 0,
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
  deliverables: null,
  startedAt: NOW,
  endedAt: null,
  createdAt: CREATED,
  ...over,
})

/** 卡片行（卡片随运行/任务结束自动收起的用例） */
const card = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '知会',
  text: '',
  kind: 'notice',
  options: [],
  key: null,
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
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
  /** M10：默认含 pj-1，task.create 必须带一个存在的项目 */
  projects?: Project[]
  tasks?: Task[]
  runs?: RunRow[]
  cards?: Card[]
  /** 对话（删智能体时按 agentId 查引用） */
  conversations?: Conversation[]
  active?: Id[]
}

const view = (seed: Seed = {}): View => ({
  seq: 7,
  workflows: new Map((seed.workflows ?? []).map((row) => [row.id, row])),
  stages: new Map((seed.stages ?? []).map((row) => [row.id, row])),
  agents: new Map((seed.agents ?? []).map((row) => [row.id, row])),
  runtimes: new Map((seed.runtimes ?? []).map((row) => [row.id, row])),
  projects: new Map(((seed.projects ?? [project()]) as Project[]).map((row) => [row.id, row])),
  tasks: new Map((seed.tasks ?? []).map((row) => [row.id, row])),
  runs: new Map((seed.runs ?? []).map((row) => [row.id, row])),
  conversations: new Map((seed.conversations ?? []).map((row) => [row.id, row])),
  messages: new Map(),
  cards: new Map((seed.cards ?? []).map((row) => [row.id, row])),
  activeTaskIds: new Set(seed.active ?? []),
  threads: new Map(),
  taskComments: new Map(),
  reviewReports: new Map(),
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
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

  it('runtime.create：只落连接字段；执行配置字段不属于运行时（传了也不进行）', () => {
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
          enabled: false,
          // 老契约残留 / 表单误传：运行时不再接收执行配置，落行时必须消失
          permissionMode: 'danger-full-access',
          model: 'm',
          reasoningEffort: 'high',
          workdir: 'C:/w',
          maxConcurrent: 99,
          env: { FOO: 'bar' },
        } as never,
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
            enabled: false,
            createdAt: NOW,
          }),
        }),
      ],
    })
    // 运行时行上不再有这些列（执行配置的归属层是智能体）
    const created = (decision.facts[0]?.payload as { runtime: Runtime }).runtime
    for (const key of [
      'permissionMode',
      'model',
      'reasoningEffort',
      'workdir',
      'maxConcurrent',
      'env',
    ]) {
      expect(created).not.toHaveProperty(key)
    }
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
    expect(run({ name: '本机 dsh' })).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '运行时名称已存在: 本机 dsh' },
    })
  })

  it('runtime.create：宿主未补齐 executorKey / command（字段缺省）时内核拒收', () => {
    // `RuntimeInput.executorKey/command` 是可选字段：缺省值由宿主按执行器 manifest 补齐，
    // 内核只认「已确定」，所以字段缺省必须与空串同样拒绝（不静默落一行无效配置）。
    expect(
      decide(view(), command({ type: 'runtime.create', input: { name: 'x' } }), NOW, env()),
    ).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '运行时缺少执行器键（executorKey）' },
    })
    expect(
      decide(
        view(),
        command({ type: 'runtime.create', input: { name: 'x', executorKey: 'dsh' } }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '运行时缺少启动命令（command）' },
    })
  })

  it('runtime.update：保留 createdAt 与 lastProbe，按 patch 覆盖连接字段', () => {
    const decision = decide(
      view({ runtimes: [runtime({ lastProbe: probe })] }),
      command({
        type: 'runtime.update',
        id: 'rt-1',
        patch: {
          name: ' 改名 ',
          executorKey: 'dsh',
          argsTemplate: '',
          command: ' dsh2 ',
          profile: ' p3 ',
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
            profile: 'p3',
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

  it('runtime.update：patch.profile 显式给出时裁剪并覆盖', () => {
    expect(
      decide(
        view({ runtimes: [runtime({ profile: 'old' })] }),
        command({ type: 'runtime.update', id: 'rt-1', patch: { profile: '  p2  ' } }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [at('runtime.updated', { runtime: runtime({ profile: 'p2' }) })] })
  })

  it('runtime.update：目标不存在与执行器键非法都 reject', () => {
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

  it('agent.create：环境变量只收字符串值（非字符串值被丢弃）', () => {
    const decision = decide(
      view({ runtimes: [runtime()] }),
      command({
        type: 'agent.create',
        input: {
          name: 'env',
          runtimeId: 'rt-1',
          // 形状由 protocol/validate 把关；内核只防御非字符串值（脏输入不炸、也不落库）
          env: { OK: 'v', BAD: 1 } as unknown as Record<string, string>,
        },
      }),
      NOW,
      env(),
    )
    expect(decision).toEqual({
      facts: [
        at('agent.created', {
          agent: agent({
            id: 'agent-new-1',
            name: 'env',
            systemPrompt: '',
            env: { OK: 'v' },
            createdAt: NOW,
          }),
        }),
      ],
    })
  })

  it('agent.create：执行配置字段透传，并发上限封顶 8、权限模式按枚举落行', () => {
    const decision = decide(
      view({ runtimes: [runtime()] }),
      command({
        type: 'agent.create',
        input: {
          name: 'fast',
          runtimeId: 'rt-1',
          model: 'deepseek/v3',
          reasoningEffort: 'high',
          maxConcurrent: 99,
          permissionMode: 'danger-full-access',
          workdir: 'C:/w',
          env: { FOO: 'bar' },
        },
      }),
      NOW,
      env(),
    )

    expect(decision).toEqual({
      facts: [
        at('agent.created', {
          agent: agent({
            id: 'agent-new-1',
            name: 'fast',
            systemPrompt: '',
            model: 'deepseek/v3',
            reasoningEffort: 'high',
            maxConcurrent: 8,
            permissionMode: 'danger-full-access',
            workdir: 'C:/w',
            env: { FOO: 'bar' },
            createdAt: NOW,
          }),
        }),
      ],
    })
  })

  it('agent.create：名称必填、运行时必须存在、权限模式与并发上限非法都 reject', () => {
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
    expect(run({ name: 'a', runtimeId: 'rt-1', permissionMode: 'root' })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '不支持的权限模式: root' },
    })
    expect(run({ name: 'a', runtimeId: 'rt-1', maxConcurrent: 0 })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '并发上限必须是正整数' },
    })
    expect(run({ name: 'a', runtimeId: 'rt-1', maxConcurrent: 1.5 })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '并发上限必须是正整数' },
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

  it('agent.update：执行配置按 patch 覆盖（模型 / 思考强度 / 并发 / 权限 / 目录 / 环境）', () => {
    const decision = decide(
      view({ agents: [agent()], runtimes: [runtime()] }),
      command({
        type: 'agent.update',
        id: 'ag-1',
        patch: {
          permissionMode: 'read-only',
          maxConcurrent: 3,
          model: 'deepseek/v3',
          reasoningEffort: 'low',
          workdir: 'C:/w2',
          env: { BAR: 'baz' },
        },
      }),
      NOW,
      env(),
    )

    expect(decision).toEqual({
      facts: [
        at('agent.updated', {
          agent: agent({
            permissionMode: 'read-only',
            maxConcurrent: 3,
            model: 'deepseek/v3',
            reasoningEffort: 'low',
            workdir: 'C:/w2',
            env: { BAR: 'baz' },
          }),
        }),
      ],
    })
  })

  it('agent.create / agent.update：模型 id 归一（剥 [1m]、解 %2F），非法格式拒收', () => {
    const created = decide(
      view({ runtimes: [runtime()] }),
      command({
        type: 'agent.create',
        input: {
          name: '模型',
          runtimeId: 'rt-1',
          model: ' magpie/auto%2Fdeepseek-v4.1-flash[1m] ',
        },
      }),
      NOW,
      env(),
    )
    const createdAgent = (created.facts[0]?.payload as { agent: { model: string | null } }).agent
    expect(createdAgent.model).toBe('magpie/auto/deepseek-v4.1-flash')

    const updated = decide(
      view({ agents: [agent()], runtimes: [runtime()] }),
      command({ type: 'agent.update', id: 'ag-1', patch: { model: '  ' } }),
      NOW,
      env(),
    )
    expect((updated.facts[0]?.payload as { agent: { model: string | null } }).agent.model).toBe(
      null,
    )

    const badCreate = decide(
      view({ runtimes: [runtime()] }),
      command({
        type: 'agent.create',
        input: { name: '坏模型', runtimeId: 'rt-1', model: 'nomodel' },
      }),
      NOW,
      env(),
    )
    expect(badCreate.reject?.code).toBe('invalid_input')
    expect(badCreate.reject?.message).toContain('模型格式不对')

    const badUpdate = decide(
      view({ agents: [agent()], runtimes: [runtime()] }),
      command({ type: 'agent.update', id: 'ag-1', patch: { model: 'x/' } }),
      NOW,
      env(),
    )
    expect(badUpdate.reject?.code).toBe('invalid_input')
  })

  it('agent.update：目标不存在 / 运行时不存在 / 权限模式与并发非法都 reject', () => {
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

    expect(
      decide(
        seeded,
        command({
          type: 'agent.update',
          id: 'ag-1',
          patch: { permissionMode: 'root' as never },
        }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [], reject: { code: 'invalid_input', message: '不支持的权限模式: root' } })

    expect(
      decide(
        seeded,
        command({ type: 'agent.update', id: 'ag-1', patch: { maxConcurrent: 0 } }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [], reject: { code: 'invalid_input', message: '并发上限必须是正整数' } })
  })

  it('agent.remove：被阶段 / 对话引用时拒绝；存在则 tombstone；不存在静默', () => {
    expect(
      decide(
        view({ agents: [agent()], stages: [stage({ agentId: 'ag-1', entryMode: 'agent' })] }),
        command({ type: 'agent.remove', id: 'ag-1' }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [],
      reject: {
        code: 'conflict',
        message:
          '智能体被工作流阶段「待办」引用，无法删除：先到「工作流」里把这个阶段换绑到别的智能体',
      },
    })

    // 被对话引用同样拒删：`conversations.agent_id` 是外键 RESTRICT，不拦就会抛 SQLite 原始错误
    expect(
      decide(
        view({ agents: [agent()], conversations: [conversation()] }),
        command({ type: 'agent.remove', id: 'ag-1' }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [],
      reject: {
        code: 'conflict',
        message: '智能体被 1 个对话引用（含已归档），无法删除：先删除这些对话，再回来删智能体',
      },
    })

    // 已归档的对话也算引用（归档只影响列表，不解除外键）
    const archived = [conversation(), conversation({ id: 'cv-2', archivedAt: LATER })]
    expect(
      decide(
        view({ agents: [agent()], conversations: archived }),
        command({ type: 'agent.remove', id: 'ag-1' }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [],
      reject: {
        code: 'conflict',
        message: '智能体被 2 个对话引用（含已归档），无法删除：先删除这些对话，再回来删智能体',
      },
    })

    // 别的智能体的对话不算引用
    expect(
      decide(
        view({ agents: [agent()], conversations: [conversation({ agentId: 'ag-9' })] }),
        command({ type: 'agent.remove', id: 'ag-1' }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [at('agent.removed', { agent: agent() })] })

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
            builtin: 'todo',
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
        // M18：缺的另外三个内置阶段按默认值补齐，位置紧随用户阶段之后
        at('stage.created', {
          stage: stage({
            id: 'stage-new-4',
            workflowId: 'workflow-new-1',
            name: '已阻塞',
            builtin: 'blocked',
            position: 3,
          }),
        }),
        at('stage.created', {
          stage: stage({
            id: 'stage-new-5',
            workflowId: 'workflow-new-1',
            name: '已完成',
            builtin: 'done',
            position: 4,
          }),
        }),
        at('stage.created', {
          stage: stage({
            id: 'stage-new-6',
            workflowId: 'workflow-new-1',
            name: '已取消',
            builtin: 'cancelled',
            position: 5,
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

  it('阶段「要干什么」：新建去空白落行，只改说明也产 stage.updated（M9）', () => {
    const created = decide(
      view({ agents: [agent()] }),
      command({
        type: 'workflow.create',
        input: {
          name: 'w',
          stages: [{ name: '待办', entryMode: 'none', instructions: '  读需求  ' }],
        },
      }),
      NOW,
      env(),
    )
    expect((created.facts[1]?.payload as { stage: WorkflowStage }).stage.instructions).toBe(
      '读需求',
    )

    const updated = decide(
      view({
        workflows: [workflow()],
        stages: [stage({ id: 'st-1', instructions: '旧说明' })],
      }),
      command({
        type: 'workflow.update',
        id: 'wf-1',
        input: {
          name: '研发',
          stages: [{ id: 'st-1', name: '待办', entryMode: 'none', instructions: '新说明' }],
        },
      }),
      NOW,
      env(),
    )
    const stageFacts = updated.facts.filter((fact) => fact.type === 'stage.updated')
    expect(stageFacts).toHaveLength(1)
    expect((stageFacts[0]?.payload as { stage: WorkflowStage }).stage.instructions).toBe('新说明')

    // 说明没变（含缺省 ↔ 空串）时不产 stage.updated：避免每次保存都刷一遍阶段
    const unchanged = decide(
      view({
        workflows: [workflow()],
        stages: [builtinStage('todo', 0, { id: 'st-1', instructions: '' })],
      }),
      command({
        type: 'workflow.update',
        id: 'wf-1',
        input: { name: '研发', stages: [{ id: 'st-1', name: '待办', entryMode: 'none' }] },
      }),
      NOW,
      env(),
    )
    expect(unchanged.facts.some((fact) => fact.type === 'stage.updated')).toBe(false)
  })

  it('闸门：新增 / 改次数产 stage.updated，配置未变不产（M11）', () => {
    const update = (gate: StageInput['gate']): ReturnType<typeof decide> =>
      decide(
        view({
          agents: [agent()],
          workflows: [workflow()],
          stages: [stage({ id: 'st-1', entryMode: 'agent', agentId: 'ag-1' })],
        }),
        command({
          type: 'workflow.update',
          id: 'wf-1',
          input: {
            name: '研发',
            stages: [{ id: 'st-1', name: '待办', entryMode: 'agent', agentId: 'ag-1', gate }],
          },
        }),
        NOW,
        env(),
      )

    // 从「不是闸门」变成闸门 → 落 stage.updated
    const added = update({ maxFails: 3 })
    const addedFacts = added.facts.filter((fact) => fact.type === 'stage.updated')
    expect(addedFacts).toHaveLength(1)
    expect((addedFacts[0]?.payload as { stage: WorkflowStage }).stage.gate).toEqual({
      maxFails: 3,
      onPassStageId: null,
      onFailStageId: null,
    })

    // 次数从 3 改 5 → 同样落 stage.updated
    const changed = decide(
      view({
        agents: [agent()],
        workflows: [workflow()],
        stages: [
          stage({
            id: 'st-1',
            entryMode: 'agent',
            agentId: 'ag-1',
            gate: { maxFails: 3, onPassStageId: null, onFailStageId: null },
          }),
        ],
      }),
      command({
        type: 'workflow.update',
        id: 'wf-1',
        input: {
          name: '研发',
          stages: [
            {
              id: 'st-1',
              name: '待办',
              entryMode: 'agent',
              agentId: 'ag-1',
              gate: { maxFails: 5 },
            },
          ],
        },
      }),
      NOW,
      env(),
    )
    expect(changed.facts.some((fact) => fact.type === 'stage.updated')).toBe(true)

    // 配置逐字段相同 → 不产 stage.updated
    const same = decide(
      view({
        agents: [agent()],
        workflows: [workflow()],
        stages: [
          builtinStage('todo', 0, {
            id: 'st-1',
            entryMode: 'agent',
            agentId: 'ag-1',
            gate: { maxFails: 3, onPassStageId: null, onFailStageId: null },
          }),
        ],
      }),
      command({
        type: 'workflow.update',
        id: 'wf-1',
        input: {
          name: '研发',
          stages: [
            {
              id: 'st-1',
              name: '待办',
              entryMode: 'agent',
              agentId: 'ag-1',
              gate: { maxFails: 3 },
            },
          ],
        },
      }),
      NOW,
      env(),
    )
    expect(same.facts.some((fact) => fact.type === 'stage.updated')).toBe(false)
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
            position: 1,
            name: '实现',
            entryMode: 'agent',
            agentId: 'ag-1',
            onRejectStageId: 'stage-new-1',
          }),
        }),
        // M18：内置阶段按规范顺序补齐（待办在前、已阻塞 / 已完成 / 已取消在后）
        at('stage.created', {
          stage: stage({
            id: 'stage-new-2',
            name: '待办',
            builtin: 'todo',
            position: 0,
          }),
        }),
        at('stage.created', {
          stage: stage({
            id: 'stage-new-1',
            position: 2,
            name: '验收',
            entryMode: 'user',
            onRejectStageId: 'st-2',
          }),
        }),
        at('stage.created', {
          stage: stage({
            id: 'stage-new-3',
            name: '已阻塞',
            builtin: 'blocked',
            position: 3,
          }),
        }),
        at('stage.created', {
          stage: stage({
            id: 'stage-new-4',
            name: '已完成',
            builtin: 'done',
            position: 4,
          }),
        }),
        at('stage.created', {
          stage: stage({
            id: 'stage-new-5',
            name: '已取消',
            builtin: 'cancelled',
            position: 5,
          }),
        }),
        at('task.moved', {
          task: task({ id: 't-1', currentStageId: 'stage-new-2' }),
          from: 'st-1',
          to: 'stage-new-2',
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
        // M18：内置「待办」由系统补建，排在最前
        at('stage.created', {
          stage: stage({ id: 'stage-new-3', name: '待办', builtin: 'todo', position: 0 }),
        }),
        at('stage.created', {
          stage: stage({ id: 'stage-new-1', name: 'A', position: 1 }),
        }),
        at('stage.created', {
          stage: stage({ id: 'stage-new-2', name: 'B', position: 2 }),
        }),
        at('stage.created', {
          stage: stage({ id: 'stage-new-4', name: '已阻塞', builtin: 'blocked', position: 3 }),
        }),
        at('stage.created', {
          stage: stage({ id: 'stage-new-5', name: '已完成', builtin: 'done', position: 4 }),
        }),
        at('stage.created', {
          stage: stage({ id: 'stage-new-6', name: '已取消', builtin: 'cancelled', position: 5 }),
        }),
        at('task.moved', {
          task: task({ id: 't-1', currentStageId: 'stage-new-3' }),
          from: 'st-1',
          to: 'stage-new-3',
        }),
        at('task.moved', {
          task: task({ id: 't-2', currentStageId: 'stage-new-1', createdAt: LATER }),
          from: 'st-2',
          to: 'stage-new-1',
        }),
      ],
    })
  })

  it('workflow.update：阶段集合与名称未变时只发 workflow.updated（阶段不重建）', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: builtinStages(),
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
              { id: 'bs-todo', name: '待办', entryMode: 'none', builtin: 'todo' },
              { id: 'bs-blocked', name: '已阻塞', entryMode: 'none', builtin: 'blocked' },
              { id: 'bs-done', name: '已完成', entryMode: 'none', builtin: 'done' },
              { id: 'bs-cancelled', name: '已取消', entryMode: 'none', builtin: 'cancelled' },
            ],
          },
        }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [at('workflow.updated', { workflow: workflow() })] })
  })

  it('M18 内置阶段：名称 / 类别 / 交接由内核锁定，缺的内置阶段按既有行还原', () => {
    const seeded = view({ workflows: [workflow()], stages: builtinStages() })
    const update = (stages: StageInput[]): ReturnType<typeof decide> =>
      decide(
        seeded,
        command({ type: 'workflow.update', id: 'wf-1', input: { name: '研发', stages } }),
        NOW,
        env(),
      )

    expect(update([{ id: 'bs-todo', name: '待办', entryMode: 'none', builtin: 'done' }])).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '阶段「待办」是内置阶段，类别不可修改' },
    })
    expect(update([{ id: 'bs-done', name: '验收', entryMode: 'none' }])).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '内置阶段「已完成」不可改名' },
    })
    expect(
      update([
        { id: 'bs-cancelled', name: '已取消', entryMode: 'none', handoffWorkflowId: 'wf-2' },
      ]),
    ).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '内置阶段「已取消」不允许交接' },
    })
    // 只提交「待办」：另外三条内置阶段按既有行还原，位置不变 → 只有 workflow.updated
    expect(update([{ id: 'bs-todo', name: '待办', entryMode: 'none', builtin: 'todo' }])).toEqual({
      facts: [at('workflow.updated', { workflow: workflow() })],
    })
  })

  it('M18 内置阶段：新建时缺的内置阶段按默认值补齐、禁止改名与终态交接', () => {
    const create = (stages: StageInput[]): ReturnType<typeof decide> =>
      decide(
        view({ agents: [agent()] }),
        command({ type: 'workflow.create', input: { name: 'w', stages } }),
        NOW,
        env(),
      )

    expect(create([{ name: '待办', entryMode: 'none', builtin: 'done' }])).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '内置阶段名称固定为「已完成」' },
    })
    expect(create([{ name: '已完成', entryMode: 'none', handoffWorkflowId: 'wf-1' }])).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '内置阶段「已完成」不允许交接' },
    })
    const created = create([{ name: '开发', entryMode: 'agent', agentId: 'ag-1' }])
    expect(created.facts.map((fact) => fact.type)).toEqual([
      'workflow.created',
      'stage.created',
      'stage.created',
      'stage.created',
      'stage.created',
      'stage.created',
    ])
    const rows = created.facts
      .filter((fact) => fact.type === 'stage.created')
      .map((fact) => (fact.payload as { stage: WorkflowStage }).stage)
    expect(rows.map((row) => [row.name, row.builtin ?? null, row.position])).toEqual([
      ['待办', 'todo', 0],
      ['开发', null, 1],
      ['已阻塞', 'blocked', 2],
      ['已完成', 'done', 3],
      ['已取消', 'cancelled', 4],
    ])
  })

  it('workflow.update：非法输入与守卫（名称/阶段/存在性/活跃 run/智能体/阶段 id）', () => {
    const seed: Seed = {
      workflows: [workflow()],
      // M18：用非内置名，避免内置阶段认领先一步拦掉 id 校验
      stages: [stage({ id: 'st-1', name: '开发' })],
      agents: [agent()],
      tasks: [task({ id: 't-1' })],
    }
    const seeded = view(seed)
    const validStages: StageInput[] = [{ id: 'st-1', name: '开发', entryMode: 'none' }]
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
      reject: {
        code: 'conflict',
        message: '阶段「a」已不存在（st-404），工作流可能已在别处被修改',
      },
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
  /** 手工建任务现在自带隐式线程：三条事实的固定前缀。 */
  const IMPLICIT_THREAD_FACTS = ['thread.opened', 'thread.task_attached', 'task.created']

  const createdTaskOf = (decision: { facts: FactDraft[] }) => {
    const fact = decision.facts.find((item) => item.type === 'task.created')
    expect(fact, '应产 task.created').toBeDefined()
    return (fact?.payload as { task: Task }).task
  }
  const openedThreadOf = (decision: { facts: FactDraft[] }) => {
    const fact = decision.facts.find((item) => item.type === 'thread.opened')
    expect(fact, '应产 thread.opened').toBeDefined()
    return (fact?.payload as { thread: ThreadRow }).thread
  }

  it('task.create：默认进首阶段（按 position），空 stageId 走缺省', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-2', position: 1 }), stage({ id: 'st-1', position: 0 })],
    })

    const first = decide(
      seeded,
      command({
        type: 'task.create',
        input: { title: ' 写计划 ', workflowId: 'wf-1', projectId: 'pj-1' },
      }),
      NOW,
      env(),
    )
    expect(first.facts.map((fact) => fact.type)).toEqual(IMPLICIT_THREAD_FACTS)
    expect(createdTaskOf(first)).toMatchObject({
      id: 'task-new-1',
      title: '写计划',
      currentStageId: 'st-1',
      threadId: 'thread-new-1',
      parentTaskId: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(openedThreadOf(first)).toMatchObject({
      id: 'thread-new-1',
      source: 'manual',
      externalRef: null,
      title: '写计划',
      status: 'open',
      taskIds: [],
      rootTaskIds: [],
    })

    const second = decide(
      seeded,
      command({
        type: 'task.create',
        input: { title: 't', workflowId: 'wf-1', projectId: 'pj-1', stageId: 'st-2' },
      }),
      NOW,
      env(),
    )
    expect(createdTaskOf(second)).toMatchObject({
      currentStageId: 'st-2',
      threadId: 'thread-new-1',
    })

    const blank = decide(
      seeded,
      command({
        type: 'task.create',
        input: { title: 't', workflowId: 'wf-1', projectId: 'pj-1', stageId: '' },
      }),
      NOW,
      env(),
    )
    expect(createdTaskOf(blank)).toMatchObject({ currentStageId: 'st-1' })
  })

  it('task.create：工作流没有任何阶段时 currentStageId 落 null', () => {
    const decision = decide(
      view({ workflows: [workflow()] }),
      command({
        type: 'task.create',
        input: { title: 't', workflowId: 'wf-1', projectId: 'pj-1' },
      }),
      NOW,
      env(),
    )
    expect(decision.facts.map((fact) => fact.type)).toEqual(IMPLICIT_THREAD_FACTS)
    expect(createdTaskOf(decision)).toMatchObject({ currentStageId: null })
  })

  it('task.create：标题必填、工作流必须存在、起始阶段必须属于该工作流', () => {
    const seeded = view({
      workflows: [workflow(), workflow({ id: 'wf-2' })],
      stages: [stage({ id: 'st-1' }), stage({ id: 'st-9', workflowId: 'wf-2' })],
    })
    const run = (input: Record<string, unknown>): unknown =>
      decide(seeded, command({ type: 'task.create', input: input as never }), NOW, env())

    expect(run({ title: ' ', workflowId: 'wf-1', projectId: 'pj-1' })).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '任务标题必填' },
    })
    expect(run({ title: 't', workflowId: 'wf-404' })).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '工作流不存在: wf-404' },
    })
    expect(run({ title: 't', workflowId: 'wf-1', projectId: 'pj-1', stageId: 'st-9' })).toEqual({
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

  it('task.stop：活跃 run 逐条请求取消，终态与已请求的跳过；任务行不动', () => {
    const seeded = view({
      tasks: [task({ id: 't-1' })],
      runs: [
        runRow({ id: 'run-q', status: 'queued', queueSeq: 1 }),
        runRow({ id: 'run-r', status: 'running', queueSeq: 2 }),
        runRow({ id: 'run-w', status: 'waiting', queueSeq: 3 }),
        runRow({ id: 'run-done', status: 'succeeded', queueSeq: 4 }),
        runRow({ id: 'run-c', status: 'running', queueSeq: 5, cancelRequested: true }),
      ],
    })

    expect(decide(seeded, command({ type: 'task.stop', id: 't-1' }), NOW, env())).toEqual({
      facts: [
        at('run.cancel_requested', {
          run: runRow({ id: 'run-q', status: 'queued', queueSeq: 1, cancelRequested: true }),
          by: 'owner',
        }),
        at('run.cancel_requested', {
          run: runRow({ id: 'run-r', status: 'running', queueSeq: 2, cancelRequested: true }),
          by: 'owner',
        }),
        at('run.cancel_requested', {
          run: runRow({ id: 'run-w', status: 'waiting', queueSeq: 3, cancelRequested: true }),
          by: 'owner',
        }),
      ],
    })
  })

  it('task.stop：任务不存在 reject；没有活跃 run 零事实（重复点幂等）', () => {
    expect(decide(view(), command({ type: 'task.stop', id: 't-404' }), NOW, env())).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '任务不存在: t-404' },
    })
    expect(
      decide(
        view({
          tasks: [task({ id: 't-1' })],
          runs: [runRow({ id: 'run-done', status: 'failed' })],
        }),
        command({ type: 'task.stop', id: 't-1' }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [] })
  })

  it('task.complete：任务名下还 open 的卡随任务一起收起（reason=cancelled，别的任务/已答的卡不动）', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ id: 'st-1' })],
      tasks: [task({ id: 't-1' }), task({ id: 't-2', createdAt: LATER })],
      cards: [
        card({ id: 'card-1', runId: 'run-1', taskId: 't-1' }),
        card({ id: 'card-2', runId: 'run-9', taskId: 't-9', createdAt: LATER }),
        card({ id: 'card-3', runId: 'run-1', taskId: 't-1', status: 'answered', createdAt: LATER }),
      ],
    })

    const decision = decide(seeded, command({ type: 'task.complete', id: 't-1' }), NOW, env())
    expect(decision.facts.map((fact) => fact.type)).toEqual(['task.completed', 'card.resolved'])
    const resolved = decision.facts[1]?.payload as { card: Card; reason: string }
    expect(resolved.card.id).toBe('card-1')
    expect(resolved.card.status).toBe('resolved')
    expect(resolved.card.updatedAt).toBe(NOW)
    expect(resolved.reason).toBe('cancelled')
  })

  it('run.host_settled(cancelled)：该 run 还 open 的卡一并收起', () => {
    const seeded = view({
      runs: [runRow({ id: 'run-1', status: 'running' })],
      cards: [card({ id: 'card-1', runId: 'run-1', taskId: 't-9' })],
    })

    const decision = decide(
      seeded,
      { type: 'run.host_settled', runId: 'run-1', status: 'cancelled' },
      NOW,
      env(),
    )
    expect(decision.facts.map((fact) => fact.type)).toEqual(['run.cancelled', 'card.resolved'])
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
      agents: [agent({ workdir: 'C:/work' })],
      runtimes: [runtime()],
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
    const decision = decide(
      agentView(),
      command({
        type: 'task.create',
        input: { title: '写计划', workflowId: 'wf-1', projectId: 'pj-1' },
      }),
      NOW,
      env(),
    )
    expect(decision.facts.map((fact) => fact.type)).toEqual([
      'thread.opened',
      'thread.task_attached',
      'task.created',
      'run.queued',
    ])
    const run = entryRun(decision.facts)
    expect(run).toEqual({
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
      threadId: 'thread-new-1',
      // M10：任务挂在项目 pj-1 下，工作目录取项目文件夹（优先于智能体 workdir）
      cwd: 'D:/work',
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
      prompt: `sys\n\n# 任务：写计划\n\n# 阶段：待办\n\n${CONTRACT}\n\n${INTERRUPT}\n\n${THREAD_HINT}`,
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
      deliverables: null,
      startedAt: null,
      endedAt: null,
      createdAt: NOW,
    })
  })

  it('user / none 入口：只建任务，不产 run.queued', () => {
    for (const entryMode of ['user', 'none'] as const) {
      const decision = decide(
        agentView({ stages: [stage({ id: 'st-1', entryMode })] }),
        command({
          type: 'task.create',
          input: { title: 't', workflowId: 'wf-1', projectId: 'pj-1' },
        }),
        NOW,
        env(),
      )
      expect(decision.facts.map((fact) => fact.type)).toEqual([
        'thread.opened',
        'thread.task_attached',
        'task.created',
      ])
    }
  })

  it('缺智能体 / 缺运行时：只建任务，不产 run.queued', () => {
    const missingAgent = decide(
      agentView({ agents: [] }),
      command({
        type: 'task.create',
        input: { title: 't', workflowId: 'wf-1', projectId: 'pj-1' },
      }),
      NOW,
      env(),
    )
    expect(missingAgent.facts.map((fact) => fact.type)).toEqual([
      'thread.opened',
      'thread.task_attached',
      'task.created',
    ])

    const missingRuntime = decide(
      agentView({ runtimes: [] }),
      command({
        type: 'task.create',
        input: { title: 't', workflowId: 'wf-1', projectId: 'pj-1' },
      }),
      NOW,
      env(),
    )
    expect(missingRuntime.facts.map((fact) => fact.type)).toEqual([
      'thread.opened',
      'thread.task_attached',
      'task.created',
    ])

    const noAgentBound = decide(
      agentView({ stages: [stage({ id: 'st-1', entryMode: 'agent', agentId: null })] }),
      command({
        type: 'task.create',
        input: { title: 't', workflowId: 'wf-1', projectId: 'pj-1' },
      }),
      NOW,
      env(),
    )
    expect(noAgentBound.facts.map((fact) => fact.type)).toEqual([
      'thread.opened',
      'thread.task_attached',
      'task.created',
    ])
  })

  it('权限模式映射到 access：read-only→read、workspace-write→edit、danger-full-access→full', () => {
    const cases = [
      ['read-only', 'read'],
      ['workspace-write', 'edit'],
      ['danger-full-access', 'full'],
    ] as const
    for (const [permissionMode, access] of cases) {
      const decision = decide(
        agentView({ agents: [agent({ permissionMode })] }),
        command({
          type: 'task.create',
          input: { title: 't', workflowId: 'wf-1', projectId: 'pj-1' },
        }),
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
    expect(run.prompt).toBe(`sys\n\n# 任务：任务\n\n# 阶段：实现\n\n${INTERRUPT}\n\n${HINT}`)
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
    // M22：回退到更前阶段是人工跳转（自然去向是「已完成」），留一条评论
    expect(back.facts.map((fact) => fact.type)).toEqual(['task.moved', 'task.comment_added'])
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
    expect(queued.prompt).toBe(`sys\n\n# 任务：任务\n\n# 阶段：实现\n\n${INTERRUPT}\n\n${HINT}`)
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
      command({
        type: 'task.create',
        input: { title: 'T', workflowId: 'wf-1', projectId: 'pj-1' },
      }),
      NOW,
      env(),
    )
    const queued = decision.facts.find((fact) => fact.type === 'run.queued')
    const run = (queued?.payload as { run: RunRow }).run
    expect(run.prompt).toBe(
      `# 任务：T\n\n# 阶段：执行\n\n${CONTRACT}\n\n${INTERRUPT}\n\n${THREAD_HINT}`,
    )
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
        input: { title: 'T', description: '做点事', workflowId: 'wf-1', projectId: 'pj-1' },
      }),
      NOW,
      env(),
    )
    const queued = decision.facts.find((fact) => fact.type === 'run.queued')
    const run = (queued?.payload as { run: RunRow }).run
    expect(run.prompt).toBe(
      `sys\n\n# 任务：T\n\n做点事\n\n# 阶段：执行\n\n${CONTRACT}\n\n${INTERRUPT}\n\n${THREAD_HINT}`,
    )
  })
})

describe('kernel/prompt taskPrompt（无阶段名）', () => {
  it('stageName 为 null 时不拼阶段段', () => {
    expect(
      taskPrompt(agent({ systemPrompt: 'sys' }), task({ title: 'T', description: 'd' }), null),
    ).toBe(`sys\n\n# 任务：T\n\nd\n\n${INTERRUPT}\n\n${receiptBlockHint(BASE_RECEIPT_KEYS)}`)
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
      reject: {
        code: 'conflict',
        message:
          '智能体被工作流阶段「待办」引用，无法删除：先到「工作流」里把这个阶段换绑到别的智能体',
      },
    })
  })
})

describe('kernel/decide M8：任务派生', () => {
  const threadRow = (over: Partial<ThreadRow> = {}): ThreadRow => ({
    id: 'th-1',
    source: 'manual',
    externalRef: null,
    title: '父任务',
    status: 'open',
    taskIds: ['t-1'],
    rootTaskIds: ['t-1'],
    concurrency: 1,
    notesVersion: 0,
    notes: [],
    events: [],
    lastActivityAt: NOW,
    createdAt: CREATED,
    ...over,
  })

  const agentStage = stage({ entryMode: 'agent', agentId: 'ag-1' })

  const seededView = (over: Partial<Seed> = {}): View => {
    const seeded = view({
      workflows: [workflow()],
      stages: [agentStage],
      agents: [agent()],
      runtimes: [runtime()],
      tasks: [task({ threadId: 'th-1' })],
      runs: [runRow()],
      ...over,
    })
    seeded.threads.set('th-1', threadRow())
    return seeded
  }

  it('run.receipt spawn：建子任务并挂父任务 / 继承线程（Agent 自报 parentTaskId 被忽略）', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [agentStage],
      agents: [agent()],
      runtimes: [runtime()],
      tasks: [task({ threadId: 'th-1' })],
      runs: [runRow()],
    })
    seeded.threads.set('th-1', threadRow())
    const decision = decide(
      seeded,
      host({
        type: 'run.receipt',
        runId: 'run-1',
        receipt: {
          status: 'succeeded',
          leaseId: 'run-1:1',
          turn: 1,
          spawn: [
            { subject: '实现登录页', key: 'a', parentTaskId: '伪造' } as never,
            { subject: '实现鉴权接口' },
          ],
        },
      }),
      NOW,
      env(),
    )
    const created = decision.facts
      .filter((fact) => fact.type === 'task.created')
      .map((fact) => (fact.payload as { task: Task }).task)
    expect(created).toHaveLength(2)
    expect(created[0]).toMatchObject({
      parentTaskId: 't-1',
      threadId: 'th-1',
      origin: 'spawn',
      spawnedByRunId: 'run-1',
      spawnKey: 'a',
      currentStageId: 'st-1',
    })
    // 子任务进入 agent 阶段 → 各自有 queued run
    expect(decision.facts.filter((fact) => fact.type === 'run.queued')).toHaveLength(2)
    // 回执终态照常落库
    expect(decision.facts.some((fact) => fact.type === 'run.succeeded')).toBe(true)
  })

  it('spawnPolicy=off 的阶段：回执 spawn 全部丢弃', () => {
    const seeded = seededView({
      stages: [stage({ entryMode: 'agent', agentId: 'ag-1', spawnPolicy: 'off' })],
    })
    const decision = decide(
      seeded,
      host({
        type: 'run.receipt',
        runId: 'run-1',
        receipt: {
          status: 'succeeded',
          leaseId: 'run-1:1',
          turn: 1,
          spawn: [{ subject: '不应创建' }],
        },
      }),
      NOW,
      env(),
    )
    expect(decision.facts.some((fact) => fact.type === 'task.created')).toBe(false)
  })

  it('task.create 带 parentTaskId：子任务继承父线程、parentTaskId 指父；父不存在/跨工作流/已完成被拒', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage()],
      tasks: [task({ threadId: 'th-1' })],
    })
    seeded.threads.set('th-1', threadRow())
    const ok = decide(
      seeded,
      command({
        type: 'task.create',
        input: { title: '子任务', workflowId: 'wf-1', projectId: 'pj-1', parentTaskId: 't-1' },
      }),
      NOW,
      env(),
    )
    const created = ok.facts.find((fact) => fact.type === 'task.created')
    expect((created?.payload as { task: Task }).task).toMatchObject({
      parentTaskId: 't-1',
      threadId: 'th-1',
    })
    expect(ok.facts.some((fact) => fact.type === 'thread.opened')).toBe(false)

    expect(
      decide(
        seeded,
        command({
          type: 'task.create',
          input: { title: '子任务', workflowId: 'wf-1', projectId: 'pj-1', parentTaskId: 'ghost' },
        }),
        NOW,
        env(),
      ),
    ).toEqual({ facts: [], reject: { code: 'not_found', message: '父任务不存在: ghost' } })

    const doneParent = view({
      workflows: [workflow()],
      stages: [stage()],
      tasks: [task({ status: 'completed' })],
    })
    expect(
      decide(
        doneParent,
        command({
          type: 'task.create',
          input: { title: '子任务', workflowId: 'wf-1', projectId: 'pj-1', parentTaskId: 't-1' },
        }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '父任务已完成，不能挂子任务: t-1' },
    })
  })

  it('子任务完成 → 父任务 rollup：全部子任务结束才产 children_settled + 唤醒父 Agent', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [agentStage],
      agents: [agent()],
      runtimes: [runtime()],
      tasks: [
        task({ id: 't-1', threadId: 'th-1' }),
        task({ id: 't-2', parentTaskId: 't-1', threadId: 'th-1', origin: 'spawn' }),
      ],
    })
    seeded.threads.set('th-1', threadRow({ taskIds: ['t-1', 't-2'] }))
    const decision = decide(seeded, command({ type: 'task.complete', id: 't-2' }), NOW, env())
    expect(decision.facts.some((fact) => fact.type === 'task.children_settled')).toBe(true)
    const wake = decision.facts.find((fact) => fact.type === 'run.queued')
    expect((wake?.payload as { run: { taskId: string } }).run.taskId).toBe('t-1')
  })

  it('删掉子任务同样触发 rollup；父任务已有活跃 run 时不重复触发', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [agentStage],
      agents: [agent()],
      runtimes: [runtime()],
      tasks: [
        task({ id: 't-1', threadId: 'th-1' }),
        task({ id: 't-2', parentTaskId: 't-1', threadId: 'th-1', origin: 'spawn' }),
      ],
      runs: [runRow({ id: 'run-parent', taskId: 't-1', status: 'running' })],
      active: ['t-1'],
    })
    seeded.threads.set('th-1', threadRow({ taskIds: ['t-1', 't-2'] }))
    const decision = decide(seeded, command({ type: 'task.remove', id: 't-2' }), NOW, env())
    expect(decision.facts.some((fact) => fact.type === 'task.removed')).toBe(true)
    // 父任务已有活跃 run → rollup 幂等跳过
    expect(decision.facts.some((fact) => fact.type === 'task.children_settled')).toBe(false)
  })

  it('task.create：父任务跨工作流被拒', () => {
    const seeded = view({
      workflows: [workflow(), workflow({ id: 'wf-2', name: '另一个流程' })],
      stages: [stage()],
      tasks: [task({ workflowId: 'wf-2' })],
    })
    expect(
      decide(
        seeded,
        command({
          type: 'task.create',
          input: { title: '子任务', workflowId: 'wf-1', projectId: 'pj-1', parentTaskId: 't-1' },
        }),
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '父任务不属于该工作流: t-1' },
    })
  })

  it('run.receipt 把子任务跑完 → 自动 rollup 父任务（级联）', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ entryMode: 'agent', agentId: 'ag-1' })],
      agents: [agent()],
      runtimes: [runtime()],
      tasks: [
        task({ id: 't-1', threadId: 'th-1' }),
        task({ id: 't-2', parentTaskId: 't-1', threadId: 'th-1', origin: 'spawn' }),
      ],
      runs: [runRow({ id: 'run-1', taskId: 't-2' })],
    })
    seeded.threads.set('th-1', threadRow({ taskIds: ['t-1', 't-2'] }))
    const decision = decide(
      seeded,
      host({
        type: 'run.receipt',
        runId: 'run-1',
        receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1 },
      }),
      NOW,
      env(),
    )
    expect(
      decision.facts.some(
        (fact) =>
          fact.type === 'task.completed' && (fact.payload as { task: Task }).task.id === 't-2',
      ),
    ).toBe(true)
    expect(decision.facts.some((fact) => fact.type === 'task.children_settled')).toBe(true)
    const wakeTaskIds = decision.facts
      .filter((fact) => fact.type === 'run.queued')
      .map((fact) => (fact.payload as { run: { taskId: string } }).run.taskId)
    expect(wakeTaskIds).toContain('t-1')
  })

  it('rollup 沿链级联：子任务完成 → 父完成任务 → 祖父完成任务', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ entryMode: 'agent', agentId: 'ag-1', onChildrenSettled: 'complete' })],
      agents: [agent()],
      runtimes: [runtime()],
      tasks: [
        task({ id: 'g' }),
        task({ id: 'p', parentTaskId: 'g', threadId: 'th-1' }),
        task({ id: 'c', parentTaskId: 'p', threadId: 'th-1', origin: 'spawn' }),
      ],
      runs: [runRow({ id: 'run-1', taskId: 'c' })],
    })
    seeded.threads.set('th-1', threadRow({ taskIds: ['g', 'p', 'c'] }))
    const decision = decide(
      seeded,
      host({
        type: 'run.receipt',
        runId: 'run-1',
        receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1 },
      }),
      NOW,
      env(),
    )
    const completedIds = decision.facts
      .filter((fact) => fact.type === 'task.completed')
      .map((fact) => (fact.payload as { task: Task }).task.id)
    expect(completedIds).toEqual(expect.arrayContaining(['c', 'p', 'g']))
  })

  it('还有兄弟子任务未终态：本次不 rollup（循环里跳过）', () => {
    const seeded = view({
      workflows: [workflow()],
      stages: [stage({ entryMode: 'agent', agentId: 'ag-1' })],
      agents: [agent()],
      runtimes: [runtime()],
      tasks: [
        task({ id: 't-1' }),
        task({ id: 't-2', parentTaskId: 't-1', threadId: 'th-1', origin: 'spawn' }),
        task({ id: 't-3', parentTaskId: 't-1', threadId: 'th-1', origin: 'spawn' }),
      ],
      runs: [runRow({ id: 'run-1', taskId: 't-2' })],
    })
    seeded.threads.set('th-1', threadRow({ taskIds: ['t-1', 't-2', 't-3'] }))
    const decision = decide(
      seeded,
      host({
        type: 'run.receipt',
        runId: 'run-1',
        receipt: { status: 'succeeded', leaseId: 'run-1:1', turn: 1 },
      }),
      NOW,
      env(),
    )
    expect(decision.facts.some((fact) => fact.type === 'task.children_settled')).toBe(false)
  })
})

describe('kernel/commands/workflow 阶段下标与文案比较', () => {
  it('indexTarget：下标 → 阶段 id；缺省与越界都归 null', () => {
    expect(indexTarget(['st-1', 'st-2'], 0)).toBe('st-1')
    expect(indexTarget(['st-1', 'st-2'], 1)).toBe('st-2')
    expect(indexTarget(['st-1', 'st-2'], null)).toBeNull()
    expect(indexTarget(['st-1', 'st-2'], undefined)).toBeNull()
    // 越界在产品路径上被 `validateStageSet` 先挡住，但判定本身必须能测
    expect(indexTarget(['st-1', 'st-2'], 9)).toBeNull()
  })

  it('sameInstructions：缺省与空串视为同值（改了「要干什么」要能存下去）', () => {
    expect(sameInstructions('', '')).toBe(true)
    expect(sameInstructions(undefined, '')).toBe(true)
    expect(sameInstructions(null, undefined)).toBe(true)
    expect(sameInstructions('干活', '干活')).toBe(true)
    expect(sameInstructions('干活', '')).toBe(false)
  })
})

describe('kernel/commands/task 人工跳转留痕的「自然去向」文案', () => {
  const flow = {
    ...workflow(),
    stages: [stage(), stage({ id: 'st-2', name: '实现', position: 1 })],
  }

  it('目标阶段还在：「自然去向」用它自己的名字', () => {
    expect(naturalStageLabel('st-2', flow)).toBe('实现')
  })

  it('没有下一阶段（自然去向是完成）：文案写「完成」', () => {
    expect(naturalStageLabel(null, flow)).toBe('完成')
  })

  it('目标阶段已不在工作流里（脏投影）：文案退「未知阶段」，不写空', () => {
    expect(naturalStageLabel('st-404', flow)).toBe('未知阶段')
  })
})
