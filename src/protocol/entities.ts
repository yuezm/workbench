/**
 * 投影表（tasks / workflows / workflow_stages / agents / runtimes，M2 起加
 * runs / run_events / conversations / messages）的行类型与输入类型，
 * 以及命令/事实/视图共用的枚举常量。
 *
 * 契约层是 kernel 唯一允许依赖的模块（kernel 只 `import type`，运行期不依赖）；
 * `src/shared/ai-workflow-api.ts` 从这里 re-export 给 preload / renderer，
 * 因此字段名与仓库现有列映射必须逐字对应，IPC 形状不随本文件调整。
 */

/**
 * 实体表白名单（M1 五张配置/任务表）：`snapshot.imported` 的实体表联合与
 * 导入校验用它。投影全集见 `kernel/types.ts` 的 `PROJECTION_TABLES`。
 */
export const ENTITY_TABLES = [
  'tasks',
  'workflows',
  'workflow_stages',
  'agents',
  'runtimes',
] as const

export type EntityTable = (typeof ENTITY_TABLES)[number]

// ---------- 运行时 ----------

/** 执行协议族；新增协议 = 新增后端实现，不改 UI 契约 */
export const PROTOCOL_FAMILIES = ['dsh'] as const

export type RuntimeProtocolFamily = (typeof PROTOCOL_FAMILIES)[number]

/** 非交互权限：stdio 传输没有审批往返，越界操作直接失败 */
export const PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** 运行时健康状态（持久化的是最近一次探测结论） */
export const PROBE_STATES = ['ready', 'unavailable'] as const

export type RuntimeProbeState = (typeof PROBE_STATES)[number]

/** 一次探测的结论（--probe 帧 + CLI 版本 + 可执行文件解析） */
export interface RuntimeProbe {
  state: RuntimeProbeState
  /** 解析到的可执行文件绝对路径；解析失败为 null */
  path: string | null
  /** CLI 版本（dsh --version）；读不到为 null */
  cliVersion: string | null
  /** 协议版本（--probe 帧的 protocol_version）；失败为 null */
  protocolVersion: number | null
  /** 协议插件版本（--probe 帧的 plugin_version，可空） */
  pluginVersion: string | null
  /** 失败原因；ready 时为 null */
  error: string | null
  /** 输出尾部（诊断用，已截断） */
  output: string
  /** 探测耗时（毫秒） */
  elapsedMs: number
  /** 探测完成时间（ISO） */
  checkedAt: string
}

/** 运行时配置（本机执行环境实例） */
export interface Runtime {
  id: string
  name: string
  protocolFamily: RuntimeProtocolFamily
  /** 启动命令：命令名或绝对路径（默认 dsh） */
  command: string
  /** 协议 profile（默认 multica，由该 profile 提供 --stdio/--probe） */
  profile: string
  permissionMode: PermissionMode
  /** 模型 id（provider/model 形式）；null = 用 CLI 默认模型 */
  model: string | null
  /** 推理强度；null = 用模型默认 */
  reasoningEffort: string | null
  /** 执行工作目录；null = 主进程当前目录 */
  workdir: string | null
  /** 并发上限（同一运行时同时执行的任务数） */
  maxConcurrent: number
  /** 停用后不再派发执行 */
  enabled: boolean
  createdAt: string
  /** 最近一次探测结论；从未探测为 null */
  lastProbe: RuntimeProbe | null
}

export interface RuntimeInput {
  name: string
  protocolFamily?: RuntimeProtocolFamily
  command?: string
  profile?: string
  permissionMode?: PermissionMode
  model?: string | null
  reasoningEffort?: string | null
  workdir?: string | null
  maxConcurrent?: number
  enabled?: boolean
}

// ---------- 智能体 ----------

export interface Agent {
  id: string
  name: string
  description: string
  runtimeId: string
  systemPrompt: string
  createdAt: string
}

export interface AgentInput {
  name: string
  description?: string
  runtimeId: string
  systemPrompt?: string
}

// ---------- 工作流 / 阶段 ----------

/** 阶段入口模式：none = 停留，agent = 交给阶段绑定的智能体，user = 等人 */
export const ENTRY_MODES = ['none', 'agent', 'user'] as const

