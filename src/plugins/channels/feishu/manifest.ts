/**
 * 飞书通道插件清单（`src/plugins/channels/feishu/manifest.ts`）。
 *
 * 只声明 `spawn`：收发都经本机 `lark-cli`（凭据与 WebSocket 长连接都在 CLI 侧），
 * 因此**不需要公网地址、也不把 app secret 存进工作台**；`net` 用不上。
 * 卡片正文与选项只作 argv / stdin 参数，不拼命令行字符串（SPEC-plugins「channel」）。
 */
import type { PluginManifest } from '../../../protocol/manifest'

export const feishuManifest: PluginManifest = {
  id: 'feishu',
  kind: 'channel',
  name: '飞书',
  version: '1.0.0',
  description: '经本机 lark-cli 把卡片发到飞书，点按钮即答复（长连接收回调，无需公网地址）',
  capabilities: ['spawn'],
  config: [
    {
      key: 'lark',
      label: 'lark-cli 命令',
      type: 'text',
      default: 'lark-cli',
      help: '可执行文件名或绝对路径；先 `lark-cli auth login` 登录一次（凭证由 CLI 保管）。同一个飞书应用全局只允许一处 event 监听，被别的程序占着时本通道会在日志里报 failed_precondition 并每 30 秒重试',
    },
    {
      key: 'user',
      label: '接收人 open_id',
      type: 'text',
      help: '私聊发给谁（ou_ 开头）；留空则取 lark-cli 当前登录人',
    },
    {
      key: 'chat',
      label: '群 chat_id',
      type: 'text',
      help: '填了优先发群（oc_ 开头），留空走私聊',
    },
    {
      key: 'answerers',
      label: '可答复人 open_id',
      type: 'text',
      help: '逗号分隔；留空只认接收人（发群时必须填，否则群里任何人都能替你作答）',
    },
  ],
}
