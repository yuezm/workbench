/**
 * 飞书通道插件清单（`src/plugins/channels/feishu/manifest.ts`）。
 *
 * 只声明 `spawn`：发送都经本机 `lark-cli`（凭据与 WebSocket 长连接都在 CLI 侧），
 * 因此**不需要公网地址、也不把 app secret 存进工作台**；`net` 用不上。
 * 卡片正文与选项只作 argv / stdin 参数，不拼命令行字符串（SPEC-plugins「channel」）。
 *
 * 产品口径（只做 AI 自动化，不做聊天）：**只把需要人拍板的事推到飞书**——`ask` 卡进群 / 私聊，
 * 点按钮即答复，其余一律不打扰；通道不订阅入站消息、不回帖进展。
 *
 * 配置面（M46 收口）：**不声明任何标量字段**。发到哪、谁能拍板都属于「一条连接」，
 * 由设置页的「飞书连接」面板独占生成（`components/FeishuConnections.tsx`）——一份 JSON 手写
 * 既容易错，也看不出每条连接落在哪个应用上。
 *
 * 原来平铺在「插件参数」里的 `lark` / `user` / `chat` / `answerers` 四项已从表单撤掉：
 * 连接里有同名字段时它们一行都不读（`readFeishuConnections` 拿到连接就提前返回），留在版面上
 * 只会让人以为「填这里也生效」。它们现在只在 `connections` 为空时作为旧配置兜底活着
 * （legacy 分支），界面上不再暴露。
 */
import type { PluginManifest } from '@workbench/protocol/manifest'

export const feishuManifest: PluginManifest = {
  id: 'feishu',
  kind: 'channel',
  name: '飞书',
  version: '1.4.0',
  description: '只把需要人拍板的事推到飞书，点按钮即答复；不在飞书聊天',
  capabilities: ['spawn'],
  // 零标量字段：所有可配项都在「飞书连接」面板的一条连接里（见文件头注释）。
  config: [],
}
