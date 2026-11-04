/**
 * main/ai-workflow 测试夹具：内存库 + 真实 kernel + 真实 store。
 *
 * 五张业务表切成投影之后测试不能再直接写表：种子一律走 `store.dispatch`，
 * 断言读 `store.query`；runs / run_events / 聊天仍直接用 `Repository`（M1 不在投影集）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { decide } from '../../kernel/decide'
import { project } from '../../kernel/project'
import { viewSpec } from '../../kernel/view-spec'
import type { Fact, KernelPort } from '../../kernel/types'
import type { FactType } from '../../protocol/facts'
import { createStore, type Store } from '../../host/store/index'
import type {
  Agent,
  AgentInput,
  Runtime,
  RuntimeInput,
  Task,
  TaskInput,
  Workflow,
  WorkflowInput,
  WorkflowWithStages,
} from '../../shared/ai-workflow-api'
import { openDb } from './db'
import { Repository } from './repository'

export interface TestWorld {
  db: DatabaseSync
  store: Store
  repo: Repository
}

let commandSeq = 0

/** 命令幂等键：同一次测试内唯一即可（M1 暂不按 commandId 去重）。 */
export function nextCommandId(): string {
  commandSeq += 1
  return `test-command-${commandSeq}`
}

/** 重置命令序号（每个用例重新开始时调用，配合 beforeEach）。 */
export function resetCommandIds(): void {
  commandSeq = 0
}

export function createWorld(): TestWorld {
  const db = openDb(':memory:')
  const kernel: KernelPort = { decide, project, viewSpec }
  const store = createStore({ db, kernel })
  store.ensureProjection()
  return { db, store, repo: new Repository(db) }
}

/** 从刚提交的事实里取新实体 id。 */
function createdId(facts: readonly Fact[], type: FactType): string {
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

export function createRuntime(world: TestWorld, input: RuntimeInput): Runtime {
  const facts = world.store.dispatch({
    type: 'runtime.create',
    commandId: nextCommandId(),
    input,
  }).facts
  return runtimeById(world.store, createdId(facts, 'runtime.created'))
}

export function createAgent(world: TestWorld, input: AgentInput): Agent {
  const facts = world.store.dispatch({
    type: 'agent.create',
    commandId: nextCommandId(),
    input,
  }).facts
  return agentById(world.store, createdId(facts, 'agent.created'))
}

export function createWorkflow(world: TestWorld, input: WorkflowInput): WorkflowWithStages {
  const facts = world.store.dispatch({
    type: 'workflow.create',
    commandId: nextCommandId(),
    input,
  }).facts
  return workflowById(world.store, createdId(facts, 'workflow.created'))
}

export function createTask(world: TestWorld, input: TaskInput): Task {
  const facts = world.store.dispatch({
    type: 'task.create',
    commandId: nextCommandId(),
    input,
  }).facts
  return taskById(world.store, createdId(facts, 'task.created'))
}

/** 更新运行时配置（例如停用），走真实决策路径。 */
export function updateRuntime(world: TestWorld, id: string, patch: Partial<RuntimeInput>): Runtime {
  world.store.dispatch({
    type: 'runtime.update',
    commandId: nextCommandId(),
    id,
    patch,
  })
  return runtimeById(world.store, id)
}

export function removeAgent(world: TestWorld, id: string): void {
  world.store.dispatch({ type: 'agent.remove', commandId: nextCommandId(), id })
}

export function removeTask(world: TestWorld, id: string): void {
  world.store.dispatch({ type: 'task.remove', commandId: nextCommandId(), id })
}
