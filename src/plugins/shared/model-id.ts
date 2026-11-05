/**
 * 模型 id 解析（插件共享纯函数）：`provider/model` 形式 + 百分号反转义。
 * 协议里的模型 id 允许把 provider 内的 `/` 编码成 `%2F`，这里统一解码。
 */

/** 解析 provider/model 形式的模型 id；格式不对返回 null（由调用方报错） */
export function parseModelId(value: string): { provider: string; id: string } | null {
  const trimmed = value.trim()
  const index = trimmed.indexOf('/')
  if (index <= 0 || index === trimmed.length - 1) return null
  const decode = (part: string): string => {
    try {
      return decodeURIComponent(part)
    } catch {
      // 非法百分号转义：按原文保留，不抛错
      return part
    }
  }
  const provider = decode(trimmed.slice(0, index)).trim()
  const id = decode(trimmed.slice(index + 1)).trim()
  if (!provider || !id) return null
  return { provider, id }
}
