// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ChatStreamEvent, RunEvent } from '../../shared/ai-workflow-api'
import { buildChatPrompt, ChatService, titleFromContent } from './chat'
import { Repository } from './repository'
import type { DshRunOutcome, DshRunRequest } from './runtime/dsh'
import type { RuntimeBackend } from './runtime/registry'
import {
  createAgent,
  createRuntime,
  createWorld,
  resetCommandIds,
  updateRuntime,
  type TestWorld,
} from './test-support'

let world: TestWorld
let repo: Repository

function outcome(over: Partial<DshRunOutcome> = {}): DshRunOutcome {
  return {
    status: 'succeeded',
    output: '回答',
    error: null,
    errorCode: null,
    exitCode: 0,
    sessionId: 'sess-new',
    resumeRejected: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    durationMs: 1,
    ...over,
  }
}

interface Harness {
  service: ChatService
  conversationId: string
  execute: ExecuteMock
  events: ChatStreamEvent[]
}

type ExecuteMock = Mock<(request: DshRunRequest) => Promise<DshRunOutcome>>

function harness(
  execute: RuntimeBackend['execute'],
  options: { systemPrompt?: string } = {},
): Harness {
  const runtime = createRuntime(world, { name: 'r-' + Math.random().toString(36).slice(2, 8) })
  const agent = createAgent(world, {
    name: 'coder',
    runtimeId: runtime.id,
    systemPrompt: options.systemPrompt ?? '你是助手',
  })
  const conversation = repo.chatConversationCreate(agent.id)
  const events: ChatStreamEvent[] = []
  const service = new ChatService({
    repo,
    emit: (event) => events.push(event),
    backendFor: () => ({
      probe: vi.fn(),
      models: vi.fn(),
      execute: execute as RuntimeBackend['execute'],
    }),
    requestId: () => 'req-1',
    timeoutMs: 1_000,
  })
  return {
    service,
    conversationId: conversation.id,
    execute: execute as unknown as ExecuteMock,
    events,
  }
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('等待超时')
}

beforeEach(() => {
  resetCommandIds()
  world = createWorld()
  repo = world.repo
})
afterEach(() => world.db.close())

describe('titleFromContent', () => {
  it('取首行、去空白、超长截断', () => {
    expect(titleFromContent('  第一行\n第二行 ')).toBe('第一行')
    expect(titleFromContent('')).toBe('新对话')
    expect(titleFromContent('   \n ')).toBe('新对话')
    const long = '字'.repeat(30)
    expect(titleFromContent(long)).toBe('字'.repeat(24) + '…')
  })
})

describe('buildChatPrompt', () => {
  it('有 systemPrompt 时放在最前，并带对话记录与结尾提示', () => {
    const prompt = buildChatPrompt(
      { systemPrompt: '规则' } as never,
      [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '在' },
      ] as never,
    )
    expect(prompt.startsWith('规则')).toBe(true)
    expect(prompt).toContain('# 对话记录')
    expect(prompt).toContain('用户：你好')
    expect(prompt).toContain('助手：在')
    expect(prompt).toContain('请回答最后一条用户消息。')
  })

  it('systemPrompt 为空时不插入空段', () => {
    const prompt = buildChatPrompt(
      { systemPrompt: '  ' } as never,
      [{ role: 'user', content: 'hi' }] as never,
    )
    expect(prompt.startsWith('# 对话记录')).toBe(true)
  })
})

