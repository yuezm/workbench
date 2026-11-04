/**
 * 投影查询助手（main / ai-workflow 内部共用）。
 *
 * IPC handler 与测试夹具都要「按 id 从投影视图里取实体、取不到就抛错」，
 * 以及「从刚提交的事实里取新实体 id」。两处各抄一份会漂移，这里收成单实现：
 * 只依赖注入的 `Store`，不碰 electron / 数据库句柄，便于单测。
 */
import type { Fact } from '../../kernel/types'
import type { FactType } from '../../protocol/facts'
import type { Store } from '../../host/store/index'
import type {
  Agent,
  Runtime,
  Task,
  Workflow,
  WorkflowWithStages,
} from '../../shared/ai-workflow-api'

/**
 * 从刚提交的事实里取新实体 id（create 类命令用）。
 * 读投影也能拿到，但用事实更直接：同一事务里刚写的行就是它，不存在并发歧义。
 */
export function createdId(facts: readonly Fact[], type: FactType): string {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error('缺少事实: ' + type)
  switch (fact.type) {
    case 'runtime.created':
      return (fact.payload as { runtime: Runtime }).runtime.id
    case 'agent.created':
      return (fact.payload as { agent: Agent }).agent.id
    case 'workflow.created':
      return (fact.payload as { workflow: Workflow }).workflow.id
    case 'task.created':
      return (fact.payload as { task: Task }).task.id
    default:
      throw new Error('事实不携带实体 id: ' + fact.type)
  }
}

export function runtimeById(store: Store, id: string): Runtime {
  const runtime = store.query('runtimes.all').find((item) => item.id === id)
  if (!runtime) throw new Error('运行时不存在: ' + id)
  return runtime
}

export function agentById(store: Store, id: string): Agent {
  const agent = store.query('agents.all').find((item) => item.id === id)
  if (!agent) throw new Error('智能体不存在: ' + id)
  return agent
}

export function workflowById(store: Store, id: string): WorkflowWithStages {
  const workflow = store.query('workflows.all').find((item) => item.id === id)
  if (!workflow) throw new Error('工作流不存在: ' + id)
  return workflow
}

export function taskById(store: Store, id: string): Task {
  const task = store.query('task.byId', { taskId: id })
  if (!task) throw new Error('任务不存在: ' + id)
  return task
}
