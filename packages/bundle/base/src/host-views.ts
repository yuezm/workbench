/**
 * 装配根接给宿主的只读查询（宿主视图 / 启动对账 / 归档标签）。
 *
 * 这些函数都是「从投影里取几列」的接线，本身没有副作用；从装配根拆出来后
 * 「运行时不存在 / run 不存在 / 没有任务 / 没有阶段 / 没有智能体」这些分支可以直接
 * 用真库夹具逐条覆盖，不必启动整套服务。
 */
import { chatPrompt } from '@workbench/kernel/scopes/prompt'
import type { Store } from '@workbench/host-store/index'
import type { RunArchiveLabels } from '@workbench/host/artifacts'
import type { HostViewResolver } from '@workbench/host/commands'
import type { ReconcileDeps } from '@workbench/host/reconcile'
import type { ExecutorPort } from '@workbench/protocol/executor'
import type { DetectedRuntime, RunRow, Runtime } from '@workbench/protocol/entities'
import type { PluginView } from '@workbench/protocol/plugins'
import type { ExecutorRegistryEntry } from '@workbench/plugins-registry'
import { readRunApprovals } from '@workbench/api-http/run-approvals'
import { executorChoicesOf } from './executor-tables'

/** 只读投影查询面（store 的真实现；测试可注入纯数据） */
export type StoreReader = Pick<Store, 'query'>

/** 宿主视图要用到的原件（都由装配根提供，函数本身不碰进程与网络） */
export interface HostViewDeps {
  /** 执行器注册表（下拉顺序） */
  executors: readonly ExecutorRegistryEntry[]
  /** 按运行时取执行器端口（模型目录用） */
  forRuntime: (runtime: Runtime) => ExecutorPort | null
  /** 本机执行器探测（装配根传 `detectAll(sdkHost)`；测试注入固定结果） */
  detect: () => Promise<DetectedRuntime[]>
  store: StoreReader
  /** dsh 会话根（提权记录从这里读） */
  sessionsDir: string
  defaultWorkdir: string
  /** `plugins.all` 视图（每次重取，反映最新设置） */
  plugins: () => PluginView[]
}

/**
 * 三动词的宿主侧读视图：命令路由注入它，`/api/query` 只读不写库。
 *
 * 未知视图不在这里兜底：`viewSpec` 先校验，走到这里的 id 一定是宿主视图。
 */
export function hostViewOf(deps: HostViewDeps): HostViewResolver {
  return (view, params) => {
    switch (view) {
      case 'runtimes.executors':
        return executorChoicesOf(deps.executors)
      case 'runtimes.detected':
        return deps.detect()
      case 'runtimes.models': {
        const id = params?.['runtimeId'] ?? ''
        const runtime = deps.store.query('runtimes.all').find((item) => item.id === id)
        if (runtime === undefined) throw new Error('运行时不存在: ' + id)
        const port = deps.forRuntime(runtime)
        if (port?.models === undefined) return Promise.resolve([])
        return port.models(runtime)
      }
      case 'plugins.all':
        return deps.plugins()
      case 'run.approvals': {
        // 沙箱提权记录：只读 dsh 会话日志（自动放行的提权在别处没有痕迹）
        const id = params?.['runId'] ?? ''
        const run = deps.store.query('run.byId', { runId: id })
        if (run === null) throw new Error('运行不存在: ' + id)
        return readRunApprovals(deps.sessionsDir, run.sessionId)
      }
      case 'runtimes.default-workdir':
        return deps.defaultWorkdir
    }
  }
}

/**
 * 启动对账的三条读路径（T13）：残留聊天 run、run 当前状态、waiting 且无 open 卡的 run。
 * 写入口由装配根注入（`effects.dispatch`），这里只管读。
 */
export function reconcileReadsOf(
  store: StoreReader,
): Pick<ReconcileDeps, 'staleChatRuns' | 'runStatus' | 'waitingRuns'> {
  return {
    // 崩溃时正在跑的聊天轮次：落 failed/executor_lost，内核补一条错误 assistant 消息
    staleChatRuns: () => store.query('runs.stale-chat'),
    // 投影里的 run 状态；run 已随任务/工作流删除时视为缺失（只清登记行）
    runStatus: (runId) => store.query('run.byId', { runId })?.status ?? null,
    // M4 D13：waiting 且无 open 卡的 run 没有可答对象（重建后无 card.* 事实）→ 兜底取消；
    // 有 open 卡的保持等待（有人可答）。过滤由读路径 join，reconcile 不查库。
    waitingRuns: () =>
      store.query('runs.waiting').map((run) => ({
        id: run.runId,
        leaseId: run.leaseId,
        turn: run.turn,
        hasOpenCard: run.hasOpenCard,
      })),
  }
}

/**
 * 归档标签（M16）：任务标题 / 阶段名 / 智能体名，查不到就给 id，不阻断归档。
 */
export function describeRunOf(store: StoreReader, run: RunRow): RunArchiveLabels {
  const task = run.taskId === null ? null : store.query('task.byId', { taskId: run.taskId })
  const stage =
    task === null || run.stageId === null
      ? undefined
      : store
          .query('workflows.all')
          .find((workflow) => workflow.id === task.workflowId)
          ?.stages.find((item) => item.id === run.stageId)
  const agent =
    run.agentId === null
      ? undefined
      : store.query('agents.all').find((item) => item.id === run.agentId)
  return {
    taskId: run.taskId,
    taskTitle: task?.title ?? null,
    stageId: run.stageId,
    stageName: stage?.name ?? null,
    agentId: run.agentId,
    agentName: agent?.name ?? null,
  }
}

/**
 * 续接被拒重试用完整历史 prompt（续接轮只发新消息，回退必须带上整段对话）。
 *
 * 非聊天 run、没有会话、智能体已删、没有任何消息时返回 null（调度器退回当前 prompt）。
 */
export function chatFallbackPromptOf(store: StoreReader, run: RunRow): string | null {
  if (run.purpose !== 'chat' || run.conversationId === null) return null
  const agent = store.query('agents.all').find((item) => item.id === run.agentId)
  const messages = store.query('messages.byConversation', {
    conversationId: run.conversationId,
  })
  return agent && messages.length > 0 ? chatPrompt(agent, messages) : null
}
