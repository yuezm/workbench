import { describe, expect, it } from 'vitest'

import {
  ACCESS_LEVELS,
  ARGV_PLACEHOLDERS,
  CHAT_ROLES,
  ENTRY_MODES,
  ENTITY_TABLES,
  EXECUTOR_KEY_PATTERN,
  PERMISSION_MODES,
  PROBE_STATES,
  RUN_ERROR_CODES,
  RUN_EVENT_TYPES,
  RUN_PURPOSES,
  RUN_STATUSES,
  RUN_TERMINAL_STATUSES,
  TASK_STATUSES,
  type Access,
  type Agent,
  type AgentInput,
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
 */
const contractChecks: [
  Assert<Equal<Runtime['permissionMode'], PermissionMode>>,
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
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
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
  handoffWorkflowId: null,
  handoffStageId: null,
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
  access: 'edit',
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

  it('五张表的行字段与现有投影列（camelCase 映射）逐一对应', () => {
    expect(keysOf(sampleTask)).toEqual([
      'createdAt',
      'currentStageId',
      'description',
      'externalRef',
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
      'handoffStageId',
      'handoffWorkflowId',
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
      'id',
      'name',
      'runtimeId',
      'systemPrompt',
    ])
    expect(keysOf(sampleRuntime)).toEqual([
      'argsTemplate',
      'command',
      'createdAt',
      'enabled',
      'executorKey',
      'id',
      'lastProbe',
      'maxConcurrent',
      'model',
      'name',
      'permissionMode',
      'profile',
      'reasoningEffort',
      'workdir',
    ])
  })

  it('实体契约锁：字段与枚举/输入类型对应（类型级断言，M5 起 protocol 是唯一真相）', () => {
    expect(contractChecks).toHaveLength(26)
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
      'access',
      'attempt',
      'attempts',
      'cancelRequested',
      'conversationId',
      'cwd',
      'deadlineAt',
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
