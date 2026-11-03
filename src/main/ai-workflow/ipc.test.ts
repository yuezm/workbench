// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db'
import { createAiWorkflowHandler, registerAiWorkflowIpc } from './ipc'
import type { ChatService } from './chat'
import { Repository } from './repository'
import { AI_WORKFLOW_CHANNEL } from '../../shared/ai-workflow-api'

const { ipcMainMock, probeRuntimeMock } = vi.hoisted(() => ({
  ipcMainMock: { handle: vi.fn() },
  probeRuntimeMock: vi.fn(),
}))
vi.mock('electron', () => ({ ipcMain: ipcMainMock }))
// 默认探测走真实 spawn，单测里替换掉，避免起本机 CLI
vi.mock('./runtime/probe', () => ({ probeRuntime: probeRuntimeMock }))

let db: DatabaseSync
let repo: Repository
let notify: ReturnType<typeof vi.fn>
let handle: ReturnType<typeof createAiWorkflowHandler>

beforeEach(() => {
  vi.clearAllMocks()
  db = openDb(':memory:')
  repo = new Repository(db)
  notify = vi.fn()
  handle = createAiWorkflowHandler({ repo, notifyChanged: notify as unknown as () => void })
})
afterEach(() => db.close())

describe('ai-workflow handler：运行时/智能体', () => {
  it('runtimes.create 后 list 可见，并触发 changed', () => {
    handle('runtimes.create', [{ name: 'ds', command: 'dsh' }])
    expect(notify).toHaveBeenCalledTimes(1)
    const list = handle('runtimes.list', []) as Array<{ name: string }>
    expect(list.map((r) => r.name)).toEqual(['ds'])
    expect(notify).toHaveBeenCalledTimes(1) // list 不触发
  })

  it('agents.create 绑定运行时；被引用运行时删除报错且不触发 changed', () => {
    const rt = handle('runtimes.create', [{ name: 'ds', command: 'dsh' }]) as { id: string }
    handle('agents.create', [{ name: 'coder', runtimeId: rt.id }])
    expect(notify).toHaveBeenCalledTimes(2)
    notify.mockClear()
    expect(() => handle('runtimes.remove', [rt.id])).toThrow(/引用/)
    expect(notify).not.toHaveBeenCalled()
  })

  it('未知方法抛错', () => {
    expect(() => handle('nope.nope', [])).toThrow(/未知方法/)
  })

  it('runtimes.detect 返回已安装 CLI 清单且不触发 changed', () => {
    const result = handle('runtimes.detect', []) as Array<{
      command: string
      label: string
      path: string
    }>
    expect(Array.isArray(result)).toBe(true)
    for (const item of result) {
      expect(typeof item.command).toBe('string')
      expect(typeof item.label).toBe('string')
      expect(path.isAbsolute(item.path)).toBe(true)
    }
    expect(notify).not.toHaveBeenCalled()
  })

  it('runtimes.test 探测指定运行时且不写库、不触发 changed', async () => {
    const rt = handle('runtimes.create', [{ name: 'ds', command: 'dsh' }]) as { id: string }
    notify.mockClear()
    const probe = vi.fn(async () => ({
      ok: true,
      code: 0,
      elapsedMs: 12,
      output: 'OK',
      error: null,
    }))
    const h = createAiWorkflowHandler({
      repo,
      notifyChanged: notify as unknown as () => void,
      probeRuntime: probe,
    })
    const result = await h('runtimes.test', [rt.id])
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ id: rt.id, command: 'dsh' }))
    expect(result).toMatchObject({ ok: true, code: 0 })
    expect(notify).not.toHaveBeenCalled()

    // 未注入探测实现时用默认 probeRuntime（此处已 mock，避免真起本机 CLI）
    probeRuntimeMock.mockResolvedValue({ ok: true, code: 0, elapsedMs: 5, output: '', error: null })
    const bare = createAiWorkflowHandler({ repo, notifyChanged: notify as unknown as () => void })
    await bare('runtimes.test', [rt.id])
    expect(probeRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({ id: rt.id }))

    // 运行时不存在时是同步抛错（handler 同步执行），不是 rejected promise
    expect(() => h('runtimes.test', ['ghost'])).toThrow(/运行时不存在/)
  })
})

