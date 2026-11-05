/**
 * webhook 来源插件清单（`src/plugins/sources/webhook/manifest.ts`）。
 *
 * 只声明 `net`：监听与 HMAC 验签都经 `ctx.sdk.net`（宿主 `host/net.ts` 原件），
 * 插件不碰 node 内置、不自己算签名。`secret` 是 secret 字段：只在设置页写入、
 * 不回显明文；未配置时来源不监听（见 `index.ts`）。
 */
import type { PluginManifest } from '../../../protocol/manifest'

export const webhookManifest: PluginManifest = {
  id: 'webhook',
  kind: 'source',
  name: 'Webhook 来源',
  version: '1.0.0',
  description: '本机回环 HTTP 接收外部事件：POST + HMAC 验签，通过后产 event.received',
  capabilities: ['net'],
  config: [
    {
      key: 'port',
      label: '监听端口',
      type: 'number',
      default: 47615,
      help: '只绑 127.0.0.1（由宿主保证）；需与推送方一致',
    },
    {
      key: 'path',
      label: '请求路径',
      type: 'text',
      default: '/webhook',
      help: '必须与推送地址的路径一致，例如 /webhook',
    },
    {
      key: 'secret',
      label: '签名密钥',
      type: 'secret',
      required: true,
      help: 'HMAC-SHA256 的共享密钥；未配置时不监听',
    },
    {
      key: 'toleranceSeconds',
      label: '时间窗（秒）',
      type: 'number',
      default: 300,
      help: '时间戳与本机时钟的最大偏差，超出即拒收',
    },
  ],
}
