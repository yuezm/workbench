// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClock } from '../../src/host/clock'
import { openDatabase } from '../../src/host/db'
import { createEffects } from '../../src/host/effects'
import {
  createExecutorPort,
  type ExecutorBackend,
  type ExecutorBackendOutcome,
  type ExecutorBackendRequest,
} from '../../src/host/executor'
import { chatPrompt } from '../../src/kernel/prompt'
import { createProcessRegistry } from '../../src/host/process-registry'
import { createScheduler, type Scheduler } from '../../src/host/scheduler'
import { createStore, type Store } from '../../src/host/store/index'
import { decide } from '../../src/kernel/decide'
import { project } from '../../src/kernel/project'
import { viewSpec } from '../../src/kernel/view-spec'
import type { KernelPort } from '../../src/kernel/types'
import { createAiWorkflowHandler, type AiWorkflowHandler } from '../../src/main/ai-workflow/ipc'
import { Repository } from '../../src/main/ai-workflow/repository'
import type { RuntimeBackend } from '../../src/main/ai-workflow/runtime/registry'
import type { ChatConversation, ChatMessage, RunEvent } from '../../src/shared/ai-workflow-api'

/**
 * T14b：聊天执行链（scheduler + effects + IPC）端到端用例。
 *
 * 覆盖旧 `ChatService` 的 27 例行为（标题/首轮/续接/续接被拒/并发/取消/事件流/错误文案/
 * emit 失败吞掉）；纯函数 `titleFromContent` / `chatPrompt` 的用例已由
 * `tests/kernel/prompt.test.ts` 承接，dsh 的「输出为空时用流式文本」由
 * `tests/main/ai-workflow/runtime/dsh.test.ts` 承接（执行器负责，宿主不重复）。
 */

const kernel: KernelPort = { decide, project, viewSpec }
const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** 后端一轮结果（默认成功空输出）。 */
const outcome = (over: Partial<ExecutorBackendOutcome> = {}): ExecutorBackendOutcome => ({
  status: 'succeeded',
  output: '',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: null,
  resumeRejected: false,
  usage,
  durationMs: 1,
  ...over,
})

type Frame = Omit<RunEvent, 'seq'>

interface StreamRecord {
  conversationId: string
  type: 'event' | 'end'
  event?: RunEvent
}

interface World {
  db: DatabaseSync
  store: Store
  repo: Repository
  scheduler: Scheduler
  handler: AiWorkflowHandler
  streams: StreamRecord[]
  /** 后端收到的每一轮请求（断言 prompt / resumeSessionId / requestId） */
  requests: ExecutorBackendRequest[]
  /** 让聊天旁路抛错（模拟窗口销毁） */
  breakStream: { value: boolean }
  /** 唯一定时器（对齐装配顺序；聊天用例本身不推进它） */
  clock: ReturnType<typeof createClock>
}

let world: World
let commandSeq = 0

const nextCommandId = (): string => {
  commandSeq += 1
  return `cmd-${commandSeq}`
}

/** 建 world：store + effects + scheduler（真实适配器）+ IPC handler，全部接在内存库上。 */
function makeWorld(backend: ExecutorBackend): World {
  const db = openDatabase(':memory:')
  const store = createStore({ db, kernel })
  store.ensureProjection()
  const repo = new Repository(db)
  const registry = createProcessRegistry(db)
  const streams: StreamRecord[] = []
  const breakStream = { value: false }
  const holder: { scheduler?: Scheduler } = {}
  const effects = createEffects({
    store,
    scheduler: () => {
      if (!holder.scheduler) throw new Error('调度器尚未装配')
      return holder.scheduler
    },
  })
  const scheduler = createScheduler({
    dispatch: (input) => effects.dispatch(input),
    runtimes: () => store.query('runtimes.all'),
    // 走真实适配层：续接重试 / 错误文案归一都被覆盖
    executors: { forRuntime: () => createExecutorPort(backend) },
    registry,
    limits: {
      heartbeatMs: 30_000,
      runTimeoutMs: 600_000,
      maxFramesPerBatch: 500,
      cancelGraceMs: 20,
      killAfterMs: 20,
    },
    chatFallbackPrompt: (run) => {
      if (run.purpose !== 'chat' || run.conversationId === null) return null
      const agent = store.query('agents.all').find((item) => item.id === run.agentId)
      const messages = store.query('messages.byConversation', {
        conversationId: run.conversationId,
      })
      return agent && messages.length > 0 ? chatPrompt(agent, messages) : null
    },
    onChatStream: (conversationId, event) => {
      if (breakStream.value) throw new Error('窗口已销毁')
      streams.push({ conversationId, type: 'event', event })
    },
    onChatStreamEnd: (conversationId) => {
      streams.push({ conversationId, type: 'end' })
    },
  })
  holder.scheduler = scheduler
  const handler = createAiWorkflowHandler({
    store,
    dispatch: (input) => effects.dispatch(input),
    repo,
    backendFor: () =>
      ({
        probe: vi.fn(),
        models: vi.fn(),
        execute: vi.fn(),
      }) as unknown as RuntimeBackend,
    newCommandId: nextCommandId,
  })
  const clock = createClock({
    store: { dispatch: (input) => effects.dispatch(input), nextWakeAt: () => null },
    now: () => new Date().toISOString(),
    onTick: () => scheduler.wake(),
  })
  return { db, store, repo, scheduler, handler, streams, requests: [], breakStream, clock }
}

