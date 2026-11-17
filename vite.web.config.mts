import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { workspaceAliases } from './scripts/workspace-aliases.mjs'

/**
 * Web 界面构建：产物是纯静态 SPA（`out/web`），由服务端同源托管。
 *
 * 为什么同源：浏览器侧只有 `fetch('/api/…')` 与一条 SSE 长连接，没有任何跨域；
 * 鉴权走 HttpOnly cookie（`POST /api/session` 之后由浏览器自动带上），前端拿不到 token。
 *
 * 开发态由 `scripts/dev.mjs` 起这个 dev server，并把 `/api` 代理到本地服务进程。
 *
 * 包别名来自 `pnpm gen:paths` 生成的 `scripts/workspace-aliases.mjs`（与 tsconfig paths 同源）；
 * 拆分后 `@renderer` 只服务 renderer 内部，跨包一律写包名。
 */
export default defineConfig({
  root: resolve('apps/web'),
  base: '/',
  resolve: {
    // 跨包一律走包名（@renderer 别名随 renderer 目录一起退役）
    alias: [...workspaceAliases],
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: process.env['WORKBENCH_DEV_API'] ?? 'http://127.0.0.1:7788',
        changeOrigin: false,
      },
    },
  },
})
