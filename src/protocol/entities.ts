/**
 * 五张投影表（tasks / workflows / workflow_stages / agents / runtimes）的
 * 行类型与输入类型，以及命令/事实/视图共用的枚举常量。
 *
 * 契约层是 kernel 唯一允许依赖的模块（kernel 只 `import type`，运行期不依赖）；
 * `src/shared/ai-workflow-api.ts` 从这里 re-export 给 preload / renderer，
 * 因此字段名与仓库现有列映射必须逐字对应，IPC 形状不随本文件调整。
 */

/** 投影表白名单：重建只清这五张表，runs / run_events / 聊天表不在投影集内。 */
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
