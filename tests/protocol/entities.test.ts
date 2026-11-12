import { describe, expect, it } from 'vitest'

import {
  ACCESS_BY_PERMISSION,
  ACCESS_LEVELS,
  AGENT_ENV_LIMITS,
  ARGV_PLACEHOLDERS,
  BUILTIN_STAGE_KEYS,
  BUILTIN_STAGE_NAMES,
  CHAT_ROLES,
  ENTRY_MODES,
  ENTITY_TABLES,
  ENV_KEY_PATTERN,
  EXECUTOR_KEY_PATTERN,
  PERMISSION_MODES,
  PROBE_STATES,
  RUN_ERROR_CODES,
  RUN_EVENT_TYPES,
  RUN_PURPOSES,
  RUN_STATUSES,
  RUN_TERMINAL_STATUSES,
  STAGE_KINDS,
  TASK_STATUSES,
  builtinStageKind,
  isBuiltinStageName,
  normalizeDeliverables,
  permissionModeOfAccess,
  stageKindOf,
  type Access,
  type Agent,
  type AgentInput,
  type BuiltinStageKey,
  type Card,
  type CardDelivery,
  type CardStatus,
  type ChatRole,
  type Conversation,
  type EntryMode,
  type Message,
  type PermissionMode,
  type Run,
  type RunErrorCode,
  type RunEvent,
  type RunEventRow,
  type RunEventType,
  type RunPurpose,
  type RunRow,
  type RunStatus,
  type RunTerminalStatus,
  type RunUsage,
  type Runtime,
  type RuntimeInput,
  type RuntimeProbe,
  type RuntimeProbeState,
  type StageInput,
  type StageKind,
  type Task,
  type TaskInput,
  type TaskStatus,
  type Workflow,
  type WorkflowInput,
  type WorkflowStage,
  type WorkflowWithStages,
} from '../../src/protocol/entities'

/** 类型相等断言：A 与 B 必须逐字段相同（任一侧多/少字段都会失败）。 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

/**
 * 实体契约锁（M5：`shared/ai-workflow-api.ts` 已删除，protocol/entities 是唯一真相）。
 * 这里逐项锁定「实体字段与枚举/输入类型的对应关系」，防止字段类型被悄悄放宽。
 *
 * 执行配置归智能体后，模型 / 思考强度 / 并发 / 访问权限 / 工作目录 / 环境变量都挂在
 * `Agent` 上（运行时只剩连接字段），所以这几个断言的目标从 `Runtime` 换成 `Agent`。
 */
