/**
 * claude 执行器插件入口：把探测 / 执行两个能力装配成 `ExecutorPlugin`。
 *
 * `models()` 有意不实现：claude 没有稳定的模型目录接口，编造目录不如让宿主按
 * 缺省返回 `[]`（表单里模型一栏是自由文本）。
 *
 * 插件只依赖 `sdk` 与 `protocol`：子进程、可执行文件解析、杀进程树、时钟与会话根
 * 全部经 `ctx.sdk` 注入；不 import `host/**`、node 内置或其它插件。
 */
import type { ExecutorPlugin } from '../../../sdk/types'
import { detectClaude } from './detect'
import { probeClaudeRuntime } from './probe'
import { executeClaudeRun } from './run'

export { claudeManifest } from './manifest'

export const claudePlugin: ExecutorPlugin = {
  detect: (ctx) => detectClaude(ctx),
  probe: (ctx) => probeClaudeRuntime(ctx),
  run: (ctx, turn, io) => executeClaudeRun(ctx, turn, io),
}
