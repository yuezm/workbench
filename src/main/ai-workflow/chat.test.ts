// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Agent,
  ChatConversation,
  ChatMessage,
  ChatRole,
  ChatStreamEvent,
  Runtime,
} from '../../shared/ai-workflow-api'
import { buildChatPrompt, ChatService, titleFromContent, type ChatServiceDeps } from './chat'
import { openDb } from './db'
import { Repository } from './repository'
import type { RuntimeAdapter } from './runtime/deepseek-harness'

let db: DatabaseSync
let repo: Repository
let runtime: Runtime
let agent: Agent
let conversation: ChatConversation

beforeEach(() => {
  db = openDb(':memory:')
  repo = new Repository(db)
  runtime = repo.runtimeCreate({ name: 'ds', command: 'dsh', args: ['-p', '{prompt}'] })
  agent = repo.agentCreate({ name: 'coder', runtimeId: runtime.id, systemPrompt: '你是助手' })
  conversation = repo.chatConversationCreate(agent.id)
})
afterEach(() => {
  vi.useRealTimers()
  db.close()
})

interface Harness {
  service: ChatService
  events: ChatStreamEvent[]
  /** 等本轮的 end 事件（每轮调用一次，注意在 send 之前创建） */
  end(): Promise<void>
  chunks(): string[]
}

function makeHarness(adapterFor: ChatServiceDeps['adapterFor']): Harness {
  const events: ChatStreamEvent[] = []
  let resolveEnd: (() => void) | undefined
  const service = new ChatService({
    repo,
    emit: (event) => {
      events.push(event)
      if (event.type === 'end') resolveEnd?.()
    },
    adapterFor,
  })
  return {
    service,
    events,
    end: () =>
      new Promise<void>((resolve) => {
        resolveEnd = resolve
      }),
    chunks: () => events.flatMap((e) => (e.type === 'chunk' ? [e.chunk ?? ''] : [])),
  }
}

function messages(): ChatMessage[] {
  return repo.chatMessagesList(conversation.id)
}

/** 发起一轮并等它结束（任何路径都会 emit end） */
async function sendAndWait(h: Harness, content: string): Promise<void> {
  const end = h.end()
  await h.service.send(conversation.id, content)
  await end
}

describe('titleFromContent', () => {
  it('取首行并去掉首尾空白', () => {
    expect(titleFromContent('  第一行\n第二行  ')).toBe('第一行')
  })

  it('超过 24 字符截断并加省略号（按码点，不切 emoji）', () => {
    const title = titleFromContent('一'.repeat(30))
    expect(title).toBe('一'.repeat(24) + '…')
    expect(title).toHaveLength(25)
    expect(titleFromContent('😀'.repeat(30))).toBe('😀'.repeat(24) + '…')
  })

  it('恰好 24 字符不截断', () => {
    const exact = '二'.repeat(24)
    expect(titleFromContent(exact)).toBe(exact)
  })

  it('空内容 / 全是空白回落默认标题', () => {
    expect(titleFromContent('')).toBe('新对话')
    expect(titleFromContent('  \n\t ')).toBe('新对话')
  })
})

describe('buildChatPrompt', () => {
  const msg = (role: ChatRole, content: string): ChatMessage => ({
    id: role + content,
    conversationId: 'c',
    role,
    content,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  })

  it('带 systemPrompt：系统提示 + 对话记录 + 结尾提示', () => {
    const prompt = buildChatPrompt(agent, [
      msg('user', '你好'),
      msg('assistant', '在'),
      msg('user', '再看下'),
    ])
    expect(prompt.startsWith('你是助手')).toBe(true)
    expect(prompt).toContain('# 对话记录')
    expect(prompt).toContain('用户：你好\n助手：在\n用户：再看下')
    expect(prompt.trimEnd().endsWith('请回答最后一条用户消息。')).toBe(true)
  })

  it('无 systemPrompt 时不带空段，直接以对话记录开头', () => {
    const prompt = buildChatPrompt({ ...agent, systemPrompt: '   ' }, [msg('user', '只有一条')])
    expect(prompt.startsWith('# 对话记录')).toBe(true)
    expect(prompt).not.toContain('\n\n\n')
    expect(prompt).toContain('用户：只有一条')
  })
})

