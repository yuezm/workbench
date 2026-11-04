// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repository } from '../../../src/main/ai-workflow/repository'
import {
  createAgent,
  createRuntime,
  createTask,
  createWorkflow,
  createWorld,
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

/** 建运行时 + 智能体 + 单阶段工作流 + 任务。 */
function seed() {
  const runtime = createRuntime(world, { name: 'ds', command: 'dsh' })
  const agent = createAgent(world, { name: 'a', runtimeId: runtime.id })
  const workflow = createWorkflow(world, {
    name: 'w',
    stages: [{ name: 's', entryMode: 'none' }],
  })
  const task = createTask(world, { title: 't', workflowId: workflow.id })
  return { runtime, agent, workflow, task }
}

function newRun(taskId: string) {
  return repo.runCreate({
    taskId,
    stageId: null,
    agentId: null,
    runtimeId: null,
    prompt: 'p',
    status: 'queued',
  })
}

describe('repository 错误分支与补充路径', () => {
  it('get 不存在的实体都抛错', () => {
    expect(() => repo.runtimeGet('x')).toThrow(/运行时不存在/)
    expect(() => repo.agentGet('x')).toThrow(/智能体不存在/)
    expect(() => repo.runGet('x')).toThrow(/运行记录不存在/)
  })

  it('不存在的任务/对话：列表返回空数组而不是抛错', () => {
    expect(repo.runsListByTask('ghost')).toEqual([])
  })

  it('runsListByStatus 空集合 / 未匹配状态', () => {
    const { task } = seed()
    newRun(task.id)
    expect(repo.runsListByStatus('queued')).toHaveLength(1)
    expect(repo.runsListByStatus('running')).toEqual([])
    expect(repo.runsListByStatus('cancelled')).toEqual([])
  })

  it('runUpdate 不存在的 run 抛错；runEventsAppend 对不存在 run 由外键拦下', () => {
    expect(() => repo.runUpdate('ghost', { status: 'running' })).toThrow(/运行记录不存在/)
    expect(() => repo.runEventsAppend('ghost', [{ seq: 1, type: 'text', text: 'x' }])).toThrow()
  })

  it('runUpdate 的 usage 分支：无 patch 时沿用已有 JSON', () => {
    const { task } = seed()
    const run = newRun(task.id)
    repo.runUpdate(run.id, {
      usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 2 },
    })
    const after = repo.runUpdate(run.id, { output: '更' })
    expect(after.usage).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
    })
    expect(after.output).toBe('更')
  })

  it('runUpdate 覆盖 usage 与显式置空 killed 分支', () => {
    const { task } = seed()
    const run = newRun(task.id)
    repo.runUpdate(run.id, {
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    repo.runUpdate(run.id, {
      usage: { inputTokens: 9, outputTokens: 9, cacheReadTokens: 9, cacheWriteTokens: 9 },
    })
    expect(repo.runGet(run.id).usage?.inputTokens).toBe(9)
    expect(repo.runUpdate(run.id, { usage: null }).usage).toBeNull()
  })

  // T14b：聊天 SQL 用例迁到事实/投影路径（旧 chat_* 表已删除，读写都走 store）
  const createConversation = (agentId: string, title?: string): string => {
    const facts = world.store.dispatch({
      type: 'conversation.create',
      agentId,
      ...(title === undefined ? {} : { title }),
    }).facts
    return (facts[0]?.payload as { conversation: { id: string } }).conversation.id
  }

  it('聊天投影：建对话 / 发消息 / 删对话都走事实，旧 chat_* 表已不存在', () => {
    const { agent } = seed()
    const conversationId = createConversation(agent.id, '旧对话')

    const conversations = world.store.query('conversations.all')
    expect(conversations).toHaveLength(1)
    expect(conversations[0]).toMatchObject({ id: conversationId, title: '旧对话', sessionId: null })
    expect(world.store.query('messages.byConversation', { conversationId })).toEqual([])

    world.store.dispatch({ type: 'conversation.send', conversationId, content: '你好' })
    const messages = world.store.query('messages.byConversation', { conversationId })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', content: '你好', error: null })
    expect(world.store.query('runs.active-by-conversation', { conversationId })).toHaveLength(1)

    const types = (
      world.db.prepare('SELECT type FROM facts ORDER BY seq').all() as unknown as Array<{
        type: string
      }>
    ).map((row) => row.type)
    expect(types).toContain('conversation.created')
    expect(types).toContain('message.appended')

    world.store.dispatch({ type: 'conversation.remove', conversationId })
    expect(world.store.query('conversations.all')).toEqual([])
    expect(world.store.query('messages.byConversation', { conversationId })).toEqual([])

    // 旧聊天表已从 schema 删除：存量数据只能靠事实重建
    expect(() => world.db.prepare('SELECT 1 FROM chat_conversations').get()).toThrow(
      /no such table/,
    )
    expect(() => world.db.prepare('SELECT 1 FROM chat_messages').get()).toThrow(/no such table/)
  })

  it('聊天校验：未知对话 / 空内容 / 未知智能体都 reject', () => {
    const { agent } = seed()
    const conversationId = createConversation(agent.id, '会话')
    expect(() =>
      world.store.dispatch({ type: 'conversation.send', conversationId: 'ghost', content: 'x' }),
    ).toThrow(/对话不存在/)
    expect(() =>
      world.store.dispatch({ type: 'conversation.send', conversationId, content: '   ' }),
    ).toThrow(/消息内容不能为空/)
    expect(() => world.store.dispatch({ type: 'conversation.create', agentId: 'ghost' })).toThrow(
      /智能体不存在/,
    )
    expect(world.store.query('messages.byConversation', { conversationId })).toEqual([])
  })

  it('会话列表按最近更新排序；终态回执写回 session 并补 assistant 消息', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { agent } = seed()
    const first = createConversation(agent.id, '早')
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
    const second = createConversation(agent.id, '晚')
    expect(world.store.query('conversations.all').map((item) => item.id)).toEqual([second, first])

    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))
    world.store.dispatch({ type: 'conversation.send', conversationId: first, content: '你好' })
    const run = world.db
      .prepare('SELECT * FROM runs WHERE conversation_id = ?')
      .get(first) as unknown as Record<string, unknown>
    world.store.dispatch({
      type: 'run.claim',
      runtimeId: String(run.runtime_id),
      capacity: 1,
    })
    const claimed = world.db
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(String(run.id)) as unknown as Record<string, unknown>
    world.store.dispatch({
      type: 'run.receipt',
      runId: String(run.id),
      receipt: {
        status: 'succeeded',
        leaseId: String(claimed.lease_id),
        turn: Number(claimed.turn),
        output: '应答',
        sessionId: 'sess-9',
      },
    })

    const updated = world.store.query('conversations.all').find((item) => item.id === first)
    expect(updated?.sessionId).toBe('sess-9')
    expect(world.store.query('conversations.all')[0]?.id).toBe(first)
    const messages = world.store.query('messages.byConversation', { conversationId: first })
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['user', '你好'],
      ['assistant', '应答'],
    ])
    vi.useRealTimers()
  })
  it('runtimeWorkloads 空库返回空数组；activeRunForTask 未知任务返回 null', () => {
    expect(repo.runtimeWorkloads()).toEqual([])
    expect(repo.activeRunForTask('ghost')).toBeNull()
  })

  it('runEventsAppend 的 payload 里 undefined 字段不入库', () => {
    const { task } = seed()
    const run = newRun(task.id)
    repo.runEventsAppend(run.id, [{ seq: 1, type: 'text', text: 'a' }])
    expect(repo.runEventsList(run.id)).toEqual([{ seq: 1, type: 'text', text: 'a' }])
    expect(repo.runEventsList(run.id)[0]).not.toHaveProperty('input')
  })

  it('任务删除后 run 记录随外键级联消失', () => {
    const { task } = seed()
    const run = newRun(task.id)
    expect(repo.runGet(run.id).id).toBe(run.id)
    world.store.dispatch({ type: 'task.remove', commandId: 'remove-task', id: task.id })
    expect(() => repo.runGet(run.id)).toThrow(/运行记录不存在/)
  })

  it('runCreate 允许 runtime/agent 为空（聊天与手工 run 场景）', () => {
    const { task } = seed()
    const run = newRun(task.id)
    expect(run.agentId).toBeNull()
    expect(run.runtimeId).toBeNull()
    expect(run.stageId).toBeNull()
    expect(repo.runsListByTask(task.id)).toHaveLength(1)
  })
})
