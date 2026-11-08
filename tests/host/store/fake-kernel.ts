/**
 * store 测试用假内核：实现 `KernelPort` 的 `decide` / `project` / `viewSpec`，行为确定。
 *
 * 存在的意义：store 只依赖注入的端口，测试不该被 `kernel/decide` 的实现拖住。
 * 默认覆盖 store 用得到的最小命令集（工作流增删、任务增删移、运行时/智能体新建）；
 * 用例可整体替换 `decide` / `project` / `viewSpec` 来模拟拒绝、抛错、并发写者。
 */
import type { Agent, Runtime, Task, Workflow, WorkflowStage } from '../../../src/protocol/entities'
import type {
  AgentCreateCommand,
  RuntimeCreateCommand,
  RuntimeProbedCommand,
  TaskCreateCommand,
  TaskMoveCommand,
  TaskRemoveCommand,
  WorkflowCreateCommand,
  WorkflowRemoveCommand,
} from '../../../src/protocol/commands'
import type { Input } from '../../../src/protocol/inputs'
import type { StageInput } from '../../../src/protocol/entities'
import type {
  Actor,
  Change,
  Decision,
  Environment,
  Fact,
  FactDraft,
  Iso,
  KernelPort,
  ProjectionRow,
  ProjectionTable,
  Reason,
  View,
} from '../../../src/kernel/types'
import { PROJECTION_TABLES } from '../../../src/host/schema'
import { sample } from './test-support'

const OWNER: Actor = { kind: 'owner', via: 'ui' }

const reject = (code: Reason, message: string): Decision => ({
  facts: [],
  reject: { code, message },
})

const stageIdAt = (ids: readonly string[], index: number | null | undefined): string | null =>
  index === null || index === undefined ? null : (ids[index] ?? null)

const stagesOf = (view: View, workflowId: string): WorkflowStage[] =>
  [...view.stages.values()]
    .filter((stage) => stage.workflowId === workflowId)
    .sort((left, right) => left.position - right.position)

const createWorkflow = (input: WorkflowCreateCommand, at: Iso, env: Environment): Decision => {
  const workflowId = env.nextId('workflow')
  const stageIds = input.input.stages.map(() => env.nextId('stage'))
  const buildStage = (definition: StageInput, index: number): WorkflowStage =>
    sample.stage({
      id: stageIds[index],
      workflowId,
      name: definition.name,
      position: index,
      entryMode: definition.entryMode,
      agentId: definition.agentId ?? null,
      onCompleteStageId: stageIdAt(stageIds, definition.onCompleteIndex),
      onRejectStageId: stageIdAt(stageIds, definition.onRejectIndex),
    })
  const workflow = sample.workflow({
    id: workflowId,
    name: input.input.name,
    description: input.input.description ?? '',
    createdAt: at,
  })
  const stages = input.input.stages.map(buildStage)
  const facts: FactDraft[] = [
    { type: 'workflow.created', actor: OWNER, at, payload: { workflow } },
    ...stages.map((stage): FactDraft => ({
      type: 'stage.created',
      actor: OWNER,
      at,
      payload: { stage },
    })),
  ]
  return { facts }
}

const removeWorkflow = (view: View, input: WorkflowRemoveCommand, at: Iso): Decision => {
  const workflow = view.workflows.get(input.id)
  if (!workflow) return reject('not_found', `工作流不存在: ${input.id}`)
  if ([...view.tasks.values()].some((task) => task.workflowId === workflow.id)) {
    return reject('conflict', '工作流下还有任务')
  }
  const facts: FactDraft[] = [
    { type: 'workflow.removed', actor: OWNER, at, payload: { workflow } },
    ...stagesOf(view, workflow.id).map((stage): FactDraft => ({
      type: 'stage.deleted',
      actor: OWNER,
      at,
      payload: { stage },
    })),
  ]
  return { facts }
}

