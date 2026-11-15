/**
 * 飞书通道插件清单（`src/plugins/channels/feishu/manifest.ts`）。
 *
 * 只声明 `spawn`：收发都经本机 `lark-cli`（凭据与 WebSocket 长连接都在 CLI 侧），
 * 因此**不需要公网地址、也不把 app secret 存进工作台**；`net` 用不上。
 * 卡片正文与选项只作 argv / stdin 参数，不拼命令行字符串（SPEC-plugins「channel」）。
 *
 * 配置面（M46 收口）：**不声明任何标量字段**。派给谁、发到哪、谁能答复都属于「一条连接」，
 * 由设置页的「飞书连接」面板独占生成（`components/FeishuConnections.tsx`）——一份 JSON 手写
 * 既容易错，也看不出每条连接落在哪个应用上。
 *
 * 原来平铺在「插件参数」里的 `agent` / `lark` / `user` / `chat` / `answerers` 五项已从表单撤掉：
 * 连接里有同名字段时它们一行都不读（`readFeishuConnections` 拿到连接就提前返回），留在版面上
 * 只会让人以为「填这里也生效」。它们现在只在 `connections` 为空时作为旧配置兜底活着
 * （legacy 分支），界面上不再暴露。
 */
import type { PluginManifest } from '../../../protocol/manifest'

export const feishuManifest: PluginManifest = {
  id: 'feishu',
  kind: 'channel',
  name: '飞书',
  version: '1.3.0',
  description:
    '经本机 lark-cli 收发：卡片发到飞书，点按钮即答复；私聊发一句话即派活，进展回帖。可接多个飞书应用，互不打扰',
  capabilities: ['spawn'],
  // 零标量字段：所有可配项都在「飞书连接」面板的一条连接里（见文件头注释）。
  config: [],
}
