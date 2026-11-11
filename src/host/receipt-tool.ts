/**
 * 回执工具 server 的定位与开关（M24，宿主侧）。
 *
 * 放在 host 而不是插件里：定位要读环境变量与文件系统，`plugins/**` 被 ESLint 禁止
 * 直接用 Node 内置能力（副作用一律经 sdk 注入）。宿主解析成一份启动配置交给
 * `sdk.paths.receiptTool`，插件只负责把它塞进协议帧。
 *
 * 两道闸门让「没配好就等于不存在」：
 * 1. `WORKBENCH_RECEIPT_TOOL=0` 才关（默认开——dsh 0.2.1-rc.5 / ACP 两边的注入形状
 *    都已在真机核对，关掉只是为了排查协议问题时能退回纯文本通道）；
 * 2. 脚本必须真的找得到（开发态在 `out/main` 同级、打包态在 resources），找不到就退回
 *    纯文本通道，不会把 CLI 起坏。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SdkReceiptTool } from '../sdk/types'

/** 显式关闭开关：`=0` 时退回纯文本回执通道（其余值都按启用处理） */
export const RECEIPT_TOOL_ENV_KEY = 'WORKBENCH_RECEIPT_TOOL'
/** 直接指定 server 脚本绝对路径（产物没和脚本放一起时用） */
export const RECEIPT_TOOL_SERVER_ENV_KEY = 'WORKBENCH_RECEIPT_TOOL_SERVER'

export interface ResolveReceiptToolOptions {
  env?: NodeJS.ProcessEnv
  /** 主进程产物目录（`__dirname`）：未打包时 server 脚本与它同级 */
  mainDir?: string
  /** 打包后的 resources 目录：`plugins/receipt-mcp-server.cjs` */
  resourcesDir?: string
  /** 文件存在判断（测试注入） */
  exists?: (path: string) => boolean
  /** node 可执行；缺省 Electron 自带的 `process.execPath` */
  command?: string
}

/**
 * 解析回执工具 server 的启动配置。
 *
 * 用 `ELECTRON_RUN_AS_NODE=1` 让 Electron 二进制以纯 Node 跑脚本——与外部插件宿主同一
 * 口径，不假设用户装了独立 node。
 */
export const resolveReceiptTool = (
  options: ResolveReceiptToolOptions = {},
): SdkReceiptTool | null => {
  const env = options.env ?? process.env
  // 默认开：只有显式 `=0` 才退回纯文本通道（脚本找不到时下面还会再退一次）
  if (env[RECEIPT_TOOL_ENV_KEY] === '0') return null
  const exists = options.exists ?? existsSync
  const candidates = [
    env[RECEIPT_TOOL_SERVER_ENV_KEY],
    options.mainDir === undefined ? undefined : join(options.mainDir, 'receipt-mcp-server.cjs'),
    options.resourcesDir === undefined
      ? undefined
      : join(options.resourcesDir, 'plugins', 'receipt-mcp-server.cjs'),
  ].filter((path): path is string => typeof path === 'string' && path !== '')
  const script = candidates.find((path) => exists(path))
  if (script === undefined) return null
  return {
    command: options.command ?? process.execPath,
    args: [script],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
  }
}