const contractChecks: [
  Assert<Equal<Agent['model'], string | null>>,
  Assert<Equal<Agent['reasoningEffort'], string | null>>,
  Assert<Equal<Agent['maxConcurrent'], number>>,
  Assert<Equal<Agent['permissionMode'], PermissionMode>>,
  Assert<Equal<Agent['workdir'], string | null>>,
  Assert<Equal<Agent['env'], Record<string, string>>>,
  Assert<Equal<AgentInput['env'], Record<string, string> | undefined>>,
  Assert<Equal<RuntimeProbe['state'], RuntimeProbeState>>,
  Assert<Equal<Runtime['lastProbe'], RuntimeProbe | null>>,
  Assert<Equal<RuntimeInput['executorKey'], string | undefined>>,
  Assert<Equal<Agent['runtimeId'], string>>,
  Assert<Equal<AgentInput['runtimeId'], string>>,
  Assert<Equal<WorkflowStage['entryMode'], EntryMode>>,
  Assert<Equal<StageInput['entryMode'], EntryMode>>,
  Assert<Equal<WorkflowWithStages['stages'], WorkflowStage[]>>,
  Assert<Equal<WorkflowInput['stages'], StageInput[]>>,
  Assert<Equal<Workflow['id'], string>>,
  Assert<Equal<Task['status'], TaskStatus>>,
  Assert<Equal<TaskInput['workflowId'], string>>,
  Assert<Equal<Run['status'], RunStatus>>,
  Assert<Equal<NonNullable<Run['errorCode']>, RunErrorCode>>,
  Assert<Equal<RunEvent['type'], RunEventType>>,
  Assert<Equal<NonNullable<Run['usage']>, RunUsage>>,
  Assert<Equal<RunPurpose, 'stage' | 'chat'>>,
  Assert<Equal<TaskStatus, (typeof TASK_STATUSES)[number]>>,
  Assert<Equal<Conversation['agentId'], string>>,
  Assert<Equal<Message['role'], ChatRole>>,
  Assert<Equal<RunRow['purpose'], RunPurpose>>,
  Assert<Equal<RunRow['taskId'], string | null>>,
  Assert<Equal<RunEventRow['type'], RunEventType>>,
  Assert<Equal<Card['status'], CardStatus>>,
  Assert<Equal<Card['delivery'], CardDelivery>>,
  Assert<Equal<NonNullable<WorkflowStage['builtin']>, BuiltinStageKey>>,
  Assert<Equal<NonNullable<StageInput['builtin']>, BuiltinStageKey>>,
  Assert<Equal<StageKind, (typeof STAGE_KINDS)[number]>>,
  Assert<Equal<BuiltinStageKey, (typeof BUILTIN_STAGE_KEYS)[number]>>,
  // 权限模式 → 运行权限级别：派活写 `run.access`、执行器反查 CLI 参数都走这张表
  Assert<Equal<(typeof ACCESS_BY_PERMISSION)[PermissionMode], Access>>,
  Assert<Equal<ReturnType<typeof permissionModeOfAccess>, PermissionMode>>,
  // 环境变量上限是常量（协议层与 UI 共用），不是散落的字面量
  Assert<Equal<(typeof AGENT_ENV_LIMITS)['maxVars'], 32>>,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
]

/**
 * IPC 形状锁定：`Run` / `RunEvent` 是 M1 就发给 renderer 的类型，
 * 字段名与可空性必须与旧定义逐字一致（调度列在 `RunRow` 上，不外露）。
 */
interface ExpectedIpcRun {
  id: string
  taskId: string
  stageId: string | null
  agentId: string | null
  runtimeId: string | null
  status: RunStatus
  prompt: string
  output: string
  error: string | null
  errorCode: RunErrorCode | null
  exitCode: number | null
  sessionId: string | null
  usage: RunUsage | null
  durationMs: number | null
  /** 本轮实际权限（M28：闸门阶段由内核抬到 full，所以它不等于智能体上配的 permissionMode） */
  access: Access
  startedAt: string | null
  endedAt: string | null
  createdAt: string
}

interface ExpectedIpcRunEvent {
  seq: number
  type: RunEventType
  text?: string
  tool?: string
  callId?: string
  input?: string
  output?: string
  isError?: boolean
  status?: string
}

const ipcShapeChecks: [
  Assert<Equal<Run, ExpectedIpcRun>>,
  Assert<Equal<RunEvent, ExpectedIpcRunEvent>>,
  // 投影行 = IPC 行 + 调度列；`taskId` 在投影里可空（聊天 run 不挂任务）
  Assert<Equal<RunRow['purpose'], RunPurpose>>,
  Assert<Equal<RunRow['taskId'], string | null>>,
] = [true, true, true, true]

const runShapeChecks: [
  Assert<Equal<RunTerminalStatus, 'succeeded' | 'failed' | 'cancelled'>>,
  Assert<Equal<Access, 'read' | 'edit' | 'full'>>,
] = [true, true]

const sampleRuntime = {
  id: 'rt1',
  name: '本机 dsh',
  executorKey: 'dsh',
  command: 'dsh',
  profile: 'multica',
  argsTemplate: '',
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastProbe: null,
} satisfies Runtime

const sampleAgent = {
  id: 'ag1',
  name: '实现者',
  description: '',
  runtimeId: 'rt1',
  systemPrompt: '',
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: '2026-01-01T00:00:00.000Z',
} satisfies Agent

