/**
 * 卡片上下文（M54）：把「这张卡属于哪件活」从投影里查出来，随卡片一起交给通道。
 *
 * 为什么在宿主算：`Card` 只有 `taskId` / `conversationId` 两个弱引用，项目名、任务标题、
 * 阶段名、智能体名都在投影里，而通道插件拿不到投影（也不该拿）。卡片标题是智能体写的
 * 自由文本，IM 里只看到「覆盖率棘轮红：打回补测还是接受现状？」时，收卡的人无法判断这是
 * 哪个项目、哪条任务、谁在问——「不知道该怎么回答」就是这一句的代价。
 *
 * 边界：
 * - **只读**：只查视图，不写库、不产事实；
 * - **best-effort**：任何一次查询失败 / 形状不对都当「这一项没有」，字段为 null；
 *   上下文读不到绝不能拖累投递（卡片本身仍然是可答的）；
 * - 全部字段为 null 时返回 null：没有可展示的上下文就别在消息里留空行。
 */
import type {
  Agent,
  Card,
  Project,
  RunRow,
  Task,
  WorkflowWithStages,
} from '@workbench/protocol/entities'
import type { CardContext } from '@workbench/protocol/channels'
import type { ViewId, ViewParams, ViewResult } from '@workbench/protocol/views'

/** 只需要读能力（与 `host/channels` 的 `ChannelsStore` 同形，但不反向依赖它）。 */
export interface CardContextStore {
  query<T extends ViewId>(view: T, params?: ViewParams<T>): ViewResult<T>
}

/** 一次查询：抛错当没有（上下文不是投递的前置条件）。 */
function read(run: () => unknown): unknown {
  try {
    return run()
  } catch {
    return null
  }
}

/** 非空字符串才算有值（空串当没有，免得在消息里留「项目：」）。 */
function nameOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 只认非数组对象：视图给 null、或假 store 给了别的形状时一律当没有。 */
function recordOf<T>(value: unknown): T | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as T) : null
}

/** 在列表里按 id 找一条；id 缺失 / 列表形状不对 → null。 */
function findById<T extends { id: string }>(list: unknown, id: string | null): T | null {
  if (id === null || !Array.isArray(list)) return null
  return (list as T[]).find((item) => recordOf<T>(item)?.id === id) ?? null
}

/**
 * 这张卡的归属上下文：项目 / 任务 / 会话 / 阶段 / 智能体。
 *
 * 阶段 run 看任务那一侧（项目 + 任务 + 阶段 + 本轮智能体），聊天 run 看会话那一侧
 * （会话标题 + 本轮智能体）——两侧都没有时返回 null。
 */
export function cardContextOf(store: CardContextStore, card: Card): CardContext | null {
  const taskId = nameOf(card.taskId)
  const task =
    taskId === null ? null : recordOf<Task>(read(() => store.query('task.byId', { taskId })))
  const run = recordOf<RunRow>(read(() => store.query('run.byId', { runId: card.runId })))
  const conversationId = nameOf(card.conversationId)
  const conversation =
    conversationId === null
      ? null
      : findById<{ id: string; title: string }>(
          read(() => store.query('conversations.all')),
          conversationId,
        )

  const projectName =
    task === null
      ? null
      : nameOf(
          findById<Project>(
            read(() => store.query('projects.all')),
            nameOf(task.projectId),
          )?.name,
        )

  const workflow =
    task === null
      ? null
      : findById<WorkflowWithStages>(
          read(() => store.query('workflows.all')),
          nameOf(task.workflowId),
        )
  const stageName = nameOf(
    Array.isArray(workflow?.stages)
      ? workflow.stages.find((stage) => stage.id === task?.currentStageId)?.name
      : null,
  )

  const agentName =
    run === null
      ? null
      : nameOf(
          findById<Agent>(
            read(() => store.query('agents.all')),
            nameOf(run.agentId),
          )?.name,
        )

  const context: CardContext = {
    projectName,
    taskTitle: nameOf(task?.title),
    conversationTitle: nameOf(conversation?.title),
    stageName,
    agentName,
  }
  return Object.values(context).every((value) => value === null) ? null : context
}
