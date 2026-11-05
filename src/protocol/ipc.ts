/**
 * IPC 契约（M5）：renderer 与 main 之间只剩三个动词。
 *
 * - `dispatch(command)`：唯一写入口，命令带 `commandId` 幂等；
 * - `query(view, params)`：唯一读入口，一次取一个视图切片；
 * - `subscribe(handler)`：变更推送（事实批次 + 聊天流旁路），只推「发生了什么」。
 *
 * 事实以摘要形式回给 renderer（`FactSummary`）：renderer 只做失效，不消费 payload；
 * 命令结果里的新建/更新实体放在 `value`，避免组件再从事实里猜 id。
 */
import type { Command } from './commands'
import type {
  Agent,
  Card,
  Conversation,
  RunEvent,
  Runtime,
  RuntimeProbe,
  Task,
  WorkflowWithStages,
} from './entities'
import type { FactType } from './facts'

/** 提交后回给 renderer 的事实摘要（不带 payload；顺序即 seq 顺序）。 */
export interface FactSummary {
  seq: number
  type: FactType
  at: string
}

/** 命令结果：本次提交的事实 + 命令对应的实体值（无实体时为 null）。 */
export interface DispatchResult<T = unknown> {
  facts: FactSummary[]
  value: T | null
}

/**
 * 命令 → `value` 类型。只有「创建 / 更新 / 回答 / 探测」这类调用方会用到返回值的命令
 * 有实体；删除类与批量动作为 `null`。
 */
export interface CommandResults {
  'workflow.create': WorkflowWithStages
  'workflow.update': WorkflowWithStages
  'workflow.remove': null
  'agent.create': Agent
  'agent.update': Agent
  'agent.remove': null
  'runtime.create': Runtime
  'runtime.update': Runtime
  'runtime.remove': null
  'runtime.probed': RuntimeProbe
  'task.create': Task
  'task.move': Task
  'task.complete': Task
  'task.remove': null
  'card.answer': Card
  'card.resolve': Card
  'chat.create': Conversation
  'chat.send': null
  'chat.remove': null
  'chat.cancel': null
  'app.event': null
}

export type CommandValue<T extends Command['type']> = CommandResults[T]

/** 某条命令的 dispatch 返回值类型（按 `type` 判别）。 */
export type CommandDispatchResult<C extends Command> = DispatchResult<CommandValue<C['type']>>

/** 事实批次：`seq` = 批内最后一条事实的 seq，`types` 去重（renderer 按它失效视图）。 */
export interface FactsEvent {
  kind: 'facts'
  seq: number
  types: FactType[]
}

/** 聊天流旁路：实时显示用，事实仍是数据源；`conversationId` 供 UI 过滤当前会话。 */
export interface StreamEvent {
  kind: 'stream'
  runId: string
  conversationId: string | null
  event: RunEvent
}

export interface StreamEndEvent {
  kind: 'stream-end'
  runId: string
  conversationId: string | null
}

/** main → renderer 的推送（subscribe 动词的唯一载荷）。 */
export type KernelEvent = FactsEvent | StreamEvent | StreamEndEvent

/** renderer → main 的 IPC 通道名（preload 与 main 共用，避免魔法字符串漂移）。 */
export const WORKBENCH_DISPATCH_CHANNEL = 'workbench:dispatch'
export const WORKBENCH_QUERY_CHANNEL = 'workbench:query'
/** main → renderer：`KernelEvent` 推送 */
export const WORKBENCH_EVENT_CHANNEL = 'workbench:kernel-event'
