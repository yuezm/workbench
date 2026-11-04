/**
 * 提交后的任务效果（M1 过渡缝）。
 *
 * `decide` 只产事实；任务进入某阶段之后要做的事（agent 阶段建一条 queued run 并通知
 * runner）仍由宿主在**提交成功后**执行：读新视图 → `runCreate` → `onQueue`。
 * M2 把 run 生命周期入账后，这一层会并入内核。
 *
 * 运行结束后的阶段推进（RUN_SUCCEEDED / RUN_FAILED）沿用 `kernel/workflow/stage-machine`
 * 的纯函数算出目标，再经 `store.dispatch` 写回业务表（不允许直接改投影），走完流程后
 * 照样执行目标阶段的进入效果。
 */
import { randomUUID } from 'node:crypto'
import type { Fact } from '../kernel/types'
import type { Agent, Task, WorkflowWithStages } from '../protocol/entities'
import type { StageEffect, StageEvent } from '../kernel/workflow/stage-machine'
import { entryEffects, moveTask } from '../kernel/workflow/stage-machine'
import type { Store } from './store/index'

/** 建 run 所需的最小仓储面（`Repository` 结构上满足它，避免 host 反向依赖 main）。 */
export interface RunCreator {
  runCreate(input: {
    taskId: string
    stageId: string | null
    agentId: string | null
    runtimeId: string | null
    prompt: string
    status: 'queued'
  }): { id: string }
}

export interface TaskEffectsDeps {
  store: Store
  repo: RunCreator
  /** 建好 queued run 后通知调度器（runner.enqueue）。 */
  onQueue: (runId: string) => void
  /** 命令幂等键生成器（默认随机 UUID；测试注入确定性值）。 */
  commandId?: () => string
}

/** 进入阶段后的效果执行者；返回新建的 run id（顺序与效果顺序一致）。 */
export interface StageEffectTarget {
  task: Task
  effects: StageEffect[]
}

const nextCommandId = (deps: TaskEffectsDeps): string =>
  deps.commandId ? deps.commandId() : randomUUID()

const findWorkflow = (store: Store, workflowId: string): WorkflowWithStages => {
  const workflow = store.query('workflows.all').find((item) => item.id === workflowId)
  if (!workflow) throw new Error('工作流不存在: ' + workflowId)
  return workflow
}

const findAgent = (store: Store, agentId: string): Agent => {
  const agent = store.query('agents.all').find((item) => item.id === agentId)
  if (!agent) throw new Error('智能体不存在: ' + agentId)
  return agent
}

const findTask = (store: Store, taskId: string): Task => {
  const task = store.query('task.byId', { taskId })
  if (!task) throw new Error('任务不存在: ' + taskId)
  return task
}

/**
 * 提示词：智能体能力（systemPrompt）→ 任务标题 → 任务描述 → 阶段名，空段过滤后两两空行分隔。
 * 与迁移前 `engine.applyEffects` 逐字一致（renderer 无机会感知差异，但 runner 记录会）。
 */
export const buildTaskPrompt = (agent: Agent, task: Task, stageName: string | null): string =>
  [
    agent.systemPrompt,
    `# 任务：${task.title}`,
    task.description,
    stageName ? `# 阶段：${stageName}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

/** 执行一组阶段效果：只认 `createRun`，建 run 并回调 onQueue。 */
export function applyStageEffects(
  deps: TaskEffectsDeps,
  task: Task,
  effects: readonly StageEffect[],
): string[] {
  const workflow = findWorkflow(deps.store, task.workflowId)
  const runIds: string[] = []
  for (const effect of effects) {
    if (effect.type !== 'createRun') continue
    const agent = findAgent(deps.store, effect.agentId)
    const stage = workflow.stages.find((item) => item.id === effect.stageId)
    const run = deps.repo.runCreate({
      taskId: task.id,
      stageId: effect.stageId,
      agentId: effect.agentId,
      runtimeId: agent.runtimeId,
      prompt: buildTaskPrompt(agent, task, stage ? stage.name : null),
      status: 'queued',
    })
    runIds.push(run.id)
    deps.onQueue(run.id)
  }
  return runIds
}

/**
 * 提交成功后按事实执行进入效果：`task.created` / `task.moved` 都算「进入当前阶段」。
 *
 * 一次 dispatch 可能带多条任务事实（`workflow.update` 会把被删阶段上的任务重挂到新阶段），
 * 每条事实都按它自带的任务行执行——进入效果只取决于事实里的任务态，不依赖随后再查库的顺序。
 *
 * 两种情况不重复触发（与旧 `engine` 的零效果语义一致）：
 * - 任务已完成：拖拽/更新都不会再为它建 run；
 * - `task.moved` 的 `from === to`（原地无变化）。
 */
export function applyTaskEffects(deps: TaskEffectsDeps, facts: readonly Fact[]): string[] {
  const runIds: string[] = []
  for (const fact of facts) {
    if (fact.type === 'task.created') {
      const task = (fact.payload as { task: Task }).task
      if (task.status !== 'active') continue
      runIds.push(...applyEntryEffects(deps, task))
      continue
    }
    if (fact.type !== 'task.moved') continue
    const payload = fact.payload as { task: Task; from: string | null; to: string | null }
    if (payload.from === payload.to || payload.task.status !== 'active') continue
    runIds.push(...applyEntryEffects(deps, payload.task))
  }
  return runIds
}

/** 对任务当前阶段执行进入效果（阶段无效 = 无效果）。 */
function applyEntryEffects(deps: TaskEffectsDeps, task: Task): string[] {
  const workflow = findWorkflow(deps.store, task.workflowId)
  const stage = workflow.stages.find((item) => item.id === task.currentStageId)
  if (!stage) return []
  return applyStageEffects(deps, task, entryEffects(stage))
}

/**
 * 运行结束后的阶段推进：用 `moveTask` 算目标，经 `store.dispatch` 落库。
 *
 * - 到终端（无下一阶段）→ `task.complete`
 * - 换阶段 → `task.move`，再执行目标阶段的进入效果
 * - 打回原地 / 任务已完成 / 阶段无效 → 不写库（与旧实现「原地零效果」一致）
 */
export function advanceTask(
  deps: TaskEffectsDeps,
  taskId: string,
  event: StageEvent,
  onQueue: (runId: string) => void = deps.onQueue,
): Task {
  const task = findTask(deps.store, taskId)
  const workflow = findWorkflow(deps.store, task.workflowId)
  if (!workflow.stages.some((stage) => stage.id === task.currentStageId)) {
    throw new Error('任务当前阶段无效')
  }
  const { task: next } = moveTask(task, event, workflow)

  if (next.status === 'completed' && task.status !== 'completed') {
    deps.store.dispatch({
      type: 'task.complete',
      commandId: nextCommandId(deps),
      id: task.id,
    })
    return findTask(deps.store, taskId)
  }

  if (next.currentStageId !== null && next.currentStageId !== task.currentStageId) {
    const { facts } = deps.store.dispatch({
      type: 'task.move',
      commandId: nextCommandId(deps),
      id: task.id,
      stageId: next.currentStageId,
    })
    applyTaskEffects({ ...deps, onQueue }, facts)
    return findTask(deps.store, taskId)
  }

  return task
}
