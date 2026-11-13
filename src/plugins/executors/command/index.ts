/**
 * `command` 执行器插件入口：装配 `probe` + `run`（D12 明确不给 `detect`：
 * 通用命令没有可扫的候选，扫了只会和 dsh 抢同名命令）。
 *
 * `probe` 是 M40 补上的：脚本阶段的连接必须是 `executorKey='command'` 的运行时，
 * 而 `runtime.create` 要求探测通过——没有 `probe` 就永远建不出这条连接。
 *
 * 插件只依赖 `sdk` 与 `protocol`：子进程、可执行文件解析、杀进程树、时钟
 * 全部经 `ctx.sdk` 注入；不 import `host/**`、node 内置或其它插件。
 */
import type { ExecutorPlugin } from '../../../sdk/types'
import { probeCommandRuntime } from './probe'
import { executeCommandRun } from './run'

export { commandManifest } from './manifest'

export const commandPlugin: ExecutorPlugin = {
  probe: (ctx) => probeCommandRuntime(ctx),
  run: (ctx, turn, io) => executeCommandRun(ctx, turn, io),
}
