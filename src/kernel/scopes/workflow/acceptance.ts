/**
 * 验收条目归一（M20/M34）：一条一句的可判定口径，**只属于闸门阶段**。
 *
 * 只做**确定性归一**，不猜语义：去首尾空白、丢空条目、按出现顺序去重、单条按码点截断、
 * 整体截到上限。归一后的数组是「同一输入同一结果」，因此可以直接进提示词与事实 payload。
 *
 * 为什么不在这里校验后拒绝：验收条目是自由文本，写长了是文案问题，不是配置错误；
 * 拒绝保存会让「写多了一句」变成无法提交，比截断更烦人。校验只挡越界与重复的**结构性**问题
 * （见 `stage-validation`：非闸门阶段带非空条目 → 整份拒收）。
 */
import { ACCEPTANCE_LIMITS } from '../../../protocol/entities'

/** 归一：trim → 丢空 → 去重 → 逐条截断 → 整体截断。 */
export function normalizeAcceptance(items: readonly string[] | null | undefined): string[] {
  if (!items || items.length === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const text = item.trim()
    if (text === '') continue
    const chars = Array.from(text)
    const clipped =
      chars.length > ACCEPTANCE_LIMITS.maxChars
        ? chars.slice(0, ACCEPTANCE_LIMITS.maxChars).join('')
        : text
    if (seen.has(clipped)) continue
    seen.add(clipped)
    out.push(clipped)
    if (out.length >= ACCEPTANCE_LIMITS.maxItems) break
  }
  return out
}

/** 深比较（缺省与空数组视为同值）：用于 `stage.updated` 的差量判定。 */
export function sameAcceptance(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  const left = a ?? []
  const right = b ?? []
  return left.length === right.length && left.every((item, index) => item === right[index])
}