/** 后端按脚本返回：每次 execute 调一次 handler，同时记录请求。 */
function scripted(handler: (request: ExecutorBackendRequest, index: number) => unknown): {
  backend: ExecutorBackend
  requests: ExecutorBackendRequest[]
} {
  const requests: ExecutorBackendRequest[] = []
  const backend: ExecutorBackend = {
    async execute(request) {
      requests.push(request)
      const result = handler(request, requests.length - 1)
      return (await result) as ExecutorBackendOutcome
    },
  }
  return { backend, requests }
}

/** 建运行时 + 智能体（聊天只需要这两样，不进工作流）。 */
function seedAgent(systemPrompt = '你是助手。'): { runtimeId: string; agentId: string } {
  const runtimeFacts = world.store.dispatch({
    type: 'runtime.create',
    commandId: nextCommandId(),
    input: { name: 'rt', command: 'dsh' },
  }).facts
  const runtimeId = (
    runtimeFacts.find((fact) => fact.type === 'runtime.created')?.payload as {
      runtime: { id: string }
    }
  ).runtime.id
  const agentFacts = world.store.dispatch({
    type: 'agent.create',
    commandId: nextCommandId(),
    input: { name: 'coder', runtimeId, systemPrompt },
  }).facts
  const agentId = (
    agentFacts.find((fact) => fact.type === 'agent.created')?.payload as {
      agent: { id: string }
    }
  ).agent.id
  return { runtimeId, agentId }
}

const createConversation = (agentId: string): ChatConversation =>
  world.handler('chat.createConversation', [agentId]) as ChatConversation

const send = (conversationId: string, content: string): unknown =>
  world.handler('chat.send', [conversationId, content])

const messagesOf = (conversationId: string): ChatMessage[] =>
  world.handler('chat.listMessages', [conversationId]) as ChatMessage[]

const conversations = (): ChatConversation[] =>
  world.handler('chat.listConversations', []) as ChatConversation[]

const conversationOf = (id: string): ChatConversation => {
  const found = conversations().find((item) => item.id === id)
  if (!found) throw new Error('对话不存在: ' + id)
  return found
}

const chatRuns = (conversationId: string): Array<Record<string, unknown>> =>
  world.db
    .prepare('SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at, rowid')
    .all(conversationId) as unknown as Array<Record<string, unknown>>

const factTypes = (): string[] =>
  (
    world.db.prepare('SELECT type FROM facts ORDER BY seq').all() as unknown as Array<{
      type: string
    }>
  ).map((row) => row.type)

const eventsOf = (): Array<{ type: string }> =>
  world.streams
    .filter((item) => item.type === 'event')
    .map((item) => item.event as { type: string })

const endsOf = (conversationId: string): number =>
  world.streams.filter((item) => item.type === 'end' && item.conversationId === conversationId)
    .length

beforeEach(() => {
  commandSeq = 0
})

afterEach(() => {
  world.db.close()
})

/** 启动一个 world（用构造好的后端脚本）；返回同一实例。 */
function start(backend: ExecutorBackend): World {
  world = makeWorld(backend)
  return world
}

