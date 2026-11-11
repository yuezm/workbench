/**
 * 回执工具通道的注入形状（M24，纯函数）。
 *
 * 工具本身是独立的 stdio MCP server（`receipt-mcp-server.cjs`），由宿主解析好启动配置
 * （`host/receipt-tool.ts`，读环境变量与文件系统的是宿主，不是插件），这里只把它拼成
 * 各协议帧里那段结构。**两种协议的元素形状不一样**，别想着写一份通吃：
 *
 * - hermes（ACP）：`session/new` 的 `mcpServers`，取 `@agentclientprotocol/sdk` 的
 *   `McpServerStdio`：`{ type:'stdio', name, command, args, env: [{name,value}] }`；
 * - dsh：execute 帧的 `mcp_servers`，**真机实测**（dsh 0.2.1-rc.5，
 *   `ready.capabilities.mcp = ["stdio","streamable-http"]`）要的是
 *   `{ transport:'stdio', name, command, args, env: { KEY: 'value' } }`——
 *   字段名是 `transport` 不是 `type`，`env` 是**对象**不是数组。
 *   写错会被当场拒收：`mcp_servers[0].transport must be a non-empty string` /
 *   `mcp_servers[0].env must be an object`（见 `.scratch/dsh-stdio-probe.mjs`）。
 *
 * 两条通道（工具 / 文本围栏块）都走 `receipt-fields` 的同一份校验：工具拿不到就退回文本。
 */
import type { SdkReceiptTool } from '../../sdk/types'
import { RECEIPT_TOOL_SERVER } from './receipt-tool'

/** ACP `mcpServers` 的一条（`McpServerStdio`：`type` + `env` 数组）。 */
export const acpReceiptServer = (tool: SdkReceiptTool): Record<string, unknown> => ({
  type: 'stdio',
  name: RECEIPT_TOOL_SERVER,
  command: tool.command,
  args: tool.args,
  env: tool.env,
})

/**
 * dsh execute 帧 `mcp_servers` 的一条：`transport` + `env` 对象（真机实测形状）。
 *
 * 与 ACP 的差异不是笔误——dsh 的协议校验是逐字段硬判的，写错直接整帧拒收。
 */
export const dshReceiptServer = (tool: SdkReceiptTool): Record<string, unknown> => ({
  transport: 'stdio',
  name: RECEIPT_TOOL_SERVER,
  command: tool.command,
  args: tool.args,
  env: Object.fromEntries(tool.env.map((entry) => [entry.name, entry.value])),
})

/** 注入列表：宿主没给（开关关 / 脚本缺失）→ `[]`，即保持 M4 的纯文本通道。 */
export const receiptMcpServers = (tool?: SdkReceiptTool | null): Record<string, unknown>[] =>
  tool === undefined || tool === null ? [] : [acpReceiptServer(tool)]

/** dsh 侧的注入列表（形状见 `dshReceiptServer`）。 */
export const dshReceiptMcpServers = (tool?: SdkReceiptTool | null): Record<string, unknown>[] =>
  tool === undefined || tool === null ? [] : [dshReceiptServer(tool)]
