/**
 * 模型 id 解析（协议层纯函数，M28）。
 *
 * 放在 protocol 而不是 `plugins/shared`：内核（`kernel/commands/agent.ts`）保存智能体时
 * 要按同一口径归一，而 kernel 只能依赖 `src/protocol`（见 SPEC-kernel 分层与
 * `tests/kernel/purity.test.ts`）。原 `plugins/shared/model-id.ts` 已删除，没有任何转出层：
 * 调度器与执行器用例都直接 import 这里。
 *
 * 两条历史事故的收口：
 * - **URL 编码**：模型目录把 `magpie/auto/deepseek-v4.1-flash` 存成
 *   `magpie/auto%2Fdeepseek-v4.1-flash`，解码前交给 `pi-ai` 会报
 *   `provider "magpie" has no configured model "auto%2Fdeepseek-v4.1-flash"`；
 * - **显示后缀**：模型选择器把上下文窗口标注写进 id（`...[1m]`），Claude Code 见到
 *   `minimax-code/MiniMax-M3.1-Flash-Preview[1m]` 直接报 `unrecognized_model`。
 *   方括号段是给人看的窗口标注，不是模型名的一部分，解析时剥掉。
 */

/** 末尾的显示后缀（`[1m]` / `[200k]` 之类）：只剥最后一组方括号，且括号内非空。 */
const DISPLAY_SUFFIX_RE = /\s*\[[^\]]+\]\s*$/

/**
 * 去掉模型 id 末尾的显示后缀（`deepseek-v4.1-flash[1m]` → `deepseek-v4.1-flash`）。
 *
 * 单独导出：保存智能体配置时要按同一口径归一，只在一处做会让「存进去的串」与
 * 「发出去的串」不一致。
 */
export function stripModelDisplaySuffix(value: string): string {
  return value.replace(DISPLAY_SUFFIX_RE, '').trim()
}

/** 解析 provider/model 形式的模型 id；格式不对返回 null（由调用方报错） */
export function parseModelId(value: string): { provider: string; id: string } | null {
  const trimmed = stripModelDisplaySuffix(value)
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
  const provider = stripModelDisplaySuffix(decode(trimmed.slice(0, index))).trim()
  const id = stripModelDisplaySuffix(decode(trimmed.slice(index + 1))).trim()
  if (!provider || !id) return null
  return { provider, id }
}

/**
 * 归一后的模型 id 串（`provider/id`，两侧不带显示后缀与空白）。
 *
 * 存进智能体配置的就是这个形态：解析、比较、展示三处读同一个串，避免
 * 「存 `auto%2F…[1m]`、发 `auto/…`」这类漂移。
 */
export function normalizeModelId(value: string): string | null {
  const parsed = parseModelId(value)
  // `parseModelId` 已经剥过后缀并保证两侧非空，这里只做拼装
  return parsed === null ? null : `${parsed.provider}/${parsed.id}`
}
