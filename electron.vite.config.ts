import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

/**
 * 回执工具 server（M24）是独立子进程脚本，不参与打包器改写：作为静态资源原样发到
 * `out/main/receipt-mcp-server.cjs`，让 `host/receipt-tool.ts` 在开发态（`__dirname`）
 * 直接找到它；打包态由 electron-builder 的 extraResources 拷到
 * `resources/plugins/receipt-mcp-server.cjs`。
 */
const emitReceiptMcpServer = (): Plugin => ({
  name: 'emit-receipt-mcp-server',
  buildStart(): void {
    this.emitFile({
      type: 'asset',
      fileName: 'receipt-mcp-server.cjs',
      source: readFileSync(resolve('src/plugins/shared/receipt-mcp-server.cjs'), 'utf8'),
    })
  },
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), emitReceiptMcpServer()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
