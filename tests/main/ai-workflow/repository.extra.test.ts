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
    expect(() => repo.chatConversationGet('x')).toThrow(/对话不存在/)
  })

  it('不存在的任务/对话：列表返回空数组而不是抛错', () => {
    expect(repo.runsListByTask('ghost')).toEqual([])
    expect(repo.chatMessagesList('ghost')).toEqual([])
    expect(repo.chatConversationsList()).toEqual([])
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

  it('chatConversationCreate 智能体不存在（含空 id）时抛错', () => {
    expect(() => repo.chatConversationCreate('ghost')).toThrow(/智能体不存在/)
    expect(() => repo.chatConversationCreate('')).toThrow(/智能体不存在/)
  })

  it('chatMessageCreate 向不存在的对话写消息抛错（外键生效，不留孤立消息）', () => {
    expect(() =>
      repo.chatMessageCreate({ conversationId: 'ghost', role: 'user', content: 'x' }),
    ).toThrow()
  })

  it('删除对话级联删除消息', () => {
    const { agent } = seed()
    const conv = repo.chatConversationCreate(agent.id)
    repo.chatMessageCreate({ conversationId: conv.id, role: 'user', content: '你好' })
    repo.chatMessageCreate({ conversationId: conv.id, role: 'assistant', content: '在' })
    expect(repo.chatMessagesList(conv.id)).toHaveLength(2)
    repo.chatConversationRemove(conv.id)
    expect(() => repo.chatConversationGet(conv.id)).toThrow(/对话不存在/)
    expect(repo.chatMessagesList(conv.id)).toEqual([])
  })

  it('rename / touch / setSession 都更新对应字段', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const { agent } = seed()
    const conv = repo.chatConversationCreate(agent.id)
    expect(conv.sessionId).toBeNull()
    repo.chatConversationSetSession(conv.id, 'sess-1')
    expect(repo.chatConversationGet(conv.id).sessionId).toBe('sess-1')

    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'))
    repo.chatConversationRename(conv.id, '改过的标题')
    expect(repo.chatConversationGet(conv.id).title).toBe('改过的标题')
    expect(repo.chatConversationGet(conv.id).updatedAt).toBe('2026-01-01T00:00:05.000Z')

    vi.setSystemTime(new Date('2026-01-01T00:00:09.000Z'))
    repo.chatConversationTouch(conv.id)
    expect(repo.chatConversationGet(conv.id).updatedAt).toBe('2026-01-01T00:00:09.000Z')

    repo.chatConversationSetSession(conv.id, null)
    expect(repo.chatConversationGet(conv.id).sessionId).toBeNull()
  })

  it('对话列表按 updated_at 倒序', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { agent } = seed()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const a = repo.chatConversationCreate(agent.id)
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
    const b = repo.chatConversationCreate(agent.id)
    expect(repo.chatConversationsList().map((conv) => conv.id)).toEqual([b.id, a.id])
  })

  it('消息按 created_at 排序，同毫秒按写入顺序', () => {
    const { agent } = seed()
    const conv = repo.chatConversationCreate(agent.id)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'))
    const late = repo.chatMessageCreate({ conversationId: conv.id, role: 'user', content: '晚' })
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
    const early = repo.chatMessageCreate({
      conversationId: conv.id,
      role: 'assistant',
      content: '早',
    })
    const sameTime = repo.chatMessageCreate({
      conversationId: conv.id,
      role: 'user',
      content: '同',
    })
    expect(repo.chatMessagesList(conv.id).map((m) => m.id)).toEqual([
      early.id,
      sameTime.id,
      late.id,
    ])
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