describe('ai-workflow handler：聊天', () => {
  interface FakeChat {
    send: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }
  function withChat(): { h: ReturnType<typeof createAiWorkflowHandler>; chat: FakeChat } {
    const chat: FakeChat = { send: vi.fn(async () => {}), cancel: vi.fn() }
    const h = createAiWorkflowHandler({
      repo,
      notifyChanged: notify as unknown as () => void,
      chat: chat as unknown as ChatService,
    })
    return { h, chat }
  }

  function seedAgent(h: ReturnType<typeof createAiWorkflowHandler>): string {
    const rt = h('runtimes.create', [{ name: 'ds', command: 'dsh' }]) as { id: string }
    const ag = h('agents.create', [{ name: 'coder', runtimeId: rt.id }]) as { id: string }
    return ag.id
  }

  it('会话与消息路由走仓库，写操作触发 changed', () => {
    const { h } = withChat()
    const agentId = seedAgent(h)
    notify.mockClear()
    const conv = h('chat.createConversation', [agentId]) as { id: string; title: string }
    expect(notify).toHaveBeenCalledTimes(1)
    expect(conv.title).toBe('新对话')

    expect((h('chat.listConversations', []) as unknown[]).length).toBe(1)
    expect(h('chat.listMessages', [conv.id])).toEqual([])

    h('chat.removeConversation', [conv.id])
    expect(notify).toHaveBeenCalledTimes(2)
    expect(h('chat.listConversations', [])).toEqual([])
  })

  it('chat.send / chat.cancel 交给聊天服务；服务缺失时明确报错', () => {
    const { h, chat } = withChat()
    const agentId = seedAgent(h)
    const conv = h('chat.createConversation', [agentId]) as { id: string }
    h('chat.send', [conv.id, '你好'])
    expect(chat.send).toHaveBeenCalledWith(conv.id, '你好')
    h('chat.cancel', [conv.id])
    expect(chat.cancel).toHaveBeenCalledWith(conv.id)

    const bare = createAiWorkflowHandler({ repo, notifyChanged: notify as unknown as () => void })
    expect(() => bare('chat.send', [conv.id, 'hi'])).toThrow(/聊天服务未就绪/)
    expect(() => bare('chat.cancel', [conv.id])).toThrow(/聊天服务未就绪/)
  })
})

describe('ai-workflow handler：工作流/阶段', () => {
  it('create / list / update / remove', () => {
    const wf = handle('workflows.create', [
      {
        name: '研发',
        stages: [
          { name: '待办', entryMode: 'none' },
          { name: '进行中', entryMode: 'none' },
        ],
      },
    ]) as { id: string; stages: unknown[] }
    expect(wf.stages).toHaveLength(2)
    expect((handle('workflows.list', []) as unknown[]).length).toBe(1)

    const up = handle('workflows.update', [
      wf.id,
      {
        name: '研发2',
        stages: [
          { name: 'a', entryMode: 'none' },
          { name: 'b', entryMode: 'none' },
          { name: 'c', entryMode: 'none' },
        ],
      },
    ]) as { stages: unknown[] }
    expect(up.stages).toHaveLength(3)

    handle('workflows.remove', [wf.id])
    expect(handle('workflows.list', [])).toEqual([])
  })

  it('agent 阶段缺智能体报错', () => {
    expect(() =>
      handle('workflows.create', [{ name: 'x', stages: [{ name: 'a', entryMode: 'agent' }] }]),
    ).toThrow(/智能体/)
  })
})

interface Wf {
  id: string
  stages: Array<{ id: string }>
}

