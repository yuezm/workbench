/**
 * hermes 执行器插件入口：把探测 / 模型目录 / 执行三个能力装配成 `ExecutorPlugin`。
 *
 * 插件只依赖 `sdk` 与 `protocol`：子进程、可执行文件解析、杀进程树、时钟与会话根
 * 全部经 `ctx.sdk` 注入；不 import `host/**`、node 内置或其它插件。
 */
import type { ExecutorPlugin } from '../../../sdk/types'
import { detectHermes } from './detect'
import { listHermesModels } from './models'
import { probeHermesRuntime } from './probe'
import { executeHermesRun } from './run'

export { hermesManifest } from './manifest'

export const hermesPlugin: ExecutorPlugin = {
  detect: (ctx) => detectHermes(ctx),
  probe: (ctx) => probeHermesRuntime(ctx),
  models: (ctx) => listHermesModels(ctx),
  run: (ctx, turn, io) => executeHermesRun(ctx, turn, io),
}
