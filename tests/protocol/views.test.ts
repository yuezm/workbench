// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Card, Conversation, RunEvent, RuntimeStatus, Task } from '../../src/protocol/entities'
import {
  HOST_VIEW_IDS,
  VIEW_IDS,
  VIEW_PARAM_FIELDS,
  type ActiveRun,
  type RunApproval,
  type RuntimeWorkload,
  type StaleChatRun,
  type ViewId,
  type ViewParams,
  type ViewResult,
  type ViewResults,
  type WaitingRun,
} from '../../src/protocol/views'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

/** 视图结果映射的键必须恰好覆盖 VIEW_IDS。 */
const resultsCover: Assert<Equal<keyof ViewResults, ViewId>> = true
/** 带参数的视图按 id 取到参数形状；无参数视图为 undefined。 */
const workflowParams: Assert<Equal<ViewParams<'tasks.byWorkflow'>, { workflowId: string }>> = true
const taskParams: Assert<Equal<ViewParams<'task.byId'>, { taskId: string }>> = true
const noParams: Assert<Equal<ViewParams<'agents.all'>, undefined>> = true
const messagesParams: Assert<
  Equal<ViewParams<'messages.byConversation'>, { conversationId: string }>
> = true
const chatRunsParams: Assert<
  Equal<ViewParams<'runs.active-by-conversation'>, { conversationId: string }>
> = true
/** 泛型取到的返回类型与映射一致。 */
const resultByView: Assert<Equal<ViewResult<'task.byId'>, Task | null>> = true

/** 阶段 run 挂任务；聊天 run 的 	askId 为 null（T14b）。 */
const activeRun = {
  id: 'r1',
  taskId: 't1',
  stageId: null,
  status: 'queued',
} satisfies ActiveRun
const chatRun = {
  id: 'r2',
  taskId: null,
  stageId: null,
  status: 'running',
} satisfies ActiveRun

describe('protocol/views', () => {
  it('VIEW_IDS 是 M1 最小集合 + M4 卡片视图 + M5 客户端视图且顺序稳定', () => {
    expect([...VIEW_IDS]).toEqual([
      'workflows.all',
      'agents.all',
      'runtimes.all',
      'projects.all',
      'tasks.byProject',
      'tasks.unassigned',
      'tasks.byWorkflow',
      'tasks.byParent',
      'task.byId',
      'runs.active-by-task',
      'conversations.all',
      'conversations.byProject',
      'conversations.unassigned',
      'messages.byConversation',
      'runs.active-by-conversation',
      'runs.byTask',
      'run.byId',
      'run.events',
      'run.last-event-seq',
      'runtimes.workloads',
      'runs.stale-chat',
      'cards.open',
      'cards.byRun',
      'runs.waiting',
      'tasks.executing',
      'runtimes.statuses',
      'kernel.seq',
      'runtimes.executors',
      'runtimes.detected',
      'runtimes.models',
      'rules.all',
      'plugins.settings',
      'plugins.all',
      'thread.byId',
      'comments.byTask',
      'reviews.byTask',
      'run.approvals',
      'runtimes.default-workdir',
      'workflow.stage-metrics',
    ])
  })

  it('视图 id 不重复，均为小写点分', () => {
    expect(new Set(VIEW_IDS).size).toBe(VIEW_IDS.length)
    for (const id of VIEW_IDS) expect(id).toMatch(/^[a-z-]+\.[A-Za-z-]+$/)
  })

  it('视图类型映射完整（类型级断言）', () => {
    expect(resultsCover).toBe(true)
    expect(workflowParams).toBe(true)
    expect(taskParams).toBe(true)
    expect(noParams).toBe(true)
    expect(messagesParams).toBe(true)
    expect(chatRunsParams).toBe(true)
    expect(resultByView).toBe(true)
  })

  it('活跃 run 只暴露内核判断所需字段', () => {
    expect(Object.keys(activeRun).sort()).toEqual(['id', 'stageId', 'status', 'taskId'])
    expect(activeRun.status).toBe('queued')
    expect(chatRun.taskId).toBeNull()
  })
})

