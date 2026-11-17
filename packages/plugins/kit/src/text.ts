/**
 * 文本处理纯函数（插件共享）：诊断截尾、stderr 拼接、版本号提取。
 * 不读时钟、不碰文件/网络。
 */

/** 取文本尾部；超限加省略号前缀（诊断输出用） */
export function tail(text: string, limit: number): string {
  return text.length > limit ? '…' + text.slice(-limit) : text
}

/**
 * 把 CLI 的 stderr 尾部拼到错误文案后，便于用户直接看到原始诊断。
 *
 * `tag` 参数化标签（如 `dsh stderr`），command 等其它执行器可复用。
 */
export function withStderr(message: string, stderr: string, tag = 'dsh stderr'): string {
  const tailText = stderr.trim()
  return tailText ? `${message}\n[${tag}]\n${tailText}` : message
}

/** 从 CLI `--version` 输出里取第一段 semver；取不到返回 null */
export function extractSemver(text: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text)
  return match?.[1] ?? null
}
