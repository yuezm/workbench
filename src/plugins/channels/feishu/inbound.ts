/**
 * `im.message.receive_v1` 事件解析（`src/plugins/channels/feishu/inbound.ts`）：纯函数。
 *
 * 事件行由 `lark-cli event consume im.message.receive_v1` 打印（一行一个 JSON）。**CLI 已经把
 * 事件摊平成一层**（`event schema im.message.receive_v1` 的输出即如此）：
 *
 * ```json
 * { "type": "im.message.receive_v1", "message_id": "om_…", "chat_id": "oc_…",
 *   "chat_type": "p2p", "message_type": "text", "content": "人话正文",
 *   "sender_id": "ou_…", "sender_type": "user", "mentions": [{ "key": "@_user_1" }] }
 * ```
 *
 * 两点容易踩：
 * - `content` 是**渲染好的人话**（不是 `{"text":…}` 那种 JSON），所以不做 JSON 解析；
 *   但如果某天变了形状（`{"text":…}`），这里也认得出来。
 * - 消息 id 用 `message_id`（`event_id` 是投递 id，重投会变，不能当幂等键）。
 *
 * 只认「人发的纯文本」：机器人自己发的（`sender_type` 为 bot/app）一律丢弃，否则会自问自答；
 * 图片、文件、富文本、卡片交互等非 `text` 类型也丢弃。
 */

/** 一条可派活的入站文本。 */
export interface InboundText {
  /** 平台消息 id（幂等键与回帖锚点） */
  messageId: string
  /** `p2p` = 私聊，`group` = 群（含话题群） */
  chatType: string
  /** 这条消息所在的会话 id（`oc_…`）：没配接收人时拿它当出站目标 */
  chatId: string | null
  /** 发送人 open_id（白名单判据） */
  sender: string
  /** 去掉 @ 占位符后的正文 */
  text: string
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** 非空字符串或 null（飞书对缺省字段给空串）。 */
const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 去掉正文里的 @ 占位符：飞书把 mention 渲染成 `@_user_1` 这类 key（或用事件里的
 * `mentions[].key` 给的那串），它对人没意义、对模型是噪音。
 */
export function stripMentions(raw: string, keys: readonly string[] = []): string {
  let result = raw
  for (const key of keys) {
    if (key === '') continue
    result = result.split(key).join(' ')
  }
  return result
    .replace(/@_user_\d+/gu, ' ')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim()
}

/** `mentions[].key`：要一起清掉的占位符（拿不到就只按通用形状清）。 */
function mentionKeys(source: Record<string, unknown>): string[] {
  const mentions = source['mentions']
  if (!Array.isArray(mentions)) return []
  const keys: string[] = []
  for (const item of mentions) {
    const record = asRecord(item)
    const key = record === null ? null : text(record['key'])
    if (key !== null) keys.push(key)
  }
  return keys
}

/** 正文：CLI 给的是人话；万一给的是 `{"text":…}` 也认。 */
function readContent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const body = raw.trim()
  if (body === '') return null
  if (body.startsWith('{')) {
    try {
      const parsed = asRecord(JSON.parse(body))
      const inner = parsed === null ? null : text(parsed['text'])
      if (inner !== null) return inner
    } catch {
      // 不是 JSON：就是正文本身
    }
  }
  return body
}

/** 发送人 open_id：摊平事件在 `sender_id`，v2 信封在 `sender.sender_id.open_id`。 */
function readSender(source: Record<string, unknown>): string | null {
  const flat = text(source['sender_id'])
  if (flat !== null) return flat
  const sender = asRecord(source['sender'])
  const senderId = asRecord(sender?.['sender_id'])
  return text(senderId?.['open_id'])
}

/** 发送人类型：`bot` / `app` 都是机器人（自己发的不该再触发自己）。 */
function isBot(source: Record<string, unknown>): boolean {
  const sender = asRecord(source['sender'])
  const type = text(source['sender_type']) ?? (sender === null ? null : text(sender['sender_type']))
  return type === 'bot' || type === 'app'
}

/**
 * 解析一行事件：不是「人发的纯文本」就返回 null。
 *
 * 判据顺序：摊平事件 / v2 信封 → 发送人类型（机器人丢弃）→ 发送人 → 消息类型 → 正文。
 * 群聊也在返回值里带上 `chatType`，「只做私聊」这类策略由通道决定，解析层不替它做主。
 */
export function readTextMessage(event: Record<string, unknown>): InboundText | null {
  // 摊平事件：字段直接在顶层；v2 信封：包在 event.message 里
  const outer = event['message_id'] === undefined ? (asRecord(event['event']) ?? event) : event
  const message = asRecord(outer['message']) ?? outer

  if (isBot(outer) || isBot(message)) return null
  const sender = readSender(outer) ?? readSender(message)
  if (sender === null) return null

  const messageId = text(message['message_id']) ?? text(outer['message_id'])
  if (messageId === null) return null

  const type = text(message['message_type'])
  // 没有类型字段时按纯文本处理（有的 profile 不返回），但显式给了别的类型就丢弃
  if (type !== null && type !== 'text') return null

  const raw = readContent(message['content'])
  if (raw === null) return null

  return {
    messageId,
    chatType: text(message['chat_type']) ?? text(outer['chat_type']) ?? 'p2p',
    chatId: text(message['chat_id']) ?? text(outer['chat_id']),
    sender,
    text: stripMentions(raw, mentionKeys(outer)),
  }
}
