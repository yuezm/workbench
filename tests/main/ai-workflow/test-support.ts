/**
 * main/ai-workflow 测试夹具：内存库 + 真实 kernel + 真实 store。
 *
 * 五张业务表切成投影之后测试不能再直接写表：种子一律走 `store.dispatch`，
 * 断言读 `store.query`；runs / run_events / 聊天仍直接用 `Repository`（M1 不在投影集）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { decide } from '../../../src/kernel/decide'
import { project } from '../../../src/kernel/project'
import { viewSpec } from '../../../src/kernel/view-spec'
import type { KernelPort } from '../../../src/kernel/types'
import { createStore, type Store } from '../../../src/host/store/index'
import type {
  Agent,
  AgentInput,
  Runtime,
  RuntimeInput,
  Task,
  TaskInput,
  WorkflowInput,
  WorkflowWithStages,
} from '../../../src/shared/ai-workflow-api'
import { openDb } from '../../../src/main/ai-workflow/db'
import {
  agentById,
  createdId,
  runtimeById,
  taskById,
  workflowById,
} from '../../../src/main/ai-workflow/projection-lookup'
import { Repository } from '../../../src/main/ai-workflow/repository'

// 投影查询助手已抽到 projection-lookup（与 ipc.ts 共用）；这里保留同名转出，
// 让既有测试夹具的 import 面不变。
export { agentById, runtimeById, taskById, workflowById }

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