const sampleStage = {
  id: 'st1',
  workflowId: 'wf1',
  name: '待办',
  position: 0,
  entryMode: 'none',
  agentId: null,
  onCompleteStageId: null,
  onRejectStageId: null,
  handoffs: [],
} satisfies WorkflowStage

const sampleWorkflow = {
  id: 'wf1',
  name: '默认流程',
  description: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  stages: [sampleStage],
} satisfies WorkflowWithStages

const sampleTask = {
  id: 't1',
  title: '写计划',
  description: '',
  workflowId: 'wf1',
  projectId: 'pj1',
  currentStageId: 'st1',
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
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies Task

const sampleRun = {
  id: 'run-1',
  taskId: 't1',
  stageId: 'st1',
  agentId: 'ag1',
  runtimeId: 'rt1',
  status: 'running',
  prompt: '提示词',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  access: 'edit',
  startedAt: null,
  endedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
} satisfies Run

const sampleRunRow = {
  ...sampleRun,
  purpose: 'stage',
  conversationId: null,
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'dsh',
  threadId: null,
  cwd: 'D:/work',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 1,
  leaseId: 'run-1:1',
  attempt: 1,
  attempts: 0,
  leaseUntil: '2026-01-01T00:02:00.000Z',
  notBefore: null,
  deadlineAt: '2026-01-01T00:30:00.000Z',
  cancelRequested: false,
  deliverables: null,
} satisfies RunRow

const sampleRunEvent = {
  runId: 'run-1',
  seq: 1,
  type: 'text',
  text: 'hi',
} satisfies RunEventRow

const sampleConversation = {
  id: 'cv1',
  title: '新对话',
  agentId: 'ag1',
  projectId: null,
  sessionId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies Conversation

const sampleMessage = {
  id: 'm1',
  conversationId: 'cv1',
  role: 'user',
  content: '你好',
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
} satisfies Message

const keysOf = (row: object): string[] => Object.keys(row).sort()

describe('protocol/entities', () => {
  it('ENTITY_TABLES 只含五张投影表，顺序稳定且不重复', () => {
    expect([...ENTITY_TABLES]).toEqual([
      'tasks',
      'workflows',
      'workflow_stages',
      'agents',
      'runtimes',
    ])
    expect(new Set(ENTITY_TABLES).size).toBe(ENTITY_TABLES.length)
  })

  it('枚举常量是校验与代理共用的唯一取值来源', () => {
    expect(EXECUTOR_KEY_PATTERN.test('dsh')).toBe(true)
    expect(EXECUTOR_KEY_PATTERN.test('command')).toBe(true)
    expect(EXECUTOR_KEY_PATTERN.test('Dsh')).toBe(false)
    expect(EXECUTOR_KEY_PATTERN.test('a'.repeat(65))).toBe(false)
    expect([...ARGV_PLACEHOLDERS]).toEqual(['model', 'effort', 'cwd', 'context', 'prompt'])
    expect([...PERMISSION_MODES]).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    expect([...PROBE_STATES]).toEqual(['ready', 'unavailable'])
    expect([...ENTRY_MODES]).toEqual(['none', 'agent', 'user'])
    expect([...TASK_STATUSES]).toEqual(['active', 'completed'])
    expect([...RUN_STATUSES]).toEqual([
      'queued',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'cancelled',
    ])
    expect([...RUN_TERMINAL_STATUSES]).toEqual(['succeeded', 'failed', 'cancelled'])
    expect([...RUN_ERROR_CODES]).toEqual([
      'spawn_failed',
      'exit_nonzero',
      'run_failed',
      'timeout',
      'cancelled',
      'protocol_error',
      'no_result',
      'runtime_missing',
      'runtime_disabled',
      'executor_lost',
    ])
    expect([...RUN_PURPOSES]).toEqual(['stage', 'chat'])
    expect([...RUN_EVENT_TYPES]).toEqual(['status', 'text', 'thinking', 'tool_call', 'tool_result'])
    expect([...CHAT_ROLES]).toEqual(['user', 'assistant'])
    expect([...ACCESS_LEVELS]).toEqual(['read', 'edit', 'full'])
  })

  it('M2 新增取值只增不改：waiting 与 executor_lost 追加在末尾', () => {
    expect(RUN_STATUSES.indexOf('waiting')).toBe(2)
    expect(RUN_ERROR_CODES.indexOf('executor_lost')).toBe(RUN_ERROR_CODES.length - 1)
  })

  it('执行配置归属智能体：权限模式与环境变量的唯一取值口径', () => {
    // 派活：智能体的 permissionMode → run.access；执行器：Turn.access → CLI 权限参数
    expect(ACCESS_BY_PERMISSION).toEqual({
      'read-only': 'read',
      'workspace-write': 'edit',
      'danger-full-access': 'full',
    })
    for (const access of ACCESS_LEVELS) {
      expect(ACCESS_BY_PERMISSION[permissionModeOfAccess(access)]).toBe(access)
    }
    // 不在表里的级别按可写处理（协议帧缺字段时不放大权限）
    expect(permissionModeOfAccess('edit')).toBe('workspace-write')

    expect(ENV_KEY_PATTERN.test('HTTP_PROXY')).toBe(true)
    expect(ENV_KEY_PATTERN.test('_A1')).toBe(true)
    expect(ENV_KEY_PATTERN.test('1A')).toBe(false)
    expect(ENV_KEY_PATTERN.test('A-B')).toBe(false)
    expect(ENV_KEY_PATTERN.test('A B')).toBe(false)
    expect(AGENT_ENV_LIMITS).toEqual({ maxVars: 32, maxKeyChars: 64, maxValueChars: 1000 })
  })

  it('五张表的行字段与现有投影列（camelCase 映射）逐一对应', () => {
    expect(keysOf(sampleTask)).toEqual([
      'createdAt',
      'currentStageId',
      'description',
      'externalRef',
      'handoffFromRunId',
      'handoffFromStageId',
      'handoffFromTaskId',
      'id',
      'labels',
      'origin',
      'parentTaskId',
      'projectId',
      'ruleId',
      'status',
      'threadId',
      'title',
      'updatedAt',
      'workflowId',
    ])
    expect(keysOf(sampleWorkflow)).toEqual(['createdAt', 'description', 'id', 'name', 'stages'])
    expect(keysOf(sampleStage)).toEqual([
      'agentId',
      'entryMode',
      'handoffs',
      'id',
      'name',
      'onCompleteStageId',
      'onRejectStageId',
      'position',
      'workflowId',
    ])
    expect(keysOf(sampleAgent)).toEqual([
      'createdAt',
      'description',
      'env',
      'id',
      'maxConcurrent',
      'model',
      'name',
      'permissionMode',
      'reasoningEffort',
      'runtimeId',
      'systemPrompt',
      'workdir',
    ])
    expect(keysOf(sampleRuntime)).toEqual([
      'argsTemplate',
      'command',
      'createdAt',
      'enabled',
      'executorKey',
      'id',
      'lastProbe',
      'name',
      'profile',
    ])
  })

  it('实体契约锁：字段与枚举/输入类型对应（类型级断言，M5 起 protocol 是唯一真相）', () => {
    expect(contractChecks).toHaveLength(39)
    expect(contractChecks.every(Boolean)).toBe(true)
  })

  it('IPC 形状锁定：Run / RunEvent 与旧定义逐字段一致', () => {
    expect(ipcShapeChecks.every(Boolean)).toBe(true)
    expect(runShapeChecks.every(Boolean)).toBe(true)
  })

  it('投影行 = IPC 行 + 调度列（租约 / 尝试 / 退避 / 超时 / 取消 / 入队上下文）', () => {
    expect(keysOf(sampleRunRow)).toEqual([
      'access',
      'agentId',
      'attempt',
      'attempts',
      'cancelRequested',
      'conversationId',
      'createdAt',
      'cwd',
      'deadlineAt',
      'deliverables',
      'durationMs',
      'endedAt',
      'error',
      'errorCode',
      'eventIds',
      'executorKey',
      'exitCode',
      'hops',
      'id',
      'leaseId',
      'leaseUntil',
      'notBefore',
      'output',
      'prompt',
      'promptRef',
      'purpose',
      'queueSeq',
      'resumeSessionId',
      'ruleId',
      'rulesVersion',
      'runtimeId',
      'sessionId',
      'skill',
      'stageId',
      'startedAt',
      'status',
      'taskId',
      'threadContextRef',
      'threadId',
      'turn',
      'usage',
    ])
    const runKeys = new Set(keysOf(sampleRun))
    const schedulingKeys = keysOf(sampleRunRow).filter((key) => !runKeys.has(key))
    expect(schedulingKeys).toEqual([
      'attempt',
      'attempts',
      'cancelRequested',
      'conversationId',
      'cwd',
      'deadlineAt',
      'deliverables',
      'eventIds',
      'executorKey',
      'hops',
      'leaseId',
      'leaseUntil',
      'notBefore',
      'promptRef',
      'purpose',
      'queueSeq',
      'resumeSessionId',
      'ruleId',
      'rulesVersion',
      'skill',
      'threadContextRef',
      'threadId',
      'turn',
    ])
  })

  it('运行事件投影行带 runId（键是 `<runId>:<seq>`），对话/消息行对应旧聊天表列', () => {
    expect(keysOf(sampleRunEvent)).toEqual(['runId', 'seq', 'text', 'type'])
    expect(keysOf(sampleConversation)).toEqual([
      'agentId',
      'createdAt',
      'id',
      'projectId',
      'sessionId',
      'title',
      'updatedAt',
    ])
    expect(keysOf(sampleMessage)).toEqual([
      'content',
      'conversationId',
      'createdAt',
      'error',
      'id',
      'role',
    ])
  })
})

describe('protocol/entities 内置阶段（M18）', () => {
  it('四个内置键、固定名称与类别映射', () => {
    expect(BUILTIN_STAGE_KEYS).toEqual(['todo', 'blocked', 'done', 'cancelled'])
    expect(BUILTIN_STAGE_NAMES).toEqual({
      todo: '待办',
      blocked: '已阻塞',
      done: '已完成',
      cancelled: '已取消',
    })
    expect(BUILTIN_STAGE_KEYS.map((key) => builtinStageKind(key))).toEqual([
      'pending',
      'active',
      'done',
      'closed',
    ])
    expect(STAGE_KINDS).toEqual(['pending', 'active', 'done', 'closed'])
  })

  it('stageKindOf：内置按键取，自己添加的阶段一律「进行中」', () => {
    expect(stageKindOf({ builtin: 'todo' })).toBe('pending')
    expect(stageKindOf({ builtin: 'cancelled' })).toBe('closed')
    expect(stageKindOf({ builtin: null })).toBe('active')
    expect(stageKindOf({})).toBe('active')
  })

  it('isBuiltinStageName：去首尾空白后匹配，非内置名返回 false', () => {
    expect(isBuiltinStageName(' 已完成 ')).toBe(true)
    expect(isBuiltinStageName('开发')).toBe(false)
  })
})

describe('normalizeDeliverables（回执输入 → 落库形态）', () => {
  it('五项齐全时原样（数组是副本，不与入参共享引用）', () => {
    const commits = ['57be895']
    const normalized = normalizeDeliverables({
      branch: 'feat/x',
      base: 'develop',
      commits,
      files: ['src/a.ts'],
      gates: [{ cmd: 'pnpm check', exitCode: 0 }],
    })
    expect(normalized).toEqual({
      branch: 'feat/x',
      base: 'develop',
      commits: ['57be895'],
      files: ['src/a.ts'],
      gates: [{ cmd: 'pnpm check', exitCode: 0 }],
    })
    expect(normalized.commits).not.toBe(commits)
  })

  it('省略项 / null 一律补齐：null 保持 null，数组补空', () => {
    expect(normalizeDeliverables({})).toEqual({
      branch: null,
      base: null,
      commits: [],
      files: [],
      gates: [],
    })
    expect(normalizeDeliverables({ branch: null, commits: [] }).branch).toBeNull()
  })
})