describe('chat：一轮执行（首轮 / 续接 / 错误文案）', () => {
  it('首轮：落用户消息、执行、落助手消息并记录会话 id', async () => {
    const script = scripted(() => outcome({ output: '答一', sessionId: 'sess-1' }))
    start(script.backend)
    const { agentId } = seedAgent('你是助手。')
    const conv = createConversation(agentId)

    send(conv.id, '你好')
    await world.scheduler.idle()

    const messages = messagesOf(conv.id)
    expect(messages.map((message) => [message.role, message.content, message.error])).toEqual([
      ['user', '你好', null],
      ['assistant', '答一', null],
    ])
    expect(conversationOf(conv.id).sessionId).toBe('sess-1')
    expect(chatRuns(conv.id)[0]?.status).toBe('succeeded')
    // 首轮 prompt 带 systemPrompt + 完整对话记录 + 结尾提示
    expect(script.requests[0]?.turn.prompt).toBe(
      '你是助手。\n\n# 对话记录\n\n用户：你好\n\n请回答最后一条用户消息。',
    )
    expect(endsOf(conv.id)).toBe(1)
  })

  it('事件按流推送（text / tool），助手消息内容以回执输出为准', async () => {
    const frames: Frame[] = [
      { type: 'status', status: 'running' },
      { type: 'text', text: '中间片段' },
      { type: 'tool_call', tool: 'read', callId: 'c1', input: '{}' },
    ]
    const script = scripted((request) => {
      frames.forEach((frame, index) => request.onEvent?.({ seq: index + 1, ...frame }))
      return outcome({ output: '最终', sessionId: 'sess-1' })
    })
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '问')
    await world.scheduler.idle()

    expect(eventsOf().map((event) => event.type)).toEqual(['status', 'text', 'tool_call'])
    expect(messagesOf(conv.id)[1]?.content).toBe('最终')
    // 事件只是旁路：不额外落消息
    expect(messagesOf(conv.id)).toHaveLength(2)
  })

  it('第二轮起用会话续接：只发新消息并带上 session id', async () => {
    const script = scripted((_request, index) =>
      index === 0
        ? outcome({ output: '一', sessionId: 'sess-1' })
        : outcome({ output: '二', sessionId: 'sess-2' }),
    )
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '第一问')
    await world.scheduler.idle()
    send(conv.id, '第二问')
    await world.scheduler.idle()

    expect(script.requests[1]?.turn.prompt).toBe('第二问')
    expect(script.requests[1]?.turn.resumeSessionId).toBe('sess-1')
    expect(script.requests[1]?.turn.turn).toBe(2)
    expect(conversationOf(conv.id).sessionId).toBe('sess-2')
    expect(messagesOf(conv.id)).toHaveLength(4)
  })

  it('续接被拒：换新会话并用完整历史重试一次', async () => {
    const script = scripted((_request, index) => {
      if (index === 0) return outcome({ output: '一', sessionId: 'sess-1' })
      if (index === 1) {
        return outcome({ status: 'failed', resumeRejected: true, sessionId: 'sess-1' })
      }
      return outcome({ output: '重试成功', sessionId: 'sess-3' })
    })
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '第一问')
    await world.scheduler.idle()
    send(conv.id, '第二问')
    await world.scheduler.idle()

    expect(script.requests).toHaveLength(3)
    const retry = script.requests[2]
    expect(retry?.turn.resumeSessionId).toBeNull()
    expect(retry?.turn.prompt).toContain('# 对话记录')
    expect(retry?.turn.prompt).toContain('用户：第一问')
    expect(retry?.turn.prompt).toContain('助手：一')
    expect(retry?.turn.prompt).toContain('用户：第二问')
    const assistant = messagesOf(conv.id)[3]
    expect(assistant?.content).toBe('重试成功')
    expect(assistant?.error).toBeNull()
    expect(conversationOf(conv.id).sessionId).toBe('sess-3')
  })

  it('没有会话可续接且续接被拒：只跑一次，落「执行失败」消息', async () => {
    const script = scripted(() => outcome({ status: 'failed', resumeRejected: true }))
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '问')
    await world.scheduler.idle()

    expect(script.requests).toHaveLength(1)
    expect(messagesOf(conv.id)[1]).toEqual(expect.objectContaining({ error: '执行失败' }))
    expect(conversationOf(conv.id).sessionId).toBeNull()
  })

  it('续接与重试都被拒：落失败消息，会话保持原样、不再重试', async () => {
    const script = scripted((_request, index) => {
      if (index === 0) return outcome({ output: '一', sessionId: 'sess-1' })
      return outcome({ status: 'failed', resumeRejected: true })
    })
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '第一问')
    await world.scheduler.idle()
    send(conv.id, '第二问')
    await world.scheduler.idle()

    // 首轮 1 次 + 第二轮 2 次（续接 + 完整历史重试），重试仍被拒即收口
    expect(script.requests).toHaveLength(3)
    expect(messagesOf(conv.id)[3]?.error).toBe('执行失败')
    expect(conversationOf(conv.id).sessionId).toBe('sess-1')
  })

  it('失败：助手消息记录 error，但保留会话 id 供续接', async () => {
    const script = scripted(() =>
      outcome({ status: 'failed', output: '', error: '退出码 1', sessionId: 'sess-new' }),
    )
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '问')
    await world.scheduler.idle()

    expect(messagesOf(conv.id)[1]).toEqual(expect.objectContaining({ error: '退出码 1' }))
    expect(conversationOf(conv.id).sessionId).toBe('sess-new')
  })

  it('失败但没有错误文案：聊天兜底「执行失败」，流式输出作为内容（累积由执行器负责）', async () => {
    const script = scripted((request) => {
      request.onEvent?.({ seq: 1, type: 'text', text: '流式片段' })
      // dsh 在输出为空时用事件累积文本（runtime/dsh.test.ts 覆盖），这里直接给回执输出
      return outcome({ status: 'failed', output: '流式片段', error: null, errorCode: 'run_failed' })
    })
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '问')
    await world.scheduler.idle()

    const assistant = messagesOf(conv.id)[1]
    expect(assistant?.content).toBe('流式片段')
    expect(assistant?.error).toBe('执行失败')
  })

  it('后端抛错：助手消息记录异常信息', async () => {
    const script = scripted(() => {
      throw new Error('spawn 失败')
    })
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '问')
    await world.scheduler.idle()

    expect(messagesOf(conv.id)[1]?.error).toBe('spawn 失败')
  })

  it('后端抛非 Error：错误文案转成字符串', async () => {
    const script = scripted(() => {
      throw '字符串错误'
    })
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '问')
    await world.scheduler.idle()

    expect(messagesOf(conv.id)[1]?.error).toBe('字符串错误')
  })

  it('首轮 systemPrompt 为空：prompt 直接从对话记录开始', async () => {
    const script = scripted(() => outcome({ output: '答' }))
    start(script.backend)
    const { agentId } = seedAgent('')
    const conv = createConversation(agentId)

    send(conv.id, '问')
    await world.scheduler.idle()

    expect(script.requests[0]?.turn.prompt.startsWith('# 对话记录')).toBe(true)
  })

  it('首条消息即长文本：会话标题按码点截断', async () => {
    const script = scripted(() => outcome({ output: '答' }))
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)
    const long = '一'.repeat(30)

    send(conv.id, long)
    await world.scheduler.idle()

    expect(conversationOf(conv.id).title).toBe('一'.repeat(24) + '…')
  })

  it('失败后没有会话：下一轮仍走完整历史 prompt', async () => {
    const script = scripted((_request, index) =>
      index === 0 ? outcome({ status: 'failed', error: '失败' }) : outcome({ output: '二' }),
    )
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '第一问')
    await world.scheduler.idle()
    send(conv.id, '第二问')
    await world.scheduler.idle()

    const second = script.requests[1]?.turn.prompt ?? ''
    expect(second).toContain('# 对话记录')
    expect(second).toContain('用户：第一问')
    expect(second).toContain('助手：')
    expect(second).toContain('用户：第二问')
    expect(script.requests[1]?.turn.resumeSessionId).toBeNull()
  })

  it('成功一轮只发一次 end，requestId 用 runId:turn:attempt 默认格式', async () => {
    const script = scripted(() => outcome({ output: '答', sessionId: 'sess-1' }))
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '问')
    await world.scheduler.idle()

    expect(endsOf(conv.id)).toBe(1)
    const runId = String(chatRuns(conv.id)[0]?.id)
    expect(script.requests[0]?.requestId).toBe(`${runId}:1:1`)
    expect(messagesOf(conv.id)).toHaveLength(2)
  })
})