/** T16 读路径收口：运行历史 / 负载视图的参数与返回形状。 */
const runsByTaskParams: Assert<Equal<ViewParams<'runs.byTask'>, { taskId: string }>> = true
const runByIdParams: Assert<Equal<ViewParams<'run.byId'>, { runId: string }>> = true
const runEventsParams: Assert<Equal<ViewParams<'run.events'>, { runId: string }>> = true
const lastEventSeqParams: Assert<Equal<ViewParams<'run.last-event-seq'>, { runId: string }>> = true
const workloadsNoParams: Assert<Equal<ViewParams<'runtimes.workloads'>, undefined>> = true
const staleChatNoParams: Assert<Equal<ViewParams<'runs.stale-chat'>, undefined>> = true
const runEventsResult: Assert<Equal<ViewResult<'run.events'>, RunEvent[]>> = true
const lastEventSeqResult: Assert<Equal<ViewResult<'run.last-event-seq'>, number>> = true

describe('protocol/views：T16 新增读视图', () => {
  it('参数与返回类型映射（类型级断言）', () => {
    expect(runsByTaskParams).toBe(true)
    expect(runByIdParams).toBe(true)
    expect(runEventsParams).toBe(true)
    expect(lastEventSeqParams).toBe(true)
    expect(workloadsNoParams).toBe(true)
    expect(staleChatNoParams).toBe(true)
    expect(runEventsResult).toBe(true)
    expect(lastEventSeqResult).toBe(true)
  })

  it('运行时负载与中断聊天 run 的形状最小化', () => {
    const workload: RuntimeWorkload = { runtimeId: 'rt-1', running: 1, queued: 2 }
    const stale: StaleChatRun = { id: 'run-1', leaseId: 'run-1:1', turn: 2 }
    expect(Object.keys(workload).sort()).toEqual(['queued', 'running', 'runtimeId'])
    expect(Object.keys(stale).sort()).toEqual(['id', 'leaseId', 'turn'])
  })
})

/** M4 卡片视图：`cards.open` 无参数、`cards.byRun` 按 run 取；两者都返回完整 Card 行。 */
const cardsOpenNoParams: Assert<Equal<ViewParams<'cards.open'>, undefined>> = true
const cardsByRunParams: Assert<Equal<ViewParams<'cards.byRun'>, { runId: string }>> = true
const cardsOpenResult: Assert<Equal<ViewResult<'cards.open'>, Card[]>> = true
const cardsByRunResult: Assert<Equal<ViewResult<'cards.byRun'>, Card[]>> = true

describe('protocol/views：M4 卡片视图', () => {
  it('参数与返回类型映射（类型级断言）', () => {
    expect(cardsOpenNoParams).toBe(true)
    expect(cardsByRunParams).toBe(true)
    expect(cardsOpenResult).toBe(true)
    expect(cardsByRunResult).toBe(true)
  })
})

/** M4 D13：启动对账要检查的 waiting run（无参数；`hasOpenCard` 由宿主 join 得出）。 */
const waitingRunNoParams: Assert<Equal<ViewParams<'runs.waiting'>, undefined>> = true
const waitingRunResult: Assert<Equal<ViewResult<'runs.waiting'>, WaitingRun[]>> = true

describe('protocol/views：M4 waiting run 视图', () => {
  it('参数与返回类型映射（类型级断言）', () => {
    expect(waitingRunNoParams).toBe(true)
    expect(waitingRunResult).toBe(true)
  })

  it('形状最小化：只有对账需要的四个字段', () => {
    const waiting: WaitingRun = {
      runId: 'run-1',
      leaseId: null,
      turn: 1,
      hasOpenCard: false,
    }
    expect(Object.keys(waiting).sort()).toEqual(['hasOpenCard', 'leaseId', 'runId', 'turn'])
  })
})

