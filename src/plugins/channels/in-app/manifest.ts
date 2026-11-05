/**
 * in-app 通道插件清单（`src/plugins/channels/in-app/manifest.ts`）。
 *
 * 应用内通道不需要任何 sdk 能力：卡片落在 `cards` 投影后界面直接可读，
 * 「投影即送达」由插件在收到 onCard 时回报 delivered 完成。
 */
import type { PluginManifest } from '../../../protocol/manifest'

export const inAppManifest: PluginManifest = {
  id: 'in-app',
  kind: 'channel',
  name: '应用内',
  version: '1.0.0',
  description: '投影即送达：卡片进入 cards 投影后由应用内界面直接展示',
  capabilities: [],
}
