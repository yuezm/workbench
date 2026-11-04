/**
 * M1 覆盖的命令契约：配置三组（workflow / agent / runtime）+ 任务四动作。
 *
 * 命令是宿主入口的输入（renderer → dispatch），不是 IPC 方法名本身：
 * 带 `commandId` 做幂等，形状由 `protocol/validate` 在写入前校验。
 * run / chat / rules / clock 等输入 M2 之后再迁入。
 */
import type { AgentInput, RuntimeInput, RuntimeProbe, TaskInput, WorkflowInput } from './entities'

/** M1 命令名全集；决定面见 tasks/m1-plan.md「决策面」。 */
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

/** 全部 M1 命令的判别联合（`type` 是命令名）。 */
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
