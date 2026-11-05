/**
 * in-app 通道插件（M4 D10）：投影即送达。
 *
 * 卡片进入 `cards` 投影后应用内界面就能看到，因此这里不做展示动作，收到 onCard
 * 立即回报 `delivered(card.id, card.version, 'in-app')`；重复 ack 由 hub 静默丢弃。
 * `signal` abort 或 dispose 后停止订阅，dispose 可重复调用。
 */
import type { ChannelContext, ChannelPlugin } from '../../../protocol/channels'
import { inAppManifest } from './manifest'

export { inAppManifest } from './manifest'

export const inAppChannel: ChannelPlugin = {
  async start(ctx: ChannelContext): Promise<() => void> {
    const off = ctx.onCard((card) => {
      // 投影即送达：不等待任何外部展示；hub 用首个 ack 记 card.delivered
      void ctx.delivered(card.id, card.version, inAppManifest.id)
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