describe('ai-workflow handler：任务/运行', () => {
  function seedAgent(): string {
    const rt = handle('runtimes.create', [{ name: 'ds', command: 'dsh' }]) as { id: string }
    const ag = handle('agents.create', [
      { name: 'coder', runtimeId: rt.id, systemPrompt: 'sys' },
    ]) as { id: string }
    return ag.id
  }

  it('从指定阶段开始；可拖回前一阶段；可拖到「已完成」；可删除', () => {
    const wf = handle('workflows.create', [
      {
        name: 'w',
        stages: [
          { name: '待办', entryMode: 'none' },
          { name: '审核', entryMode: 'user' },
        ],
      },
    ]) as Wf
    const task = handle('tasks.create', [
      { title: 'T', workflowId: wf.id, stageId: wf.stages[1].id },
    ]) as { id: string; currentStageId: string }
    expect(task.currentStageId).toBe(wf.stages[1].id)

    const moved = handle('tasks.moveToStage', [task.id, wf.stages[0].id]) as {
      currentStageId: string
    }
    expect(moved.currentStageId).toBe(wf.stages[0].id)

    const done = handle('tasks.complete', [task.id]) as { status: string }
    expect(done.status).toBe('completed')
    expect((handle('tasks.list', [wf.id]) as unknown[]).length).toBe(1)

    handle('tasks.remove', [task.id])
    expect(handle('tasks.list', [wf.id])).toEqual([])
  })

  it('起始阶段不属于该工作流时拒绝', () => {
    const a = handle('workflows.create', [
      { name: 'a', stages: [{ name: 'x', entryMode: 'none' }] },
    ]) as Wf
    const b = handle('workflows.create', [
      { name: 'b', stages: [{ name: 'y', entryMode: 'none' }] },
    ]) as Wf
    expect(() =>
      handle('tasks.create', [{ title: 'T', workflowId: a.id, stageId: b.stages[0].id }]),
    ).toThrow(/起始阶段/)
  })

  it('拖到 agent 阶段即入队 run；执行中的阶段不能拖动或完成', () => {
    const agentId = seedAgent()
    const wf = handle('workflows.create', [
      {
        name: 'w2',
        stages: [
          { name: '执行', entryMode: 'agent', agentId },
          { name: '完成', entryMode: 'none' },
        ],
      },
    ]) as Wf
    const task = handle('tasks.create', [{ title: 'T2', description: 'd', workflowId: wf.id }]) as {
      id: string
    }
    const runs = handle('runs.listByTask', [task.id]) as Array<{ status: string; prompt: string }>
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('queued')
    expect(runs[0].prompt).toContain('sys')

    expect(() => handle('tasks.moveToStage', [task.id, wf.stages[1].id])).toThrow(/不能拖动/)
    expect(() => handle('tasks.complete', [task.id])).toThrow(/不能完成/)
  })

  it('目标阶段无效 / 当前阶段无效时抛错', () => {
    const wf = handle('workflows.create', [
      { name: 'w3', stages: [{ name: '待办', entryMode: 'none' }] },
    ]) as Wf
    const task = handle('tasks.create', [{ title: 'T3', workflowId: wf.id }]) as { id: string }
    expect(() => handle('tasks.moveToStage', [task.id, 'ghost'])).toThrow(/目标阶段无效/)

    repo.taskUpdate(task.id, { currentStageId: null })
    expect(() => handle('tasks.moveToStage', [task.id, wf.stages[0].id])).toThrow(/无效/)
    expect(() => handle('tasks.complete', [task.id])).toThrow(/无效/)
  })
})

describe('ipc 补充', () => {
  it('agents.remove 删除未被引用的智能体', () => {
    const rt = handle('runtimes.create', [{ name: 'ds', command: 'dsh' }]) as { id: string }
    const ag = handle('agents.create', [{ name: 'a', runtimeId: rt.id }]) as { id: string }
    handle('agents.remove', [ag.id])
    expect(handle('agents.list', [])).toEqual([])
  })

  it('runtimes/agents update 与 agents.list', () => {
    const rt = handle('runtimes.create', [{ name: 'ds', command: 'dsh' }]) as { id: string }
    handle('runtimes.update', [rt.id, { name: 'ds2' }])
    const ag = handle('agents.create', [{ name: 'a', runtimeId: rt.id }]) as { id: string }
    handle('agents.update', [ag.id, { name: 'b' }])
    expect((handle('agents.list', []) as Array<{ name: string }>)[0].name).toBe('b')
    expect((handle('runtimes.list', []) as Array<{ name: string }>)[0].name).toBe('ds2')
  })

  it('tasks.complete 在首阶段直接完成；完成后不再随拖拽变化', () => {
    const wf = handle('workflows.create', [
      {
        name: 'w',
        stages: [
          { name: 'a', entryMode: 'none' },
          { name: 'b', entryMode: 'user' },
        ],
      },
    ]) as Wf
    const task = handle('tasks.create', [{ title: 't', workflowId: wf.id }]) as { id: string }
    handle('tasks.complete', [task.id])
    const after = handle('tasks.moveToStage', [task.id, wf.stages[1].id]) as {
      status: string
      currentStageId: string
    }
    expect(after.status).toBe('completed')
    expect(after.currentStageId).toBe(wf.stages[0].id)
  })
})

describe('registerAiWorkflowIpc', () => {
  it('在单一 RPC 通道上注册 handler', () => {
    registerAiWorkflowIpc({ repo, notifyChanged: notify as unknown as () => void })
    expect(ipcMainMock.handle).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, expect.any(Function))
    const h = ipcMainMock.handle.mock.calls[0][1] as (
      e: unknown,
      m: string,
      a: unknown[],
    ) => unknown
    expect(h({}, 'runtimes.list', [])).toEqual([])
  })
})
