/**
 * `card.action.trigger` 事件解析（`src/plugins/channels/feishu/click.ts`）：纯函数。
 *
 * 事件行由 `lark-cli event consume card.action.trigger` 打印（一行一个 JSON）：
 * 我们只认自己发出的**按钮**回调（`action_tag='button'` 且 `action_value` 是本插件写的
 * `{card, choice}`），表单提交、下拉选择、别人应用发的卡片一律不算答案。
 */
import type { FeishuClickValue } from './render'

/** 一次可计数的点击：卡 id、选项下标、操作人、消息 id（更新卡片用）。 */
export interface ClickedOption {
  cardId: string
  choice: number
  operator: string
  messageId: string | null
}

/** `action_value` 可能是对象，也可能是 JSON 字符串（飞书按字符串序列化下发）。 */
function readValue(raw: unknown): FeishuClickValue | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const card = record['card']
  const choice = record['choice']
  if (typeof card !== 'string' || card.trim() === '') return null
  if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0) return null
  return { card, choice }
}

/** 值为非空字符串时返回它（飞书对缺省字段给空串）。 */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 解析一行事件：不是本插件的按钮回调就返回 null（调用方只记一条日志，不计数）。
 *
 * 判据顺序：组件类型 → 表单提交（`form_value` 非空 = 表单按钮，我们不用表单）→ 回传值。
 */
export function readClick(event: Record<string, unknown>): ClickedOption | null {
  const tag = event['action_tag']
  if (typeof tag === 'string' && tag !== 'button') return null
  const form = event['form_value']
  if (typeof form === 'string' && form.trim() !== '' && form.trim() !== '{}') return null
  const value = readValue(event['action_value'])
  if (value === null) return null
  const operator = text(event['operator_id'])
  if (operator === null) return null
  return {
    cardId: value.card,
    choice: value.choice,
    operator,
    messageId: text(event['message_id']),
  }
}