describe('ChatService', () => {
  it('首轮：写用户消息、执行、落助手消息并记录会话 id', async () => {
    const execute = vi.fn(async (_request: DshRunRequest) => outcome({ output: '你好呀' }))
    const h = harness(execute)
    await h.service.send(h.conversationId, '你好')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)

    const messages = repo.chatMessagesList(h.conversationId)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1].content).toBe('你好呀')
    expect(messages[1].error).toBeNull()
    expect(repo.chatConversationGet(h.conversationId).sessionId).toBe('sess-new')
    expect(repo.chatConversationGet(h.conversationId).title).toBe('你好')

    const request = execute.mock.calls[0][0]
    expect(request.prompt).toContain('你是助手')
    expect(request.prompt).toContain('用户：你好')
    expect(request.resumeSessionId).toBeNull()
    expect(h.events.at(-1)).toEqual({ conversationId: h.conversationId, type: 'end' })
  })

  it('事件按流推送（text/tool），助手消息内容以最终输出为准', async () => {
    const execute = vi.fn(async ({ onEvent }: { onEvent?: (event: RunEvent) => void }) => {
      onEvent?.({ seq: 1, type: 'status', status: 'running' })
      onEvent?.({ seq: 2, type: 'text', text: '流式' })
      onEvent?.({ seq: 3, type: 'tool_call', tool: 'read', callId: 'c1', input: '{}' })
      return outcome({ output: '最终' })
    })
    const h = harness(execute)
    await h.service.send(h.conversationId, '问题')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)

    const types = h.events.filter((e) => e.type === 'event').map((e) => e.event?.type)
    expect(types).toEqual(['status', 'text', 'tool_call'])
    expect(repo.chatMessagesList(h.conversationId)[1].content).toBe('最终')
  })

  it('第二轮起用会话续接：只发新消息并带上 session id', async () => {
    const execute = vi.fn(async (_request: DshRunRequest) => outcome({ output: '一' }))
    const h = harness(execute)
    await h.service.send(h.conversationId, '第一问')
    await waitFor(() => repo.chatConversationGet(h.conversationId).sessionId === 'sess-new')

    execute.mockImplementation(async () => outcome({ output: '二', sessionId: 'sess-2' }))
    await h.service.send(h.conversationId, '第二问')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 4)
    const second = execute.mock.calls[1][0]
    expect(second.prompt).toBe('第二问')
    expect(second.resumeSessionId).toBe('sess-new')
    expect(repo.chatConversationGet(h.conversationId).sessionId).toBe('sess-2')
  })

  it('续接被拒：清 session 后用完整历史重试一次', async () => {
    const execute = vi.fn(async (_request: DshRunRequest) => outcome({ output: '一' }))
    const h = harness(execute)
    await h.service.send(h.conversationId, '第一问')
    await waitFor(() => repo.chatConversationGet(h.conversationId).sessionId === 'sess-new')

    execute.mockImplementationOnce(async () =>
      outcome({
        status: 'failed',
        output: '',
        error: '会话失效',
        resumeRejected: true,
        sessionId: 'sess-new',
      }),
    )
    execute.mockImplementationOnce(async () => outcome({ output: '重试成功', sessionId: 'sess-3' }))
    await h.service.send(h.conversationId, '第二问')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 4)

    expect(execute).toHaveBeenCalledTimes(3)
    const retry = execute.mock.calls[2][0]
    expect(retry.resumeSessionId).toBeNull()
    expect(retry.prompt).toContain('# 对话记录')
    const assistant = repo.chatMessagesList(h.conversationId)[3]
    expect(assistant.content).toBe('重试成功')
    expect(assistant.error).toBeNull()
    expect(repo.chatConversationGet(h.conversationId).sessionId).toBe('sess-3')
  })

  it('续接两次都被拒：落一条失败消息，不再重试', async () => {
    const execute = vi.fn(async (_request: DshRunRequest) =>
      outcome({ resumeRejected: true, status: 'failed' }),
    )
    const h = harness(execute)
    await h.service.send(h.conversationId, '问')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(repo.chatMessagesList(h.conversationId)[1].error).toBe('执行失败')
  })

  it('失败：助手消息记录 error，但保留会话 id 供续接', async () => {
    const execute = vi.fn(async (_request: DshRunRequest) =>
      outcome({ status: 'failed', output: '', error: '退出码 1', errorCode: 'exit_nonzero' }),
    )
    const h = harness(execute)
    await h.service.send(h.conversationId, '问')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)
    expect(repo.chatMessagesList(h.conversationId)[1].error).toBe('退出码 1')
    expect(repo.chatConversationGet(h.conversationId).sessionId).toBe('sess-new')
  })

  it('取消：助手消息记「已取消」', async () => {
    const execute = (({ signal }: { signal: AbortSignal }) =>
      new Promise<DshRunOutcome>((resolve) => {
        signal.addEventListener('abort', () =>
          resolve(outcome({ status: 'cancelled', output: '', error: '已取消' })),
        )
      })) as unknown as RuntimeBackend['execute']
    const h = harness(execute)
    await h.service.send(h.conversationId, '问')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.service.isRunning(h.conversationId)).toBe(true)
    h.service.cancel(h.conversationId)
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)
    expect(repo.chatMessagesList(h.conversationId)[1].error).toBe('已取消')
    expect(h.service.isRunning(h.conversationId)).toBe(false)
  })

  it('后端抛错：助手消息记录异常信息', async () => {
    const execute = vi.fn(async (_request: DshRunRequest) => {
      throw new Error('spawn 失败')
    })
    const h = harness(execute)
    await h.service.send(h.conversationId, '问')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)
    expect(repo.chatMessagesList(h.conversationId)[1].error).toBe('spawn 失败')
  })

  it('空消息 / 执行中重复发送：明确报错', async () => {
    const execute = (({ signal }: { signal: AbortSignal }) =>
      new Promise<DshRunOutcome>((resolve) => {
        signal.addEventListener('abort', () => resolve(outcome({ status: 'cancelled' })))
      })) as unknown as RuntimeBackend['execute']
    const h = harness(execute)
    await expect(h.service.send(h.conversationId, '   ')).rejects.toThrow(/不能为空/)
    await h.service.send(h.conversationId, '问')
    await expect(h.service.send(h.conversationId, '再问')).rejects.toThrow(/正在执行/)
    h.service.cancel(h.conversationId)
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)
  })

  it('运行时停用：发送前就报错，不写消息', async () => {
    const h = harness(vi.fn(async (_request: DshRunRequest) => outcome()))
    const conversation = repo.chatConversationGet(h.conversationId)
    const agent = repo.agentGet(conversation.agentId)
    updateRuntime(world, agent.runtimeId, { enabled: false })
    await expect(h.service.send(h.conversationId, '问')).rejects.toThrow(/已停用/)
    expect(repo.chatMessagesList(h.conversationId)).toHaveLength(0)
  })

  it('对话不存在：报错', async () => {
    const h = harness(vi.fn(async (_request: DshRunRequest) => outcome()))
    await expect(h.service.send('ghost', '问')).rejects.toThrow(/对话不存在/)
  })

  it('执行期间对话被删除：不抛错且仍发 end 事件', async () => {
    let release: (() => void) | null = null
    const execute = (() =>
      new Promise<DshRunOutcome>((resolve) => {
        release = () => resolve(outcome())
      })) as unknown as RuntimeBackend['execute']
    const h = harness(execute)
    await h.service.send(h.conversationId, '问')
    await new Promise((resolve) => setTimeout(resolve, 5))
    repo.chatConversationRemove(h.conversationId)
    ;(release as unknown as () => void)()
    await waitFor(() => h.events.some((e) => e.type === 'end'))
  })

  it('推送失败不影响收尾（emit 抛错被吞掉）', async () => {
    const runtime = createRuntime(world, { name: 'r2' })
    const agent = createAgent(world, { name: 'a', runtimeId: runtime.id })
    const conversation = repo.chatConversationCreate(agent.id)
    const service = new ChatService({
      repo,
      emit: () => {
        throw new Error('window gone')
      },
      backendFor: () => ({
        probe: vi.fn(),
        models: vi.fn(),
        execute: vi.fn(async (_request: DshRunRequest) => outcome()),
      }),
    })
    await service.send(conversation.id, '问')
    await waitFor(() => repo.chatMessagesList(conversation.id).length === 2)
    expect(repo.chatMessagesList(conversation.id)[1].content).toBe('回答')
  })

  it('首轮 systemPrompt 为空：prompt 直接从对话记录开始', async () => {
    const h = harness(
      vi.fn(async (_request: DshRunRequest) => outcome()),
      { systemPrompt: '' },
    )
    await h.service.send(h.conversationId, '问')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)
    const sent = h.execute.mock.calls[0][0]
    expect(sent.prompt.startsWith('# 对话记录')).toBe(true)
    expect(sent.prompt).not.toContain('undefined')
  })

  it('首条消息即长文本：会话标题按码点截断', async () => {
    const h = harness(vi.fn(async (_request: DshRunRequest) => outcome()))
    await h.service.send(h.conversationId, '字'.repeat(30))
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)
    const title = repo.chatConversationGet(h.conversationId).title
    expect(title).toBe('字'.repeat(24) + '…')
    expect(Array.from(title)).toHaveLength(25)
  })

  it('没有会话可续接时，失败后的下一轮仍走完整 prompt', async () => {
    const execute = vi.fn(async (_request: DshRunRequest) =>
      outcome({
        status: 'failed',
        output: '',
        error: '退出码 1',
        sessionId: null,
        errorCode: 'exit_nonzero',
      }),
    )
    const h = harness(execute)
    await h.service.send(h.conversationId, '第一问')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)
    expect(repo.chatConversationGet(h.conversationId).sessionId).toBeNull()

    execute.mockImplementation(async (_request: DshRunRequest) => outcome({ output: '二' }))
    await h.service.send(h.conversationId, '第二问')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 4)
    const second = execute.mock.calls[1][0]
    expect(second.resumeSessionId).toBeNull()
    expect(second.prompt).toContain('# 对话记录')
    expect(second.prompt).toContain('第一问')
    expect(repo.chatMessagesList(h.conversationId)[3].content).toBe('二')
  })

  it('续接被拒且重试也失败：落一条失败消息，会话保持为空', async () => {
    const execute = vi.fn(async (_request: DshRunRequest) =>
      outcome({
        status: 'failed',
        output: '',
        error: '会话失效',
        sessionId: null,
        resumeRejected: true,
      }),
    )
    const h = harness(execute)
    await h.service.send(h.conversationId, '问')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(repo.chatMessagesList(h.conversationId)[1].error).toBe('执行失败')
    expect(repo.chatConversationGet(h.conversationId).sessionId).toBeNull()
  })

  it('取消空闲对话/未知对话是无害的', () => {
    const h = harness(vi.fn(async (_request: DshRunRequest) => outcome()))
    expect(h.service.isRunning(h.conversationId)).toBe(false)
    expect(() => h.service.cancel(h.conversationId)).not.toThrow()
    expect(() => h.service.cancel('ghost')).not.toThrow()
    expect(h.service.isRunning('ghost')).toBe(false)
  })

  it('成功一轮只发一次 end，事件不落库为额外消息', async () => {
    const h = harness(
      vi.fn(async ({ onEvent }: DshRunRequest) => {
        onEvent?.({ seq: 1, type: 'text', text: 'x' })
        onEvent?.({ seq: 2, type: 'tool_call', tool: 'read', callId: 'c1', input: '{}' })
        return outcome({ output: 'x' })
      }),
    )
    await h.service.send(h.conversationId, '问')
    await waitFor(() => repo.chatMessagesList(h.conversationId).length === 2)
    expect(h.events.filter((e) => e.type === 'end')).toHaveLength(1)
    expect(h.events.filter((e) => e.type === 'event')).toHaveLength(2)
    expect(h.events.at(-1)?.type).toBe('end')
    expect(repo.chatMessagesList(h.conversationId)).toHaveLength(2)
  })
})