describe('chat：并发、取消、运行时就绪检查', () => {
  it('空消息 / 执行中重复发送：明确报错，被拒绝不落消息', async () => {
    const script = scripted(
      (request) =>
        new Promise<ExecutorBackendOutcome>((resolve) => {
          request.signal.addEventListener('abort', () =>
            resolve(outcome({ status: 'cancelled', errorCode: 'cancelled' })),
          )
        }),
    )
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    expect(() => send(conv.id, '   ')).toThrow(/不能为空/)
    send(conv.id, '问')
    expect(() => send(conv.id, '再问')).toThrow(/正在执行/)
    expect(messagesOf(conv.id)).toHaveLength(1)

    world.handler('chat.cancel', [conv.id])
    await world.scheduler.idle()
    expect(messagesOf(conv.id)).toHaveLength(2)
  })

  it('运行时停用：发送前就报错，不写消息', async () => {
    const script = scripted(() => outcome())
    start(script.backend)
    const { agentId, runtimeId } = seedAgent()
    const conv = createConversation(agentId)
    world.store.dispatch({
      type: 'runtime.update',
      commandId: nextCommandId(),
      id: runtimeId,
      patch: { enabled: false },
    })

    expect(() => send(conv.id, '问')).toThrow(/已停用/)
    expect(messagesOf(conv.id)).toEqual([])
  })

  it('对话不存在：报错', () => {
    const script = scripted(() => outcome())
    start(script.backend)
    expect(() => send('ghost', '问')).toThrow(/对话不存在/)
  })

  it('取消：助手消息记「已取消」，run 落 cancelled，看板不再显示执行中', async () => {
    const script = scripted(
      (request) =>
        new Promise<ExecutorBackendOutcome>((resolve) => {
          request.signal.addEventListener('abort', () =>
            resolve(outcome({ status: 'cancelled', output: '', error: '已取消' })),
          )
        }),
    )
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '问')
    await Promise.resolve()
    expect(
      world.store.query('runs.active-by-conversation', { conversationId: conv.id }),
    ).toHaveLength(1)

    world.handler('chat.cancel', [conv.id])
    await world.scheduler.idle()

    expect(messagesOf(conv.id)[1]?.error).toBe('已取消')
    expect(chatRuns(conv.id)[0]?.status).toBe('cancelled')
    expect(world.store.query('runs.active-by-conversation', { conversationId: conv.id })).toEqual(
      [],
    )
  })

  it('取消空闲对话 / 未知对话是无害的', () => {
    const script = scripted(() => outcome())
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)
    expect(() => world.handler('chat.cancel', [conv.id])).not.toThrow()
    expect(() => world.handler('chat.cancel', ['ghost'])).not.toThrow()
  })

  it('执行期间对话被删除：不抛错、仍发一次 end、不落孤立消息', async () => {
    const script = scripted(
      (request) =>
        new Promise<ExecutorBackendOutcome>((resolve) => {
          request.signal.addEventListener('abort', () =>
            resolve(outcome({ status: 'cancelled', errorCode: 'cancelled' })),
          )
        }),
    )
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)

    send(conv.id, '问')
    await Promise.resolve()
    expect(() => world.handler('chat.removeConversation', [conv.id])).not.toThrow()
    await world.scheduler.idle()

    expect(conversations()).toEqual([])
    expect(messagesOf(conv.id)).toEqual([])
    expect(endsOf(conv.id)).toBe(1)
    // 对话删除后 run 的终态事实可能被级联删除，但不应残留「执行中」
    expect(factTypes()).toContain('conversation.removed')
  })

  it('推送失败不影响收尾（emit 抛错被吞掉）', async () => {
    const script = scripted((request) => {
      request.onEvent?.({ seq: 1, type: 'text', text: '片段' })
      return outcome({ output: '答', sessionId: 'sess-1' })
    })
    start(script.backend)
    const { agentId } = seedAgent()
    const conv = createConversation(agentId)
    world.breakStream.value = true

    expect(() => send(conv.id, '问')).not.toThrow()
    await world.scheduler.idle()

    expect(messagesOf(conv.id)[1]?.content).toBe('答')
    expect(conversationOf(conv.id).sessionId).toBe('sess-1')
  })
})
