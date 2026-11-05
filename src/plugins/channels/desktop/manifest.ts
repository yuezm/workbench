/**
 * desktop 通道插件清单（`src/plugins/channels/desktop/manifest.ts`）。
 *
 * 桌面通道只做系统通知提醒：标题/正文来自卡片字段，只作为 `notify(title, body)`
 * 的参数，不拼 HTML/脚本/命令行（SPEC-plugins「channel」）。
 */
import type { PluginManifest } from '../../../protocol/manifest'

export const desktopManifest: PluginManifest = {
  id: 'desktop',
  kind: 'channel',
  name: '桌面通知',
  version: '1.0.0',
  description: '系统通知提醒待审批卡片；卡片文案只作通知 API 参数',
  capabilities: ['notify'],
}