const createTask = (view: View, input: TaskCreateCommand, at: Iso, env: Environment): Decision => {
  const workflow = view.workflows.get(input.input.workflowId)
  if (!workflow) return reject('not_found', `工作流不存在: ${input.input.workflowId}`)
  const stages = stagesOf(view, workflow.id)
  const stageId = input.input.stageId ?? stages[0]?.id ?? null
  if (stageId !== null && !stages.some((stage) => stage.id === stageId)) {
    return reject('invalid_input', '起始阶段不属于该工作流')
  }
  const task = sample.task({
    id: env.nextId('task'),
    title: input.input.title,
    description: input.input.description ?? '',
    workflowId: workflow.id,
    // M10：假内核不校验项目存在性，原样落到行上（真内核在 decide 里校验）
    projectId: input.input.projectId,
    currentStageId: stageId,
    createdAt: at,
    updatedAt: at,
  })
  return { facts: [{ type: 'task.created', actor: OWNER, at, payload: { task } }] }
}

const moveTask = (view: View, input: TaskMoveCommand, at: Iso): Decision => {
  const task = view.tasks.get(input.id)
  if (!task) return reject('not_found', `任务不存在: ${input.id}`)
  const stage = view.stages.get(input.stageId)
  if (!stage || stage.workflowId !== task.workflowId) {
    return reject('invalid_input', '目标阶段不属于该任务的工作流')
  }
  if (view.activeTaskIds.has(task.id)) return reject('forbidden', '任务执行中，不能移动')
  const from = task.currentStageId
  const moved: Task = { ...task, currentStageId: stage.id, updatedAt: at }
  return {
    facts: [{ type: 'task.moved', actor: OWNER, at, payload: { task: moved, from, to: stage.id } }],
  }
}

const removeTask = (view: View, input: TaskRemoveCommand, at: Iso): Decision => {
  const task = view.tasks.get(input.id)
  if (!task) return reject('not_found', `任务不存在: ${input.id}`)
  return { facts: [{ type: 'task.removed', actor: OWNER, at, payload: { task } }] }
}

const createRuntime = (input: RuntimeCreateCommand, at: Iso, env: Environment): Decision => {
  const runtime = sample.runtime({
    id: env.nextId('runtime'),
    name: input.input.name,
    executorKey: input.input.executorKey ?? 'dsh',
    argsTemplate: input.input.argsTemplate ?? '',
    command: input.input.command ?? 'dsh',
    profile: input.input.profile ?? 'multica',
    permissionMode: input.input.permissionMode ?? 'workspace-write',
    model: input.input.model ?? null,
    reasoningEffort: input.input.reasoningEffort ?? null,
    workdir: input.input.workdir ?? null,
    maxConcurrent: input.input.maxConcurrent ?? 1,
    enabled: input.input.enabled ?? true,
    createdAt: at,
    lastProbe: null,
  })
  return { facts: [{ type: 'runtime.created', actor: OWNER, at, payload: { runtime } }] }
}

const createAgent = (
  view: View,
  input: AgentCreateCommand,
  at: Iso,
  env: Environment,
): Decision => {
  const runtime = view.runtimes.get(input.input.runtimeId)
  if (!runtime) return reject('not_found', `运行时不存在: ${input.input.runtimeId}`)
  const agent: Agent = sample.agent({
    id: env.nextId('agent'),
    name: input.input.name,
    description: input.input.description ?? '',
    runtimeId: runtime.id,
    systemPrompt: input.input.systemPrompt ?? '',
    createdAt: at,
  })
  return { facts: [{ type: 'agent.created', actor: OWNER, at, payload: { agent } }] }
}

const probeRuntime = (view: View, input: RuntimeProbedCommand, at: Iso): Decision => {
  const runtime = view.runtimes.get(input.id)
  if (!runtime) return reject('not_found', `运行时不存在: ${input.id}`)
  const probed: Runtime = { ...runtime, lastProbe: input.probe }
  return { facts: [{ type: 'runtime.probed', actor: OWNER, at, payload: { runtime: probed } }] }
}