export type EntryMode = (typeof ENTRY_MODES)[number]

export interface WorkflowStage {
  id: string
  workflowId: string
  name: string
  position: number
  entryMode: EntryMode
  agentId: string | null
  onCompleteStageId: string | null
  onRejectStageId: string | null
}

export interface StageInput {
  /** 更新时回传既有阶段 id（保留历史、不重建）；新建时忽略 */
  id?: string
  name: string
  entryMode: EntryMode
  agentId?: string | null
  /** 完成后进入：目标阶段在 stages 数组中的下标；null/undefined = 默认（下一阶段 / 终端） */
  onCompleteIndex?: number | null
  /** 打回时退回到：目标阶段下标；null/undefined = 默认（上一阶段 / 原地） */
  onRejectIndex?: number | null
}

export interface Workflow {
  id: string
  name: string
  description: string
  createdAt: string
}

export interface WorkflowWithStages extends Workflow {
  stages: WorkflowStage[]
}

export interface WorkflowInput {
  name: string
  description?: string
  stages: StageInput[]
}

// ---------- 任务 ----------

/** 任务状态：active = 看板上进行中，completed = 移出看板 */
export const TASK_STATUSES = ['active', 'completed'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export interface Task {
  id: string
  title: string
  description: string
  workflowId: string
  currentStageId: string | null
  status: TaskStatus
  createdAt: string
  updatedAt: string
}

export interface TaskInput {
  title: string
  description?: string
  workflowId: string
  /** 起始阶段；缺省为首阶段 */
  stageId?: string
}

// ---------- 运行 ----------

/**
 * 运行状态：`waiting` = 回执带 `ask[]` 挂起等回答（释放租约与并发位，但仍算「执行中」）。
 * 取值顺序即 UI/文档的展示顺序，`queued` → `running` → 终态，`waiting` 是运行中的一种。
 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
] as const

export type RunStatus = (typeof RUN_STATUSES)[number]

/** 终态子集：执行器回执与宿主兜底只能落到这三个。 */
export const RUN_TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const

export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number]

/**
 * 运行失败归类：UI 按此给出可操作提示。
 * `executor_lost` 是 M2 新增的第 10 个取值（租约过期达 `maxAttempts` 后宿主兜底），
 * 只增不改，语义见 SPEC-kernel「调度」。
 */
export const RUN_ERROR_CODES = [
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
] as const

export type RunErrorCode = (typeof RUN_ERROR_CODES)[number]

/** 运行目的：`stage` = 阶段执行（挂任务），`chat` = 聊天轮次（挂对话）。 */
export const RUN_PURPOSES = ['stage', 'chat'] as const

export type RunPurpose = (typeof RUN_PURPOSES)[number]

/** 运行事件类型（协议帧归一后的增量类型） */
export const RUN_EVENT_TYPES = ['status', 'text', 'thinking', 'tool_call', 'tool_result'] as const

export type RunEventType = (typeof RUN_EVENT_TYPES)[number]

/** 运行事件（协议帧归一）；IPC 事件流与 `run.frames` 事实的帧共用这一形状。 */
export interface RunEvent {
  seq: number
  type: RunEventType
  /** text / thinking 的增量文本 */
  text?: string
  /** tool_call / tool_result 的工具名 */
  tool?: string
  /** tool_call / tool_result 的调用 id */
  callId?: string
  /** tool_call 的参数（JSON 字符串） */
  input?: string
  /** tool_result 的输出 */
  output?: string
  /** tool_result 是否失败 */
  isError?: boolean
  /** status 事件的阶段文案（如 running） */
  status?: string
}

/**
 * `run_events` 投影行：事件挂到 run 上。
 * 事实里 `run.frames` 的帧已由宿主按 run 分配全局单调 `seq`（D6），
 * 所以主键是 `(runId, seq)`，`Change.key = '<runId>:<seq>'`。
 */
export interface RunEventRow extends RunEvent {
  runId: string
}

/** 一次运行的 token 用量（按协议帧累加；终态事实携带最终值覆盖） */
export interface RunUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * IPC 运行行（renderer / preload 看到的 `Run`）：字段与 M1 完全一致，IPC 形状不变。
 * 投影行在它之上多了调度列（见 `RunRow`），调度列不外露给 IPC。
 */