describe('默认 requestId', () => {
  it('不注入 requestId 时用 uuid', async () => {
    const runtime = createRuntime(world, { name: 'r-default' })
    const agent = createAgent(world, { name: 'a', runtimeId: runtime.id })
    const conversation = repo.chatConversationCreate(agent.id)
    const execute = vi.fn(async (_request: DshRunRequest) => outcome())
    const service = new ChatService({
      repo,
      emit: () => {},
      backendFor: () => ({ probe: vi.fn(), models: vi.fn(), execute }),
    })
    await service.send(conversation.id, '问')
    await waitFor(() => repo.chatMessagesList(conversation.id).length === 2)
    const sent = execute.mock.calls[0][0] as unknown as { requestId: string }
    expect(sent.requestId).toMatch(/[0-9a-f-]{36}/)
    expect(repo.chatMessagesList(conversation.id)[1].content).toBe('回答')
  })
})
describe('titleFromContent 边界', () => {
  it('24 字不截断、25 字截断、\\r\\n 取首行', () => {
    expect(titleFromContent('字'.repeat(24))).toBe('字'.repeat(24))
    expect(titleFromContent('字'.repeat(25))).toBe('字'.repeat(24) + '…')
    expect(titleFromContent('a\r\nb')).toBe('a')
  })
})

