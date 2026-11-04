/**
 * 宿主 IPC 测试夹具：内存库 + 真实 kernel + 真实 store。
 *
 * 读走 `store.query`（投影视图），种子一律走 `store.dispatch`（事实路径）——不直接写业务表。
 * 按 id 取实体的助手与 IPC handler 共用同一实现（从 `main/ai-workflow/ipc` 导出）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { decide } from '../../src/kernel/decide'
import { project } from '../../src/kernel/project'
import { viewSpec } from '../../src/kernel/view-spec'
import type { KernelPort } from '../../src/kernel/types'
import { openDatabase } from '../../src/host/db'
import { createStore, type Store } from '../../src/host/store/index'
import type {
  Agent,
  AgentInput,
  Runtime,
  RuntimeInput,
  Task,
  TaskInput,
  WorkflowInput,
  WorkflowWithStages,
} from '../../src/shared/ai-workflow-api'
import {
  agentById,
  createdId,
  runtimeById,
  taskById,
  workflowById,
} from '../../src/main/ai-workflow/ipc'

export { agentById, createdId, runtimeById, taskById, workflowById }

export interface TestWorld {
  db: DatabaseSync
  store: Store
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
  const db = openDatabase(':memory:')
  const kernel: KernelPort = { decide, project, viewSpec }
  const store = createStore({ db, kernel })
  store.ensureProjection()
  return { db, store }
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
