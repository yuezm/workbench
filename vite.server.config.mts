import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

/**
 * 服务端构建（服务器部署形态）：把 `src/server/index.ts` 打成一份 CJS 入口。
 *
 * 为什么不打包 node 内置：`node:sqlite`（投影库）、`node:http`、`node:child_process`
 * 都必须是运行时提供，rollup 一律保持外部引用；除 Node 内置外没有第三方运行时依赖
 * （`package.json` 的 dependencies 全是前端包），所以产物可以直接 `node out/server/index.js`。
 */
const externalNodeBuiltins = (id: string): boolean =>
  id.startsWith('node:') || id === 'sqlite' || id === 'better-sqlite3'

/**
 * 回执工具 server 是独立子进程脚本，不参与打包器改写：原样拷到 `out/server/receipt-mcp-server.cjs`，
 * 让 `host/receipt-tool.ts` 在产物目录（`__dirname`）直接找到它。
 *
 * 用 `closeBundle` 直接拷文件而不是 `emitFile`：SSR 构建不会为 asset 生成 chunk，
 * `emitFile` 在这里是静默空转（踩过一次：打包完脚本不见了，回执通道悄悄退回纯文本）。
 */
const copyReceiptMcpServer = (): Plugin => ({
  name: 'copy-receipt-mcp-server',
  closeBundle(): void {
    const target = resolve('out/server')
    mkdirSync(target, { recursive: true })
    copyFileSync(
      resolve('src/plugins/shared/receipt-mcp-server.cjs'),
      resolve(target, 'receipt-mcp-server.cjs'),
    )
  },
})

export default defineConfig({
  build: {
    ssr: resolve('src/server/index.ts'),
    outDir: resolve('out/server'),
    emptyOutDir: true,
    target: 'node22',
    sourcemap: true,
    minify: false,
    rollupOptions: {
      external: externalNodeBuiltins,
      output: {
        format: 'cjs',
        entryFileNames: 'index.js',
      },
    },
  },
  plugins: [copyReceiptMcpServer()],
})
