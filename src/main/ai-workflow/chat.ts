import type {
  Agent,
  ChatMessage,
  ChatRole,
  ChatStreamEvent,
  Runtime,
} from '../../shared/ai-workflow-api'
import type { Repository } from './repository'
import { createDeepseekHarnessAdapter, type RuntimeAdapter } from './runtime/deepseek-harness'

/** prompt 里的角色文案 */
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
 * 组装本轮完整 prompt：不依赖 CLI 会话续接，每轮都把完整历史带上。
 * 结构：systemPrompt（非空才有） → # 对话记录 → 结尾提示。
 */
export function buildChatPrompt(agent: Agent, messages: ChatMessage[]): string {
  const parts: string[] = []
  const system = agent.systemPrompt.trim()
  if (system) parts.push(system)
  parts.push('# 对话记录')
  parts.push(messages.map((m) => `${ROLE_LABEL[m.role]}：${m.content}`).join('\n'))
  parts.push(ANSWER_HINT)
  return parts.join('\n\n')
}

export interface ChatServiceDeps {
  repo: Repository
  emit: (event: ChatStreamEvent) => void
  /** 可注入：按运行时返回适配器（测试用假 adapter，避免真实 spawn） */
  adapterFor?: (runtime: Runtime) => RuntimeAdapter
}

/** 一轮执行的上下文：send 同步准备，execute 后台跑完 */
interface ChatTurn {
  conversationId: string
  prompt: string
  runtime: Runtime
  controller: AbortController
}

/** 主动对话执行服务：每轮独立进程，输出经 emit 实时推送。 */
export class ChatService {
  private readonly repo: Repository
  private readonly emit: (event: ChatStreamEvent) => void
  private readonly adapterFor: (runtime: Runtime) => RuntimeAdapter
  private readonly controllers = new Map<string, AbortController>()

  constructor(deps: ChatServiceDeps) {
    this.repo = deps.repo
    this.emit = deps.emit
    this.adapterFor = deps.adapterFor ?? createDeepseekHarnessAdapter
  }

  isRunning(conversationId: string): boolean {
    return this.controllers.has(conversationId)
  }

  cancel(conversationId: string): void {
    this.controllers.get(conversationId)?.abort()
  }

  /** 发起一轮：用户消息落库、controller 注册后立刻返回，执行走后台。 */
  async send(conversationId: string, content: string): Promise<void> {
    const text = content.trim()
    if (!text) throw new Error('消息内容不能为空')
    if (this.isRunning(conversationId)) throw new Error('该对话正在执行中，请先等待或中止')

    const conversation = this.repo.chatConversationGet(conversationId)
    const agent = this.repo.agentGet(conversation.agentId)
    const runtime = this.repo.runtimeGet(agent.runtimeId)
    // 先读历史，再落本轮用户消息：历史为空说明这是首条，用它给对话命名
    const history = this.repo.chatMessagesList(conversationId)
    const userMessage = this.repo.chatMessageCreate({ conversationId, role: 'user', content: text })
    if (history.length === 0) {
      this.repo.chatConversationRename(conversationId, titleFromContent(text))
    }

    const controller = new AbortController()
    this.controllers.set(conversationId, controller)
    void this.execute({
      conversationId,
      prompt: buildChatPrompt(agent, [...history, userMessage]),
      runtime,
      controller,
    })
  }

  /**
   * 执行一轮：结束后落库一条 assistant 消息。
   * 调用方是 `void`，这里必须把异常全部兜住，否则会变成 unhandled rejection。
   */
  private async execute(turn: ChatTurn): Promise<void> {
    const { conversationId, runtime, controller } = turn
    let output = ''
    let error: string | null = null

    try {
      const adapter = this.adapterFor(runtime)
      const result = await adapter.run({
        prompt: turn.prompt,
        workdir: runtime.workdir ?? process.cwd(),
        signal: controller.signal,
        onOutput: (chunk) => {
          output += chunk
          this.safeEmit({ conversationId, type: 'chunk', chunk })
        },
      })
      if (controller.signal.aborted) error = '已取消'
      else if (result.code !== 0) error = `退出码 ${result.code}`
      else output = result.output
    } catch (e) {
      // 中止会让适配器直接 reject，优先按取消记录
      if (controller.signal.aborted) error = '已取消'
      else if (e instanceof Error) error = e.message
      else error = String(e)
    }

    try {
      this.repo.chatMessageCreate({ conversationId, role: 'assistant', content: output, error })
      this.repo.chatConversationTouch(conversationId)
    } catch {
      // 对话在执行期间被删除：消息无处可落，本轮仍然要正常结束
    }
    this.controllers.delete(conversationId)
    this.safeEmit({ conversationId, type: 'end' })
  }

  /** 推送失败（窗口已销毁）不影响执行结果落库，也不能打断本轮。 */
  private safeEmit(event: ChatStreamEvent): void {
    try {
      this.emit(event)
    } catch {
      // 订阅端已失效：丢弃本次推送
    }
  }
}
