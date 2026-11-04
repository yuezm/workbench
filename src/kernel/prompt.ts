/**
 * 提示词拼装（纯函数）。
 *
 * - `taskPrompt`：阶段任务提示词，与迁移前 `host/task-effects.buildTaskPrompt` 逐字一致；
 * - `chatPrompt`：对话首轮提示词，与迁移前 `main/ai-workflow/chat.ts` 的 `buildChatPrompt`
 *   逐字一致；`titleFromContent` 也沿用旧实现的文案（首行、24 码点截断加省略号）。
 *
 * 提示词只由内核/宿主按模板拼装，事件与消息正文只作为资料段，不进指令段。
 */
import type { Agent, ChatRole, Message, Task } from '../protocol/entities'

export const taskPrompt = (agent: Agent, task: Task, stageName: string | null): string =>
  [
    agent.systemPrompt,
    `# 任务：${task.title}`,
    task.description,
    stageName ? `# 阶段：${stageName}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

/** prompt 里的角色文案（与旧 chat.ts 一致） */
const ROLE_LABEL: Record<ChatRole, string> = { user: '用户', assistant: '助手' }

/** 结尾提示：让 CLI 明确本轮要回答的是最后一条用户消息 */
const ANSWER_HINT = '请回答最后一条用户消息。'

/**
 * 由首条用户消息生成对话标题：取首行、去首尾空白，超过 24 字截断加省略号。
 * 按码点截断，避免把 emoji 的代理对切成半个字符。
 */
export function titleFromContent(content: string): string {
  const firstLine = content.split(/\r?\n/)[0].trim()
  if (!firstLine) return '新对话'
  const chars = Array.from(firstLine)
  return chars.length > 24 ? chars.slice(0, 24).join('') + '…' : firstLine
}

/**
 * 首轮 prompt：不依赖会话续接时，把 systemPrompt 与完整历史一起带上。
 * 结构：systemPrompt（非空才有） → # 对话记录 → 结尾提示。
 * 续接轮不走这里（只发新消息），由 `conversation.send` 决定。
 */
export function chatPrompt(agent: Agent, messages: readonly Message[]): string {
  const parts: string[] = []
  const system = agent.systemPrompt.trim()
  if (system) parts.push(system)
  parts.push('# 对话记录')
  parts.push(
    messages.map((message) => `${ROLE_LABEL[message.role]}：${message.content}`).join('\n'),
  )
  parts.push(ANSWER_HINT)
  return parts.join('\n\n')
}
