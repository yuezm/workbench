/**
 * desktop 通道插件（M4 D10）：系统通知提醒待审批卡片。
 *
 * `start` 订阅 onCard：`ctx.sdk.notify(card.title, body)` 成功后回报
 * `delivered(card.id, card.version, 'desktop')`。通知失败**不吞**：同步抛给 hub，
 * 由 hub 按通道失败处理（全部通道失败才记 `card.delivery_failed`）。
 *
 * 安全约定：title/body 只由卡片字段做纯字符串拼接，不拼 HTML/脚本/命令行；
 * 卡片正文永远不会进入命令行参数或模板。
 * `signal` abort 或 dispose 后停止订阅，dispose 可重复调用。
 */
import type { ChannelContext, ChannelPlugin } from '../../../protocol/channels'
import type { Card } from '../../../protocol/entities'
import { desktopManifest } from './manifest'

export { desktopManifest } from './manifest'

/**
 * 通知正文：卡片正文 + 选项各占一行（空文案不占行）。
 * 纯字符串拼接，作为 `notify(title, body)` 的 body 参数，不拼任何 HTML/命令。
 */
export function notificationBody(card: Card): string {
  return [card.text, ...card.options].filter(Boolean).join('\n')
}

export const desktopChannel: ChannelPlugin = {
  async start(ctx: ChannelContext): Promise<() => void> {
    const off = ctx.onCard((card) => {
      // 通知失败同步抛给 hub（不 catch）：本通道记为失败，其余通道继续
      ctx.sdk.notify(card.title, notificationBody(card))
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
