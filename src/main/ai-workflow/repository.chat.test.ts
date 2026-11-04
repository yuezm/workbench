// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../../shared/ai-workflow-api'
import { Repository } from './repository'
import {
  createAgent,
  createRuntime,
  createWorld,
  removeAgent,
  resetCommandIds,
  type TestWorld,
} from './test-support'

let world: TestWorld
let repo: Repository

beforeEach(() => {
  resetCommandIds()
  world = createWorld()
  repo = world.repo
})
afterEach(() => {
  vi.useRealTimers()
  world.db.close()
})

/** 建运行时 + 智能体，返回智能体 */
function seedAgent(name = 'coder'): Agent {
  const rt = createRuntime(world, { name: 'ds-' + name, command: 'dsh' })
  return createAgent(world, { name, runtimeId: rt.id, systemPrompt: 'you are coder' })
}

/** 当前对话列表的 id 顺序 */
function ids(): string[] {
  return repo.chatConversationsList().map((c) => c.id)
}

/** 投影里的智能体清单（确认删除失败后仍在）。 */
function agentList(worldArg: TestWorld): Array<{ id: string }> {
  return worldArg.store.query('agents.all')
}

describe('repository 对话与消息', () => {
  it('新建对话：默认标题、绑定智能体、创建与更新时间一致', () => {
    const agent = seedAgent()
    const conv = repo.chatConversationCreate(agent.id)
    expect(conv.title).toBe('新对话')
    expect(conv.agentId).toBe(agent.id)
    expect(conv.createdAt).toBe(conv.updatedAt)
    expect(repo.chatConversationGet(conv.id)).toEqual(conv)
    expect(ids()).toEqual([conv.id])
  })

  it('智能体不存在（含空 id）时不能建对话', () => {
    expect(() => repo.chatConversationCreate('ghost')).toThrow(/智能体不存在/)
    expect(() => repo.chatConversationCreate('')).toThrow(/智能体不存在/)
  })

  it('列表按 updated_at 倒序：rename / touch 后靠前；同一时间按 created_at 倒序', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const agent = seedAgent()
    const a = repo.chatConversationCreate(agent.id)
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
    const b = repo.chatConversationCreate(agent.id)
    expect(ids()).toEqual([b.id, a.id])

    // 改名会把 a 顶到最前
    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))
    repo.chatConversationRename(a.id, '改过的标题')
    expect(repo.chatConversationGet(a.id).title).toBe('改过的标题')
    expect(repo.chatConversationGet(a.id).updatedAt).toBe('2026-01-01T00:00:02.000Z')
    expect(ids()).toEqual([a.id, b.id])

    // 只 touch 也会顶到最前
    vi.setSystemTime(new Date('2026-01-01T00:00:03.000Z'))
    repo.chatConversationTouch(b.id)
    expect(repo.chatConversationGet(b.id).updatedAt).toBe('2026-01-01T00:00:03.000Z')
    expect(ids()).toEqual([b.id, a.id])

    // updated_at 相同时用 created_at 倒序兜底，顺序仍然稳定
    world.db.prepare('UPDATE chat_conversations SET updated_at=?').run('2026-01-01T00:00:09.000Z')
    expect(ids()).toEqual([b.id, a.id])
  })

  it('删除对话级联删除消息', () => {
    const agent = seedAgent()
    const conv = repo.chatConversationCreate(agent.id)
    repo.chatMessageCreate({ conversationId: conv.id, role: 'user', content: '你好' })
    repo.chatMessageCreate({ conversationId: conv.id, role: 'assistant', content: '在' })
    expect(repo.chatMessagesList(conv.id)).toHaveLength(2)

    repo.chatConversationRemove(conv.id)
    expect(() => repo.chatConversationGet(conv.id)).toThrow(/对话不存在/)
    expect(repo.chatMessagesList(conv.id)).toEqual([])
    expect(ids()).toEqual([])
  })

  it('消息按 created_at 排序，同毫秒按写入顺序；error 可空', () => {
    const agent = seedAgent()
    const conv = repo.chatConversationCreate(agent.id)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'))
    const late = repo.chatMessageCreate({ conversationId: conv.id, role: 'user', content: '晚' })

    // 后写入但时间更早：排序看 created_at，不只看插入顺序
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
    const early = repo.chatMessageCreate({
      conversationId: conv.id,
      role: 'assistant',
      content: '早',
      error: '退出码 1',
    })
    // 同毫秒：靠 rowid 兜底
    const sameTime = repo.chatMessageCreate({
      conversationId: conv.id,
      role: 'user',
      content: '同一时刻',
      error: null,
    })

    expect(late.error).toBeNull()
    expect(late.createdAt).toBe('2026-01-01T00:00:05.000Z')
    expect(early.error).toBe('退出码 1')
    expect(sameTime.error).toBeNull()
    expect(repo.chatMessagesList(conv.id).map((m) => m.id)).toEqual([
      early.id,
      sameTime.id,
      late.id,
    ])
    // 按对话隔离
    const other = repo.chatConversationCreate(agent.id)
    repo.chatMessageCreate({ conversationId: other.id, role: 'user', content: '别的对话' })
    expect(repo.chatMessagesList(other.id).map((m) => m.content)).toEqual(['别的对话'])
    expect(repo.chatMessagesList(conv.id)).toHaveLength(3)
  })

  it('向不存在的对话写消息抛错（外键生效，不留孤立消息）', () => {
    expect(() =>
      repo.chatMessageCreate({ conversationId: 'ghost', role: 'user', content: 'x' }),
    ).toThrow()
  })

  it('智能体被对话引用时无法删除（外键 RESTRICT 兜底）', () => {
    const agent = seedAgent()
    repo.chatConversationCreate(agent.id)
    // 对话不在内核视图里，拒绝来自写库时的外键；错误照实抛给调用方（旧实现包成「引用」文案）
    expect(() => removeAgent(world, agent.id)).toThrow(/引用|FOREIGN KEY/)
    expect(agentList(world)).toHaveLength(1)
  })

  it('会话 id 可写入/清空（跨轮续接用）', () => {
    const agent = seedAgent()
    const conv = repo.chatConversationCreate(agent.id)
    expect(conv.sessionId).toBeNull()
    repo.chatConversationSetSession(conv.id, 'sess-1')
    expect(repo.chatConversationGet(conv.id).sessionId).toBe('sess-1')
    repo.chatConversationSetSession(conv.id, null)
    expect(repo.chatConversationGet(conv.id).sessionId).toBeNull()
  })
})
