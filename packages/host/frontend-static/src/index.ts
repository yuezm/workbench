/**
 * Web 产物托管：唯一的「dist 在哪 / 有没有 dist」知识。
 *
 * 三件事：
 * 1. `resolveWebUi` 决定本次启动是否托管界面（服务端是产品本体，Web 只是可选层）；
 * 2. `resolveStaticFile` 把 URL 映射成产物目录里的绝对路径，越界一律拒绝；
 * 3. `contentTypeOf` / `cacheControlOf` 给出响应头。
 *
 * 安全口径：**路径穿越一律拒绝**。`path.resolve` 之后必须仍落在产物目录内，
 * `%2e%2e%2f` 这类编码先解码再判断，解不开（畸形编码）同样拒绝。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

/** `--ui` / `WORKBENCH_UI` 的取值：auto = 有产物就挂，off = 强制纯 API。 */
export type WebUiMode = 'auto' | 'on' | 'off'

export interface WebUiResolution {
  /** 生效的产物目录；null = 纯 API 模式 */
  dir: string | null
  /** 为什么是这个结果（启动行与根路径提示用） */
  reason: string
}

/**
 * 决定是否托管界面。
 *
 * - `off`：显式关掉，不看产物（`WORKBENCH_UI=off`）；
 * - `on`：必须有产物，缺了也照跑（只是没有界面），reason 会说清缺什么；
 * - `auto`：`index.html` 存在才挂。
 *
 * 任何情况下都不抛错、不阻断启动——「没有 Web 端也能用」是硬要求。
 */
export function resolveWebUi(options: { webDir: string; ui: WebUiMode }): WebUiResolution {
  if (options.ui === 'off') return { dir: null, reason: 'WORKBENCH_UI=off' }
  const index = path.join(options.webDir, 'index.html')
  if (existsSync(index)) return { dir: options.webDir, reason: options.webDir }
  return {
    dir: null,
    reason: `没有找到 Web 产物（${index}）；先跑 pnpm build:web`,
  }
}

/** 扩展名 → Content-Type（Web 产物只需要这些） */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** 未知扩展名统一当二进制流（不猜内容，避免把用户文件当 HTML 执行） */
export const FALLBACK_CONTENT_TYPE = 'application/octet-stream'

export function contentTypeOf(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? FALLBACK_CONTENT_TYPE
}

/**
 * URL → 产物文件绝对路径。越界或畸形编码返回 null。
 *
 * `/` 映射到 `index.html`；不带扩展名的路径也映射到 `index.html`（SPA 深链刷新时回到应用）。
 */
export function resolveStaticFile(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\u0000')) return null
  const relative = decoded.replace(/^\/+/u, '')
  const base = path.resolve(root)
  const candidate = path.resolve(base, relative === '' ? 'index.html' : relative)
  if (candidate !== base && !candidate.startsWith(base + path.sep)) return null
  if (path.extname(candidate) === '') return path.join(base, 'index.html')
  return candidate
}

/** 缓存策略：带指纹的 `assets/` 长缓存；HTML 每次回源（重新部署要立刻生效）。 */
export function cacheControlOf(file: string): string {
  return path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable'
}
