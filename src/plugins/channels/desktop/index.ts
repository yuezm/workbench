/**
 * desktop 通道插件（M4 D10）：系统通知提醒待审批卡片。
 *
 * `start` 订阅 onCard：`ctx.sdk.notify(card.title, NOTIFICATION_BODY)` 成功后回报
 * `delivered(card.id, card.version, 'desktop')`。通知失败**不吞**：同步抛给 hub，
 * 由 hub 按通道失败处理（全部通道失败才记 `card.delivery_failed`）。
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

export const desktopChannel: ChannelPlugin = {
  async start(ctx: ChannelContext): Promise<() => void> {
    const off = ctx.onCard((card) => {
      // 通知失败同步抛给 hub（不 catch）：本通道记为失败，其余通道继续
      ctx.sdk.notify(card.title, NOTIFICATION_BODY)
      void ctx.delivered(card.id, card.version, desktopManifest.id)
    })

    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      off()
      ctx.signal.removeEventListener('abort', dispose)
    }
    ctx.signal.addEventListener('abort', dispose, { once: true })
    if (ctx.signal.aborted) dispose()
    return dispose
  },
}
