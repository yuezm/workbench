/**
 * 命令契约：配置三组（workflow / agent / runtime）+ 任务四动作（M1）+ 卡片两条（M4）。
 *
 * 命令是宿主入口的输入（renderer → dispatch），不是 IPC 方法名本身：
 * 带 `commandId` 做幂等，形状由 `protocol/validate` 在写入前校验。
 * run / chat / rules / clock 等输入 M2 之后再迁入；`card.answer` 来自 owner（ui 或通道），
 * `card.resolve` 只来自 owner。
 */
import type {
  AgentInput,
  CardAnswerVia,
  RuntimeInput,
  RuntimeProbe,
  TaskInput,
  WorkflowInput,
} from './entities'

/** 命令名全集；决定面见 tasks/m1-plan.md「决策面」与 m4-plan「架构决议 D6」。 */
export const COMMAND_NAMES = [
  'workflow.create',
  'workflow.update',
  'workflow.remove',
  'agent.create',
  'agent.update',
  'agent.remove',
  'runtime.create',
  'runtime.update',
  'runtime.remove',
  'runtime.probed',
  'task.create',
  'task.move',
  'task.complete',
  'task.remove',
  'card.answer',
  'card.resolve',
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

interface CommandBase {
  /** 幂等键：重复提交返回原结果，不重复产事实 */
  commandId: string
}

// ---------- 工作流 ----------

export interface WorkflowCreateCommand extends CommandBase {
  type: 'workflow.create'
  input: WorkflowInput
}

export interface WorkflowUpdateCommand extends CommandBase {
  type: 'workflow.update'
  id: string
  /** 整份定义：阶段 id 稳定，按 id 差异发 stage.created / updated / deleted */
  input: WorkflowInput
}

export interface WorkflowRemoveCommand extends CommandBase {
  type: 'workflow.remove'
  id: string
}

// ---------- 智能体 ----------

export interface AgentCreateCommand extends CommandBase {
  type: 'agent.create'
  input: AgentInput
}

export interface AgentUpdateCommand extends CommandBase {
  type: 'agent.update'
  id: string
  patch: Partial<AgentInput>
}

export interface AgentRemoveCommand extends CommandBase {
  type: 'agent.remove'
  id: string
}

// ---------- 运行时 ----------

export interface RuntimeCreateCommand extends CommandBase {
  type: 'runtime.create'
  input: RuntimeInput
}

export interface RuntimeUpdateCommand extends CommandBase {
  type: 'runtime.update'
  id: string
  patch: Partial<RuntimeInput>
}

export interface RuntimeRemoveCommand extends CommandBase {
  type: 'runtime.remove'
  id: string
}

/** 探测结论单独入账（配置事实不携带探测结论） */
export interface RuntimeProbedCommand extends CommandBase {
  type: 'runtime.probed'
  id: string
  probe: RuntimeProbe
}

// ---------- 任务 ----------

export interface TaskCreateCommand extends CommandBase {
  type: 'task.create'
  input: TaskInput
}

export interface TaskMoveCommand extends CommandBase {
  type: 'task.move'
  id: string
  /** 人工拖拽落点即目标，不套用 on_complete / on_reject */
  stageId: string
}

export interface TaskCompleteCommand extends CommandBase {
  type: 'task.complete'
  id: string
}

export interface TaskRemoveCommand extends CommandBase {
  type: 'task.remove'
  id: string
}

// ---------- 卡片 ----------

/**
 * 回答一张 open 卡（M4）：宿主入口 / 通道插件提交，内核校验卡片存在、`status='open'`、
 * 选项下标合法、run 处于 `waiting`；重复/越界/已关闭一律 reject。
 * `via` 缺省 `ui`；通道回传时写 `channel`，记为 `card.answered.by`。
 */
export interface CardAnswerCommand extends CommandBase {
  type: 'card.answer'
  cardId: string
  /** 选项下标（0 基，须在卡片 `options` 范围内） */
  optionIndex: number
  via?: CardAnswerVia
}

/** 手动关闭一张卡片（悬空卡兜底）；不改变 run 状态。 */
export interface CardResolveCommand extends CommandBase {
  type: 'card.resolve'
  cardId: string
}

/** 全部命令的判别联合（`type` 是命令名）。 */
export type Command =
  | WorkflowCreateCommand
  | WorkflowUpdateCommand
  | WorkflowRemoveCommand
  | AgentCreateCommand
  | AgentUpdateCommand
  | AgentRemoveCommand
  | RuntimeCreateCommand
  | RuntimeUpdateCommand
  | RuntimeRemoveCommand
  | RuntimeProbedCommand
  | TaskCreateCommand
  | TaskMoveCommand
  | TaskCompleteCommand
  | TaskRemoveCommand
  | CardAnswerCommand
  | CardResolveCommand