describe('buildChatPrompt 顺序', () => {
  it('按时间顺序拼接，结尾是回答提示', () => {
    const prompt = buildChatPrompt(
      { systemPrompt: 'S' } as never,
      [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ] as never,
    )
    expect(prompt.indexOf('用户：u1')).toBeLessThan(prompt.indexOf('助手：a1'))
    expect(prompt.indexOf('助手：a1')).toBeLessThan(prompt.indexOf('用户：u2'))
    expect(prompt.endsWith('请回答最后一条用户消息。')).toBe(true)
  })
})

describe('chat 失败兜底分支', () => {
  function serviceWith(execute: RuntimeBackend['execute']): {
    service: ChatService
    conversationId: string
  } {
    const runtime = createRuntime(world, { name: 'r-' + Math.random().toString(36).slice(2, 8) })
    const agent = createAgent(world, { name: 'a', runtimeId: runtime.id })
    const conversation = repo.chatConversationCreate(agent.id)
    const service = new ChatService({
      repo,
      emit: () => {},
      backendFor: () => ({ probe: vi.fn(), models: vi.fn(), execute }),
    })
    return { service, conversationId: conversation.id }
  }

  it('失败但有流式文本：助手消息用流式内容；error 为空时给兜底文案', async () => {
    const execute = (async ({ onEvent }: DshRunRequest) => {
      onEvent?.({ seq: 1, type: 'text', text: '流式片段' })
      return outcome({ status: 'failed', output: '', error: null, errorCode: 'run_failed' })
    }) as unknown as RuntimeBackend['execute']
    const { service, conversationId } = serviceWith(execute)
    await service.send(conversationId, '问')
    await waitFor(() => repo.chatMessagesList(conversationId).length === 2)
    const assistant = repo.chatMessagesList(conversationId)[1]
    expect(assistant.content).toBe('流式片段')
    expect(assistant.error).toBe('执行失败')
  })

  it('后端抛非 Error：错误文案转成字符串', async () => {
    const execute = (() => Promise.reject('字符串错误')) as unknown as RuntimeBackend['execute']
    const { service, conversationId } = serviceWith(execute)
    await service.send(conversationId, '问')
    await waitFor(() => repo.chatMessagesList(conversationId).length === 2)
    expect(repo.chatMessagesList(conversationId)[1].error).toBe('字符串错误')
  })
})