describe('ChatService', () => {
  it('正常一轮：用户消息落库、首轮改标题、chunk 依次推送、assistant 落库并 end', async () => {
    const adapter: RuntimeAdapter = {
      run: async ({ onOutput }) => {
        onOutput('你好')
        onOutput('，世界')
        return { code: 0, output: '你好，世界' }
      },
    }
    const h = makeHarness(() => adapter)
    await sendAndWait(h, '  帮我看下这段代码\n第二行  ')

    expect(repo.chatConversationGet(conversation.id).title).toBe('帮我看下这段代码')
    const list = messages()
    expect(list.map((m) => m.role)).toEqual(['user', 'assistant'])
    // 落库内容只去掉首尾空白，内部换行保留
    expect(list[0].content).toBe('帮我看下这段代码\n第二行')
    expect(list[0].error).toBeNull()
    expect(list[1].content).toBe('你好，世界')
    expect(list[1].error).toBeNull()

    expect(h.events[0]).toEqual({
      conversationId: conversation.id,
      type: 'chunk',
      chunk: '你好',
    })
    expect(h.chunks()).toEqual(['你好', '，世界'])
    expect(h.events.filter((e) => e.type === 'end')).toEqual([
      { conversationId: conversation.id, type: 'end' },
    ])
    expect(h.service.isRunning(conversation.id)).toBe(false)
  })

  it('第二轮带上完整历史且不改标题；结束后 touch updated_at；workdir 缺省回落 cwd', async () => {
    const prompts: string[] = []
    const workdirs: string[] = []
    const adapter: RuntimeAdapter = {
      run: async ({ prompt, workdir, onOutput }) => {
        prompts.push(prompt)
        workdirs.push(workdir)
        onOutput('好的')
        return { code: 0, output: '好的' }
      },
    }
    const h = makeHarness(() => adapter)
    await sendAndWait(h, '第一条')
    const first = repo.chatConversationGet(conversation.id)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-02-02T00:00:00.000Z'))
    await sendAndWait(h, '第二条')
    const second = repo.chatConversationGet(conversation.id)

    expect(second.title).toBe('第一条')
    expect(second.updatedAt).toBe('2026-02-02T00:00:00.000Z')
    expect(second.updatedAt).not.toBe(first.updatedAt)
    expect(prompts[1]).toContain('用户：第一条')
    expect(prompts[1]).toContain('助手：好的')
    expect(prompts[1]).toContain('用户：第二条')
    expect(workdirs).toEqual([process.cwd(), process.cwd()])
  })

  it('workdir 优先取运行时配置', async () => {
    repo.runtimeUpdate(runtime.id, { workdir: 'D:/Codes/workbench' })
    const workdirs: string[] = []
    const h = makeHarness(() => ({
      run: async ({ workdir }) => {
        workdirs.push(workdir)
        return { code: 0, output: 'ok' }
      },
    }))
    await sendAndWait(h, 'hi')
    expect(workdirs).toEqual(['D:/Codes/workbench'])
  })

  it('成功时 assistant content 取适配器返回的完整输出', async () => {
    const adapter: RuntimeAdapter = {
      run: async ({ onOutput }) => {
        onOutput('片段')
        return { code: 0, output: '片段+补全' }
      },
    }
    const h = makeHarness(() => adapter)
    await sendAndWait(h, 'hi')
    expect(h.chunks()).toEqual(['片段'])
    expect(messages().at(-1)?.content).toBe('片段+补全')
  })

  it('非零退出：记「退出码 N」，content 用已累积输出，仍发 end', async () => {
    const h = makeHarness(() => ({
      run: async ({ onOutput }) => (onOutput('半截'), { code: 2, output: '完整但不可信' }),
    }))
    await sendAndWait(h, '跑一下')

    const last = messages().at(-1)
    expect(last?.role).toBe('assistant')
    expect(last?.error).toBe('退出码 2')
    expect(last?.content).toBe('半截')
    expect(h.events.at(-1)).toEqual({ conversationId: conversation.id, type: 'end' })
  })

  it('适配器 reject：error 记异常信息，content 保留累积输出', async () => {
    const h = makeHarness(() => ({
      run: async ({ onOutput }) => {
        onOutput('半截')
        throw new Error('spawn 失败')
      },
    }))
    await sendAndWait(h, 'hi')

    const last = messages().at(-1)
    expect(last?.error).toBe('spawn 失败')
    expect(last?.content).toBe('半截')
    expect(h.events.at(-1)?.type).toBe('end')
  })

  it('适配器 reject 非 Error：错误被字符串化', async () => {
    const h = makeHarness(() => ({
      run: () => Promise.reject('boom-str'),
    }))
    await sendAndWait(h, 'hi')
    expect(messages().at(-1)?.error).toBe('boom-str')
  })

  it('取消：abort 后记「已取消」，content 用部分输出，仍发 end', async () => {
    const h = makeHarness(() => ({
      run: ({ signal, onOutput }) =>
        new Promise((_resolve, reject) => {
          onOutput('部分')
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    }))
    const end = h.end()
    await h.service.send(conversation.id, '取消我')
    expect(h.service.isRunning(conversation.id)).toBe(true)

    h.service.cancel(conversation.id)
    await end

    const last = messages().at(-1)
    expect(last?.error).toBe('已取消')
    expect(last?.content).toBe('部分')
    expect(h.service.isRunning(conversation.id)).toBe(false)
    expect(h.events.at(-1)?.type).toBe('end')
  })

  it('abort 后适配器仍 resolve：按取消记录并保留流式输出', async () => {
    const h = makeHarness(() => ({
      run: async ({ signal, onOutput }) => {
        onOutput('流式')
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve())
        })
        return { code: 0, output: '完整输出' }
      },
    }))
    const end = h.end()
    await h.service.send(conversation.id, 'hi')
    h.service.cancel(conversation.id)
    await end

    const last = messages().at(-1)
    expect(last?.error).toBe('已取消')
    expect(last?.content).toBe('流式')
  })

  it('send 校验：空内容、并发第二轮、对话不存在', async () => {
    let release!: (r: { code: number; output: string }) => void
    const h = makeHarness(() => ({
      run: () =>
        new Promise<{ code: number; output: string }>((resolve) => {
          release = resolve
        }),
    }))

    await expect(h.service.send(conversation.id, '   ')).rejects.toThrow('消息内容不能为空')
    await expect(h.service.send('ghost', 'hi')).rejects.toThrow(/对话不存在/)
    await expect(h.service.send('', 'hi')).rejects.toThrow(/对话不存在/)
    expect(messages()).toEqual([])

    const end = h.end()
    await h.service.send(conversation.id, '第一轮')
    expect(h.service.isRunning(conversation.id)).toBe(true)
    await expect(h.service.send(conversation.id, '第二轮')).rejects.toThrow(/正在执行中/)
    expect(messages().map((m) => m.content)).toEqual(['第一轮'])

    release({ code: 0, output: 'ok' })
    await end
  })

  it('对话引用的智能体 / 运行时不存在时抛错', async () => {
    const h = makeHarness(() => ({ run: async () => ({ code: 0, output: 'ok' }) }))

    // 数据不一致：对话指向已不存在的智能体
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare("UPDATE chat_conversations SET agent_id='ghost' WHERE id=?").run(conversation.id)
    db.exec('PRAGMA foreign_keys = ON')
    await expect(h.service.send(conversation.id, 'hi')).rejects.toThrow(/智能体不存在/)

    // 数据不一致：智能体指向已不存在的运行时
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare('UPDATE chat_conversations SET agent_id=? WHERE id=?').run(agent.id, conversation.id)
    db.prepare("UPDATE agents SET runtime_id='ghost' WHERE id=?").run(agent.id)
    db.exec('PRAGMA foreign_keys = ON')
    await expect(h.service.send(conversation.id, 'hi')).rejects.toThrow(/运行时不存在/)
  })

  it('执行中对话被删除：不抛且仍发 end', async () => {
    let release!: (r: { code: number; output: string }) => void
    const h = makeHarness(() => ({
      run: ({ onOutput }) => {
        onOutput('半截')
        return new Promise<{ code: number; output: string }>((resolve) => {
          release = resolve
        })
      },
    }))
    const end = h.end()
    await h.service.send(conversation.id, '会被删')
    repo.chatConversationRemove(conversation.id)

    release({ code: 0, output: '半截' })
    await end

    expect(h.service.isRunning(conversation.id)).toBe(false)
    expect(h.events.at(-1)).toEqual({ conversationId: conversation.id, type: 'end' })
    expect(repo.chatMessagesList(conversation.id)).toEqual([])
  })

  it('缺省适配器可构造；无执行轮次时 cancel 静默；send 校验先于执行', async () => {
    const service = new ChatService({ repo, emit: () => {} })
    expect(service.isRunning(conversation.id)).toBe(false)
    expect(() => service.cancel(conversation.id)).not.toThrow()
    // 空内容在选适配器之前就失败，不会真的 spawn 进程
    await expect(service.send(conversation.id, '   ')).rejects.toThrow(/不能为空/)
  })

  it('emit 抛错不影响执行与落库', async () => {
    const service = new ChatService({
      repo,
      emit: () => {
        throw new Error('窗口已销毁')
      },
      adapterFor: () => ({
        run: async ({ onOutput }) => (onOutput('ok'), { code: 0, output: 'ok' }),
      }),
    })
    await service.send(conversation.id, '你好')
    await vi.waitFor(() => expect(service.isRunning(conversation.id)).toBe(false))

    const last = messages().at(-1)
    expect(last?.role).toBe('assistant')
    expect(last?.content).toBe('ok')
    expect(last?.error).toBeNull()
  })
})
