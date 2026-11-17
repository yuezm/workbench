/**
 * 脚本侧的 TS 加载器：vite SSR + 仓库包别名。
 *
 * 拆包后源码里跨包一律写 `@workbench/*`，裸 node 与裸 vite（`configFile: false`）都没有这条
 * 解析路径。凡是「直接跑 src/ 源码」的脚本（bench、sim-crash…）统一经这里加载，别名与
 * 应用构建走同一份 `scripts/workspace-aliases.mjs`（由 `pnpm gen:paths` 生成）。
 */
import { createServer } from 'vite'
import { workspaceAliases } from './workspace-aliases.mjs'

export async function createLoader() {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
    resolve: { alias: [...workspaceAliases] },
  })
  return {
    server,
    load: (path) => server.ssrLoadModule(path),
    close: () => server.close(),
  }
}
