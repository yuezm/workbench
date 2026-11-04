import { randomUUID } from 'node:crypto'
import type {
  Agent,
  ChatMessage,
  ChatRole,
  ChatStreamEvent,
  RunEvent,
  Runtime,
  RuntimeProtocolFamily,
} from '../../shared/ai-workflow-api'
import type { Repository } from './repository'
import type { RuntimeBackend } from './runtime/registry'
import { RUN_TIMEOUT_MS } from './runtime/dsh'

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
 * 首轮 prompt：不依赖会话续接时，把 systemPrompt 与完整历史一起带上。
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
  /** 按协议族返回后端（装配时注入；测试用假后端） */
  backendFor: (family: RuntimeProtocolFamily) => RuntimeBackend
  requestId?: () => string
  timeoutMs?: number
}

/** 一轮执行的上下文：send 同步准备，execute 后台跑完 */
interface ChatTurn {
  conversationId: string
  /** 本轮用户消息（续接时只发这一条） */
  message: string
  /** 首轮/重试用完整 prompt（含历史与 systemPrompt） */
  fullPrompt: string
  runtime: Runtime
  /** 上一轮的协议会话 id；null 表示新会话 */
  resumeSessionId: string | null
  controller: AbortController
}

/**
 * 主动对话执行服务：每轮一个独立进程，事件经 emit 实时推送。
 * 第二轮起优先用协议会话续接，只发新消息；续接失效时自动回退成整段历史重试一次。
 */
export class ChatService {
  private readonly repo: Repository
  private readonly emit: (event: ChatStreamEvent) => void
  private readonly backendFor: (family: RuntimeProtocolFamily) => RuntimeBackend
  private readonly requestId: () => string
  private readonly timeoutMs: number
  private readonly controllers = new Map<string, AbortController>()

  constructor(deps: ChatServiceDeps) {
    this.repo = deps.repo
    this.emit = deps.emit
    this.backendFor = deps.backendFor
    this.requestId = deps.requestId ?? (() => randomUUID())
    this.timeoutMs = deps.timeoutMs ?? RUN_TIMEOUT_MS
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
    if (!runtime.enabled) throw new Error('运行时已停用，请先在设置里启用')

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
      message: text,
      fullPrompt: buildChatPrompt(agent, [...history, userMessage]),
      runtime,
      resumeSessionId: conversation.sessionId,
      controller,
    })
  }

  /**
   * 执行一轮：结束后落库一条 assistant 消息。
   * 调用方是 `void`，这里必须把异常全部兜住，否则会变成 unhandled rejection。
   */
  private async execute(turn: ChatTurn): Promise<void> {
    const { conversationId } = turn
    try {
      let attempt: { output: string; error: string | null; sessionId: string | null } | null = null
      let resumeSessionId = turn.resumeSessionId

      // 续接失效（resume_rejected）时清掉本地会话，用完整历史重试一次
      for (let round = 0; round < 2; round += 1) {
        attempt = await this.runOnce(turn, resumeSessionId)
        if (attempt.sessionId === REJECTED) {
          resumeSessionId = null
          this.safeSetSession(conversationId, null)
          attempt = null
          continue
        }
        break
      }

      const result = attempt ?? { output: '', error: '执行失败', sessionId: null }
      try {
        this.repo.chatMessageCreate({
          conversationId,
          role: 'assistant',
          content: result.output,
          error: result.error,
        })
        this.repo.chatConversationTouch(conversationId)
      } catch {
        // 对话在执行期间被删除：消息无处可落，本轮仍然要正常结束
      }
      if (result.sessionId) this.safeSetSession(conversationId, result.sessionId)
    } finally {
      this.controllers.delete(conversationId)
      this.safeEmit({ conversationId, type: 'end' })
    }
  }

  /** 跑一次后端；返回的 sessionId 为 REJECTED 表示续接被拒，需要回退重试 */
  private async runOnce(
    turn: ChatTurn,
    resumeSessionId: string | null,
  ): Promise<{ output: string; error: string | null; sessionId: string | null }> {
    const { conversationId, controller } = turn
    let streamed = ''
    const backend = this.backendFor(turn.runtime.protocolFamily)

    try {
      const outcome = await backend.execute({
        runtime: turn.runtime,
        requestId: this.requestId(),
        prompt: resumeSessionId ? turn.message : turn.fullPrompt,
        resumeSessionId,
        timeoutMs: this.timeoutMs,
        signal: controller.signal,
        onEvent: (event: RunEvent) => {
          if (event.type === 'text' && event.text) streamed += event.text
          this.safeEmit({ conversationId, type: 'event', event })
        },
      })
      if (outcome.resumeRejected) return { output: '', error: null, sessionId: REJECTED }
      if (controller.signal.aborted) {
        return { output: outcome.output || streamed, error: '已取消', sessionId: null }
      }
      if (outcome.status === 'succeeded') {
        return {
          output: outcome.output || streamed,
          error: null,
          sessionId: outcome.sessionId,
        }
      }
      return {
        output: outcome.output || streamed,
        error: outcome.error ?? '执行失败',
        sessionId: outcome.sessionId,
      }
    } catch (e) {
      return {
        output: streamed,
        error: controller.signal.aborted ? '已取消' : e instanceof Error ? e.message : String(e),
        sessionId: null,
      }
    }
  }

  /** 写会话 id；对话已被删除时忽略 */
  private safeSetSession(conversationId: string, sessionId: string | null): void {
    try {
      this.repo.chatConversationSetSession(conversationId, sessionId)
    } catch {
      // 对话已删除：没有可写的记录
    }
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

/** 续接被拒的内部信号（不进入数据库/契约） */
const REJECTED = '\u0000resume-rejected'
