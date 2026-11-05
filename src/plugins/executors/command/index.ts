/**
 * `command` 执行器插件入口：只装配 `run`（D12 明确不给 `detect`/`probe`）。
 *
 * 插件只依赖 `sdk` 与 `protocol`：子进程、可执行文件解析、杀进程树、时钟
 * 全部经 `ctx.sdk` 注入；不 import `host/**`、node 内置或其它插件。
 */
import type { ExecutorPlugin } from '../../../sdk/types'
import { executeCommandRun } from './run'

export { commandManifest } from './manifest'

export const commandPlugin: ExecutorPlugin = {
  run: (ctx, turn, io) => executeCommandRun(ctx, turn, io),
}
