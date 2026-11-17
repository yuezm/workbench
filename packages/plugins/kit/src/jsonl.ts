/**
 * JSONL 帧解析（插件共享纯函数）：不做 IO、不持有状态。
 *
 * dsh 等 CLI 的 stdio 协议都是「一行一个 JSON 对象」；非 JSON 行（CLI 的诊断文本）
 * 按「不是协议帧」丢弃，由调用方决定是否当诊断输出。
 */

/**
 * 安全解析一行 JSON；不是对象（含数组/标量）或不是合法 JSON 时返回 null。
 *
 * 返回值是泛型对象：具体帧类型由各执行器插件自己声明（shared 不认识私有协议）。
 */
export function parseFrame<T extends object = Record<string, unknown>>(line: string): T | null {
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as T
  } catch {
    // 非法 JSON：不是协议帧，交给调用方当诊断文本处理
    return null
  }
}

/**
 * 增量行读取器：把流式 chunk 切成行（跳过空行，容忍 `\r\n`）。
 *
 * 与 `host/process.ts` 的同名实现等价；插件不能 import host，因此放在 shared。
 */
export function createLineReader(onLine: (line: string) => void): {
  push(chunk: string): void
  flush(): void
} {
  let buffer = ''
  const drain = (): void => {
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.trim().length > 0) onLine(line)
      index = buffer.indexOf('\n')
    }
  }
  return {
    push(chunk: string): void {
      buffer += chunk
      drain()
    },
    flush(): void {
      const rest = buffer.replace(/\r$/, '').trim()
      buffer = ''
      if (rest.length > 0) onLine(rest)
    },
  }
}

/** 把帧内的 `error{code,message}` 归一成一行文本（失败帧通用形状） */
export function frameErrorText(frame: {
  error?: { code?: string; message?: string } | null
}): string {
  const code = frame.error?.code?.trim() ?? ''
  const message = frame.error?.message?.trim() ?? ''
  if (code && message) return `${code}: ${message}`
  return code || message
}
