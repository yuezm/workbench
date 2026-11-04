/**
 * 内核契约（M1 子集）：事实、视图、决策、投影变更。
 *
 * 纯类型 + 一个版本常量；没有 IO / 时钟 / 随机数。宿主负责把 `now`、id 生成器、
 * 视图切片装好再调用 `decide`。
 *
 * 与 SPEC-kernel 的差异（记录在 tasks/m1-plan.md）：
 * - `View` 只含 M1 投影集（五表）+ 活跃任务集合；rules/threads/cards/消息等 M2/M6 再补。
 * - 事实 payload 里的实体行是完整行（含 lastProbe），这样 `project(fact)` 是纯函数：
 *   一行事实 → 一行投影，重建与实时写入走同一条路径。凭据类字段仍不进事实。
 */
import type { Agent, Runtime, Task, Workflow, WorkflowStage } from '../protocol/entities'
import type { FactPayload, FactType } from '../protocol/facts'
import type { Command } from '../protocol/commands'

export type Seq = number
export type Id = string
export type Iso = string

/** 内核版本；参与投影指纹，行为变化时递增，启动即触发重建。 */
export const KERNEL_VERSION = 'm1.0.0'

export type Actor =
  | { kind: 'owner'; via: 'ui' | 'channel' }
  | { kind: 'host'; via: 'timer' | 'scheduler' | 'reconcile' | 'timeout' | 'cancel' }
  | { kind: 'kernel' }

/** M1 投影集：只有这些表可由事实重建。 */
export type ProjectionTable = 'tasks' | 'workflows' | 'workflow_stages' | 'agents' | 'runtimes'

export type ProjectionRow = Task | Workflow | WorkflowStage | Agent | Runtime

export interface FactDraft<T extends FactType = FactType> {
  type: T
  actor: Actor
  at: Iso
  cause?: Seq
  hops?: number
  payload: FactPayload<T>
}

export interface Fact<T extends FactType = FactType> extends FactDraft<T> {
  seq: Seq
}

/** 事实 → 投影变更；`row === null` 为删除。 */
export interface Change {
  table: ProjectionTable
  key: Id
  row: ProjectionRow | null
}

/** 宿主按 `viewSpec` 装载的只读切片；内核不查库。 */
export interface View {
  seq: Seq
  workflows: Map<Id, Workflow>
  stages: Map<Id, WorkflowStage>
  agents: Map<Id, Agent>
  runtimes: Map<Id, Runtime>
  tasks: Map<Id, Task>
  /** 存在 queued/running run 的任务；「执行中」只认它，不由 UI 推导。 */
  activeTaskIds: Set<Id>
}

export interface Limits {
  maxStagesPerWorkflow: number
  /** 事实 payload 里数组字段的上限（重建/装载的边界保护）。 */
  maxArrayLength: number
}

export type IdKind = 'workflow' | 'stage' | 'agent' | 'runtime' | 'task'

/** 宿主在边界注入：时区、限制、id 生成器（内核不取随机数）。 */
export interface Environment {
  timezone: string
  limits: Limits
  nextId: (kind: IdKind) => Id
}

export type Reason = 'invalid_input' | 'not_found' | 'conflict' | 'forbidden' | 'unsupported'

/** 唯一决策结果；非法输入走 `reject`，不抛异常。 */
export interface Decision {
  facts: FactDraft[]
  reject?: { code: Reason; message: string }
}

/** 宿主侧内核门面：store 只依赖这三个函数，不直连具体实现。 */
export interface KernelPort {
  decide: (view: View, input: Command, now: Iso, env: Environment) => Decision
  project: (fact: Fact) => Change[]
  viewSpec: (input: Command) => ProjectionTable[]
}