export interface Run {
  id: string
  taskId: string
  stageId: string | null
  agentId: string | null
  /** 执行该 run 的运行时（运行时被删后置空） */
  runtimeId: string | null
  status: RunStatus
  prompt: string
  /** 最终文本输出（事件流的 text 汇总） */
  output: string
  error: string | null
  errorCode: RunErrorCode | null
  /** CLI 进程退出码；未能启动或超时后强杀为 null */
  exitCode: number | null
  /** 协议会话 id（可用于续接） */
  sessionId: string | null
  usage: RunUsage | null
  /** 执行耗时（毫秒） */
  durationMs: number | null
  startedAt: string | null
  endedAt: string | null
  createdAt: string
}

/**
 * `runs` 投影行：IPC 行 + 调度状态。
 *
 * - `taskId` 可空：聊天 run 不挂任务（D8；`runs.byTask` 只返回 `purpose='stage'`）。
 * - `attempt` = 当前第几次领取（1 基，来自 `run.claimed`）；
 *   `attempts` = 累计失败次数（来自 `run.abandoned`，达到 `maxAttempts` 落终态）。
 */
export interface RunRow extends Omit<Run, 'taskId'> {
  purpose: RunPurpose
  taskId: string | null
  /** 聊天 run 挂的对话；阶段 run 为 null */
  conversationId: string | null
  /** 命中/触发来源（阶段 run 记规则版本；手工任务为 null/0） */
  ruleId: string | null
  rulesVersion: number
  /** 执行器键（M2 仍按协议族推导；M3 换成运行时配置的 executorKey） */
  executorKey: string
  threadId: string | null
  /** 执行目录与权限（来自运行时/阶段配置，不由事件携带） */
  cwd: string
  access: Access
  skill: string | null
  /** 提示词里的资料文件引用（不是指令） */
  promptRef: string | null
  /** 触发本轮的原始事件 id（合并入口） */
  eventIds: string[]
  /** 跳数（事件被 Agent 再派生的层数） */
  hops: number
  /** 第几轮（续接递增，1 基） */
  turn: number
  /** 上一轮的协议会话 id；首轮为 null */
  resumeSessionId: string | null
  threadContextRef: string | null
  /** 入队事实的 seq（领取 FIFO 的稳定序号；由 `project` 在 run.queued 时写入） */
  queueSeq: number
  /** 本次领取凭证 `<runId>:<attempt>`；未领取/终态为 null */
  leaseId: string | null
  attempt: number
  attempts: number
  leaseUntil: string | null
  /** 最早可领取时刻（退避 / 等待回答后续接）；null = 立即可领 */
  notBefore: string | null
  /** 运行超时时刻（领取时写 `now + runTimeoutMs`，D5） */
  deadlineAt: string | null
  /** 已请求取消（`run.cancel_requested`），宿主管完终止流程后落终态 */
  cancelRequested: boolean
}

/** 运行权限级别（协议帧 access 语义；与运行时 `permissionMode` 不是一回事）。 */
export const ACCESS_LEVELS = ['read', 'edit', 'full'] as const

export type Access = (typeof ACCESS_LEVELS)[number]

// ---------- 对话 / 消息 ----------

/** 消息角色：user = 人发的，assistant = 智能体回的 */
export const CHAT_ROLES = ['user', 'assistant'] as const

export type ChatRole = (typeof CHAT_ROLES)[number]

/** 一段独立对话：绑定一个智能体，与工作流/任务无关（`purpose='chat'` 的 run 挂在它上面） */
export interface Conversation {
  id: string
  title: string
  agentId: string
  /** 上一轮的协议会话 id；下一轮用它续接，避免整段历史重发 */
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

/** 一条聊天消息；`runId` 只出现在 `message.appended` 事实里（对话轮次归属），不进投影行 */
export interface Message {
  id: string
  conversationId: string
  role: ChatRole
  content: string
  /** 该条助手消息的失败原因（非零退出 / 超时 / 取消）；成功与用户消息为 null */
  error: string | null
  createdAt: string
}