/** M5 客户端视图：执行中集合、负载汇总、内核水位；宿主视图走同一个 query 动词。 */
const executingNoParams: Assert<Equal<ViewParams<'tasks.executing'>, undefined>> = true
const statusesNoParams: Assert<Equal<ViewParams<'runtimes.statuses'>, undefined>> = true
/** `runtimes.statuses` 的负载只给在跑/排队数：并发上限在智能体上，视图里不再带。 */
const statusesWorkload: Assert<
  Equal<RuntimeStatus['workload'], { running: number; queued: number }>
> = true
const seqNoParams: Assert<Equal<ViewParams<'kernel.seq'>, undefined>> = true
const executorsNoParams: Assert<Equal<ViewParams<'runtimes.executors'>, undefined>> = true
const detectedNoParams: Assert<Equal<ViewParams<'runtimes.detected'>, undefined>> = true
const modelsParams: Assert<Equal<ViewParams<'runtimes.models'>, { runtimeId: string }>> = true
const approvalsParams: Assert<Equal<ViewParams<'run.approvals'>, { runId: string }>> = true
const approvalsResult: Assert<Equal<ViewResult<'run.approvals'>, RunApproval[]>> = true
const executingResult: Assert<Equal<ViewResult<'tasks.executing'>, string[]>> = true
const seqResult: Assert<Equal<ViewResult<'kernel.seq'>, number>> = true
const hostViewIdsCovered: Assert<
  Equal<
    (typeof HOST_VIEW_IDS)[number],
    | 'runtimes.executors'
    | 'runtimes.detected'
    | 'runtimes.models'
    | 'plugins.all'
    | 'run.approvals'
    | 'runtimes.default-workdir'
  >
> = true

describe('protocol/views：M5 客户端视图', () => {
  it('参数与返回类型映射（类型级断言）', () => {
    expect(executingNoParams).toBe(true)
    expect(statusesNoParams).toBe(true)
    expect(statusesWorkload).toBe(true)
    expect(seqNoParams).toBe(true)
    expect(executorsNoParams).toBe(true)
    expect(detectedNoParams).toBe(true)
    expect(modelsParams).toBe(true)
    expect(approvalsParams).toBe(true)
    expect(approvalsResult).toBe(true)
    expect(executingResult).toBe(true)
    expect(seqResult).toBe(true)
    expect(hostViewIdsCovered).toBe(true)
  })

  it('宿主视图是 VIEW_IDS 的子集且不与 DB 视图混用参数', () => {
    for (const id of HOST_VIEW_IDS) expect(VIEW_IDS).toContain(id)
    expect(VIEW_PARAM_FIELDS['runtimes.executors']).toBeUndefined()
    expect(VIEW_PARAM_FIELDS['runtimes.models']).toBe('runtimeId')
    expect(VIEW_PARAM_FIELDS['run.approvals']).toBe('runId')
    expect(VIEW_PARAM_FIELDS['runtimes.default-workdir']).toBeUndefined()
  })
})

/** M11 项目顶层化：聊天清单按项目过滤 / 未归属（默认目录）。 */
const convByProjectParams: Assert<
  Equal<ViewParams<'conversations.byProject'>, { projectId: string }>
> = true
const convUnassignedNoParams: Assert<Equal<ViewParams<'conversations.unassigned'>, undefined>> =
  true
const convByProjectResult: Assert<Equal<ViewResult<'conversations.byProject'>, Conversation[]>> =
  true
const convUnassignedResult: Assert<Equal<ViewResult<'conversations.unassigned'>, Conversation[]>> =
  true

describe('protocol/views：M11 会话按项目', () => {
  it('参数与返回类型映射（类型级断言）', () => {
    expect(convByProjectParams).toBe(true)
    expect(convUnassignedNoParams).toBe(true)
    expect(convByProjectResult).toBe(true)
    expect(convUnassignedResult).toBe(true)
  })

  it('参数字段只由 byProject 声明，未归属不带参数', () => {
    expect(VIEW_PARAM_FIELDS['conversations.byProject']).toBe('projectId')
    expect(VIEW_PARAM_FIELDS['conversations.unassigned']).toBeUndefined()
  })
})
