/**
 * 静态资源解析（Web 产物托管）：只做两件可判定的事——把 URL 映射成产物目录里的绝对路径，
 * 以及给出正确的 Content-Type。
 *
 * 安全口径：**路径穿越一律拒绝**。`path.resolve` 之后必须仍落在产物目录内，
 * `%2e%2e%2f` 这类编码先解码再判断，解不开（畸形编码）同样拒绝。
 */
import path from 'node:path'

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
