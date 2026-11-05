/**
 * webhook 通道插件清单（`src/plugins/channels/webhook-channel/manifest.ts`）。
 *
 * 只声明 `net`：出站 POST 经 `ctx.sdk.net.fetch`（宿主 `host/net.ts` 原件，有超时与
 * 响应体上限）。`secret` 可选，只作 `Authorization: Bearer`（不生成 HMAC 签名，
 * 任务裁决见 tasks/m7-plan.md D10）。单向：不回收答案。
 */
import type { PluginManifest } from '../../../protocol/manifest'

export const webhookChannelManifest: PluginManifest = {
  id: 'webhook-channel',
  kind: 'channel',
  name: 'Webhook 通道',
  version: '1.0.0',
  description: '把卡片 POST 到配置的 HTTP 地址（单向：只投递，不回收答案）',
  capabilities: ['net'],
  config: [
    {
      key: 'url',
      label: '投递地址',
      type: 'text',
      required: true,
      help: '必须是 http(s) 地址；未配置时通道不投递',
    },
    {
      key: 'secret',
      label: '访问令牌',
      type: 'secret',
      help: '可选：作为 Authorization: Bearer <secret> 发送',
    },
    {
      key: 'timeoutMs',
      label: '超时（毫秒）',
      type: 'number',
      default: 5000,
      help: '单次 POST 的超时；超时只记日志，不重试',
    },
  ],
}
