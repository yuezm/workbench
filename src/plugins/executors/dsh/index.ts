/**
 * dsh 执行器插件入口：把探测 / 模型目录 / 执行三个能力装配成 `ExecutorPlugin`。
 *
 * 插件只依赖 `sdk` 与 `protocol`：子进程、可执行文件解析、杀进程树、时钟与会话根
 * 全部经 `ctx.sdk` 注入；不 import `host/**`、node 内置或其它插件。
 */
import type { ExecutorPlugin } from '../../../sdk/types'
import { detectDsh } from './detect'
import { listDshModels } from './models'
import { probeDshRuntime } from './probe'
import { executeDshRun } from './run'

export { dshManifest } from './manifest'

export const dshPlugin: ExecutorPlugin = {
  detect: (ctx) => detectDsh(ctx),
  probe: (ctx) => probeDshRuntime(ctx),
  models: (ctx) => listDshModels(ctx),
  run: (ctx, turn, io) => executeDshRun(ctx, turn, io),
}