/** 默认决策：未覆盖的命令返回 `reject unsupported`（与 M1 决策面一致）。 */
export const defaultDecide: KernelPort['decide'] = (view, input, at, env) => {
  switch (input.type) {
    case 'workflow.create':
      return createWorkflow(input, at, env)
    case 'workflow.remove':
      return removeWorkflow(view, input, at)
    case 'task.create':
      return createTask(view, input, at, env)
    case 'task.move':
      return moveTask(view, input, at)
    case 'task.remove':
      return removeTask(view, input, at)
    case 'runtime.create':
      return createRuntime(input, at, env)
    case 'runtime.probed':
      return probeRuntime(view, input, at)
    case 'agent.create':
      return createAgent(view, input, at, env)
    default:
      return reject('unsupported', `假内核未覆盖命令: ${input.type}`)
  }
}

const upsert = (table: ProjectionTable, row: ProjectionRow & { id: string }): Change[] => [
  { table, key: row.id, row },
]

const removeRow = (table: ProjectionTable, key: string): Change[] => [{ table, key, row: null }]

/** 事实 → 投影变更（与契约一致：配置/任务事实一行一变更，删除类事实 row=null）。 */
export const defaultProject: KernelPort['project'] = (fact) => {
  switch (fact.type) {
    case 'workflow.created':
    case 'workflow.updated':
      return upsert('workflows', (fact.payload as { workflow: Workflow }).workflow)
    case 'workflow.removed':
      return removeRow('workflows', (fact.payload as { workflow: Workflow }).workflow.id)
    case 'stage.created':
    case 'stage.updated':
      return upsert('workflow_stages', (fact.payload as { stage: WorkflowStage }).stage)
    case 'stage.deleted':
      return removeRow('workflow_stages', (fact.payload as { stage: WorkflowStage }).stage.id)
    case 'agent.created':
    case 'agent.updated':
      return upsert('agents', (fact.payload as { agent: Agent }).agent)
    case 'agent.removed':
      return removeRow('agents', (fact.payload as { agent: Agent }).agent.id)
    case 'runtime.created':
    case 'runtime.updated':
    case 'runtime.probed':
      return upsert('runtimes', (fact.payload as { runtime: Runtime }).runtime)
    case 'runtime.removed':
      return removeRow('runtimes', (fact.payload as { runtime: Runtime }).runtime.id)
    case 'task.created':
    case 'task.updated':
    case 'task.moved':
    case 'task.completed':
      return upsert('tasks', (fact.payload as { task: Task }).task)
    case 'task.removed':
      return removeRow('tasks', (fact.payload as { task: Task }).task.id)
    default:
      return []
  }
}

export interface FakeKernelOptions {
  decide?: KernelPort['decide']
  project?: KernelPort['project']
  viewSpec?: KernelPort['viewSpec']
}

export interface FakeKernel extends KernelPort {
  /** 每次 `decide` 收到的视图（断言装载切片用）。 */
  readonly views: View[]
  /** 每次 `viewSpec` 的输入。 */
  readonly viewSpecInputs: Input[]
  /** 每次 `project` 收到的事实。 */
  readonly projected: Fact[]
}

/** 组装假内核：未提供的函数用默认实现，调用额外记录下来供断言。 */
export function createFakeKernel(options: FakeKernelOptions = {}): FakeKernel {
  const decideImpl = options.decide ?? defaultDecide
  const projectImpl = options.project ?? defaultProject
  const viewSpecImpl: KernelPort['viewSpec'] = options.viewSpec ?? (() => [...PROJECTION_TABLES])
  const views: View[] = []
  const viewSpecInputs: Input[] = []
  const projected: Fact[] = []
  return {
    views,
    viewSpecInputs,
    projected,
    viewSpec(input) {
      viewSpecInputs.push(input)
      return viewSpecImpl(input)
    },
    decide(view, input, at, env) {
      views.push(view)
      return decideImpl(view, input, at, env)
    },
    project(fact) {
      projected.push(fact)
      return projectImpl(fact)
    },
  }
}
