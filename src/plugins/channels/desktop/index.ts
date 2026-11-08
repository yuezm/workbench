/**
 * desktop 通道插件（M4 D10；M12 收敛打扰口径）：系统通知只提醒「有人在等你回答」。
 *
 * 打扰规则（M12，SPEC-ai-workflow「通知分层」）：
 * - **只对 `kind === 'ask'` 的卡弹系统通知**：`notice` 卡（回执 `notices`，没有选项、不阻塞
 *   续接）只进应用内通知区与任务详情，不打断人；
 * - **同一 run 的窗口合并**：`run` 在 `NOTIFICATION_WINDOW_MS` 内已经弹过就不再弹——
 *   一轮回执里的多张卡、同一张卡的反复更新都只换来一次打扰；
 * - 被跳过的卡照样 ack `delivered(card.id, card.version, 'desktop')`：投递语义是「已送达至少
 *   一个通道」，in-app 投影已经能看到它，跳过通知不是投递失败。
 *
 * 通知失败**不吞**：`sdk.notify` 同步抛错时同步抛给 hub，由 hub 按通道失败处理（全部通道失败
 * 才记 `card.delivery_failed`）。因此这里不加延时队列（异步失败就没有上报路径了）。
 *
 * 安全约定：title/body 只作 `notify` 参数，不拼 HTML/脚本/命令行；
 * 卡片正文永远不会进入命令行参数或模板。
 * `signal` abort 或 dispose 后停止订阅，dispose 可重复调用。
 */
import type { ChannelContext, ChannelPlugin } from '../../../protocol/channels'
import { desktopManifest } from './manifest'

export { desktopManifest } from './manifest'

/**
 * 系统通知正文（固定一句指引）。
 *
 * 卡片正文与选项**不进系统通知**：通知条只负责提醒「有人在等你」，
 * 阅读与选择在任务详情里做（正文可能很长，带候选清单，系统通知承载不了也不该承载）。
 */
export const NOTIFICATION_BODY = '点开工作台查看并处理'

/** 同一 run 的通知合并窗口（毫秒）：窗口内只弹第一条，避免一轮多卡连弹。 */
export const NOTIFICATION_WINDOW_MS = 30_000

export const desktopChannel: ChannelPlugin = {
  async start(ctx: ChannelContext): Promise<() => void> {
    /** runId → 上次弹通知的时刻（进程内，重启清零：补投的 pending 卡会再提醒一次） */
    const notifiedAt = new Map<string, number>()

    const off = ctx.onCard((card) => {
      if (card.kind === 'ask') {
        const now = ctx.sdk.now()
        const last = notifiedAt.get(card.runId)
        if (last === undefined || now - last >= NOTIFICATION_WINDOW_MS) {
          // 通知失败同步抛给 hub（不 catch）：本通道记为失败，其余通道继续
          ctx.sdk.notify(card.title, NOTIFICATION_BODY)
          notifiedAt.set(card.runId, now)
        }
      }
      // 信息卡与窗口内的后续卡：不弹，但投影即送达
      void ctx.delivered(card.id, card.version, desktopManifest.id)
    })

    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      off()
      notifiedAt.clear()
      ctx.signal.removeEventListener('abort', dispose)
    }
    ctx.signal.addEventListener('abort', dispose, { once: true })
    if (ctx.signal.aborted) dispose()
    return dispose
  },
}
