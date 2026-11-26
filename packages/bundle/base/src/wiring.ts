/**
 * 装配根的几个小接线件：惰性通道 hub、聊天流旁路、结局知会、对账日志判定。
 *
 * 它们都是「只在特定时序或特定事实出现时才走」的箭头函数——留在 `createWorkbench` 里
 * 只能靠整套服务跑出来才能覆盖；拆成具名函数后，时序分支可以直接构造输入断言
 * （hub 未装配、帧旁路、空事实批次、对账无事可记）。
 */
import type { NotifierFn } from '@workbench/api-http/notify'
import type { Channels } from '@workbench/host/channels'
import type { FactFeed } from '@workbench/host/feed'
import { noticesFromFacts } from '@workbench/host/notices'
import type { ReconcileSummary } from '@workbench/host/reconcile'
import type { Scheduler } from '@workbench/host/scheduler'
import type { DispatchResult } from '@workbench/host-store/index'
import type { Fact } from '@workbench/kernel/core/types'
import type { RunEvent } from '@workbench/protocol/entities'

/**
 * 写入口转发：clock / scheduler / 通道拿到的都是同一个 `effects.dispatch`，
 * 不各自再写一份闭包（装配根里出现三个 `(input) => effects.dispatch(input)` 只会让
 * 「唯一写路径」在阅读时变成三处）。
 */
export function passthroughDispatch(effects: {
  dispatch: (input: unknown) => DispatchResult
}): (input: unknown) => DispatchResult {
  return (input) => effects.dispatch(input)
}

/**
 * 时钟 tick 之后的钩子：唤醒调度器去领退避到期的 run。
 *
 * holder 打破 clock ↔ scheduler 的构造环（clock 先建、scheduler 后建），装配完成后填值。
 */
export function clockTickHook(holder: { current: Pick<Scheduler, 'wake'> | null }): () => void {
  return () => holder.current?.wake()
}

/**
 * 调度器引用的 getter（effects 的 `scheduler` 依赖）：装配完成前被调用说明顺序错了，
 * 直接抛可读错误而不是对着 null 继续。
 */
export function schedulerRef(holder: { current: Scheduler | null }): () => Scheduler {
  return () => {
    const scheduler = holder.current
    if (scheduler === null) throw new Error('调度器尚未装配')
    return scheduler
  }
}

/**
 * 惰性取通道 hub：effects 在构造时就要拿到 `channels`，而 hub 必须等 effects 建完才能建。
 * 装配顺序被破坏（hub 还没建就被写入）时抛可读错误，而不是对着 null 继续。
 */
export function lazyChannelHub(holder: { current: Channels | null }): () => Channels {
  return () => {
    const hub = holder.current
    if (hub === null) throw new Error('通道 hub 尚未装配')
    return hub
  }
}

/** 聊天 run 的实时旁路：`stream` 帧原样转出，一轮结束发一次 `stream-end`。 */
export function chatStreamHooksOf(feed: Pick<FactFeed, 'stream'>): {
  onChatStream: (runId: string, conversationId: string, event: RunEvent) => void
  onChatStreamEnd: (runId: string, conversationId: string) => void
} {
  return {
    onChatStream: (runId, conversationId, event) =>
      feed.stream({ kind: 'stream', runId, conversationId, event }),
    onChatStreamEnd: (runId, conversationId) =>
      feed.stream({ kind: 'stream-end', runId, conversationId }),
  }
}

/**
 * 结局知会（M12）：从一批事实里挑出「任务完成 / 运行失败」，逐条推给在线页面。
 * 空批次、与结局无关的事实都不产生通知（`noticesFromFacts` 负责判定）。
 */
export function announceNoticesOf(notifier: NotifierFn): (facts: readonly Fact[]) => void {
  return (facts) => {
    for (const request of noticesFromFacts(facts)) {
      notifier(request.title, request.body, request.target)
    }
  }
}

/**
 * 给日志加固定前缀（`[workdir]` / `[scheduler]`）：装配根里同一类诊断要能在长日志里一眼分开。
 * 前缀只拼在行首，不动内容。
 */
export function prefixedLog(
  target: (line: string) => void,
  prefix: string,
): (line: string) => void {
  return (line) => target(`${prefix}${line}`)
}

/**
 * 启动对账的诊断行：只有真回收了东西才给一行（残留进程 / 清登记 / 回收事实 / 兜底取消），
 * 否则空数组（对齐「装配正常时不留噪音日志」）。
 */
export function reconcileLogLines(summary: ReconcileSummary): string[] {
  if (
    summary.killed > 0 ||
    summary.facts > 0 ||
    summary.settledChats > 0 ||
    summary.settledWaitings > 0
  ) {
    return [
      `[reconcile] 终止残留进程 ${summary.killed} 个、清理登记 ${summary.cleared} 行、回收事实 ${summary.facts} 条`,
    ]
  }
  return []
}
