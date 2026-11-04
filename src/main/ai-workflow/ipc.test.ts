// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeProbe } from '../../shared/ai-workflow-api'
import { AI_WORKFLOW_CHANNEL } from '../../shared/ai-workflow-api'
import type { ChatService } from './chat'
import { openDb } from './db'
import { createAiWorkflowHandler, registerAiWorkflowIpc, type AiWorkflowHandler } from './ipc'
import { Repository } from './repository'
import type { RuntimeBackend } from './runtime/registry'

const { ipcMainMock } = vi.hoisted(() => ({ ipcMainMock: { handle: vi.fn() } }))
vi.mock('electron', () => ({ ipcMain: ipcMainMock }))

let db: DatabaseSync
let repo: Repository
let notify: ReturnType<typeof vi.fn>
let handle: AiWorkflowHandler
let probe: ReturnType<typeof vi.fn>
let models: ReturnType<typeof vi.fn>
let backend: RuntimeBackend

function readyProbe(over: Partial<RuntimeProbe> = {}): RuntimeProbe {
  return {
    state: 'ready',
    path: 'C:/bin/dsh.cmd',
    cliVersion: '0.2.1',
    protocolVersion: 1,
    pluginVersion: '0.1.0',
    error: null,
    output: '',
    elapsedMs: 12,
    checkedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function makeHandler(overrides: Partial<Parameters<typeof createAiWorkflowHandler>[0]> = {}) {
  return createAiWorkflowHandler({
    repo,
    notifyChanged: notify as unknown as () => void,
    backendFor: () => backend,
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  db = openDb(':memory:')
  repo = new Repository(db)
  notify = vi.fn()
  probe = vi.fn(async () => readyProbe())
  models = vi.fn(async () => [
    {
      id: 'magpie/auto%2Fflash',
      label: 'Auto',
      provider: 'magpie',
      default: true,
      thinkingLevels: ['low'],
      defaultThinkingLevel: 'low',
    },
  ])
  backend = {
    probe: probe as unknown as RuntimeBackend['probe'],
    models: models as unknown as RuntimeBackend['models'],
    execute: vi.fn(),
  }
  handle = makeHandler()
})
afterEach(() => db.close())

describe('ai-workflow handler：运行时', () => {
  it('create 先探测再落库，返回 lastProbe 并触发 changed', async () => {
    const runtime = (await handle('runtimes.create', [
      { name: 'ds', command: 'dsh', profile: 'multica' },
    ])) as { id: string; lastProbe: RuntimeProbe }
    expect(probe).toHaveBeenCalledWith({ command: 'dsh', profile: 'multica' })
    expect(runtime.lastProbe).toEqual(readyProbe())
    const list = (await handle('runtimes.list', [])) as Array<{ name: string }>
    expect(list.map((r) => r.name)).toEqual(['ds'])
    expect(notify).toHaveBeenCalledTimes(1)
    // list 不触发
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('create 缺省命令/profile 时用 dsh + multica 探测', async () => {
    await handle('runtimes.create', [{ name: 'ds2' }])
    expect(probe).toHaveBeenCalledWith({ command: 'dsh', profile: 'multica' })
  })

  it('create 探测失败且没有 error 文案：给出「未知错误」', async () => {
    probe.mockResolvedValueOnce(readyProbe({ state: 'unavailable', error: null }))
    await expect(handle('runtimes.create', [{ name: 'bad2' }])).rejects.toThrow(/未知错误/)
    expect(repo.runtimesList()).toHaveLength(0)
  })
  it('create 探测失败：抛可读错误且不落库', async () => {
    probe.mockResolvedValueOnce(
      readyProbe({ state: 'unavailable', protocolVersion: null, error: '找不到命令' }),
    )
    await expect(handle('runtimes.create', [{ name: 'bad' }])).rejects.toThrow(
      /探测失败：找不到命令/,
    )
    expect(repo.runtimesList()).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('update 保存后重新探测并把结论写回', async () => {
    const runtime = repo.runtimeCreate({ name: 'ds' })
    probe.mockResolvedValueOnce(readyProbe({ cliVersion: '9.9.9' }))
    const updated = (await handle('runtimes.update', [
      runtime.id,
      { command: 'dsh2', profile: 'p2' },
    ])) as { command: string; lastProbe: RuntimeProbe }
    expect(probe).toHaveBeenCalledWith({ command: 'dsh2', profile: 'p2' })
    expect(updated.command).toBe('dsh2')
    expect(updated.lastProbe.cliVersion).toBe('9.9.9')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('probe 直接探测并落库；运行时不存在时报错', async () => {
    const runtime = repo.runtimeCreate({ name: 'ds' })
    const result = (await handle('runtimes.probe', [runtime.id])) as RuntimeProbe
    expect(result).toEqual(readyProbe())
    expect(repo.runtimeGet(runtime.id).lastProbe).toEqual(readyProbe())
    expect(notify).toHaveBeenCalledTimes(1)
    await expect(handle('runtimes.probe', ['ghost'])).rejects.toThrow(/运行时不存在/)
  })

  it('statuses 汇总实时负载（含 0 负载的运行时）', async () => {
    const a = repo.runtimeCreate({ name: 'a', maxConcurrent: 2 })
    const b = repo.runtimeCreate({ name: 'b' })
    const wf = repo.workflowCreate({ name: 'w', stages: [{ name: 's', entryMode: 'none' }] })
    const task = repo.taskCreate({ title: 't', workflowId: wf.id })
    repo.runCreate({
      taskId: task.id,
      stageId: null,
      agentId: null,
      runtimeId: a.id,
      prompt: 'p',
      status: 'queued',
    })
    repo.runCreate({
      taskId: task.id,
      stageId: null,
      agentId: null,
      runtimeId: a.id,
      prompt: 'p',
      status: 'running',
    })
    const statuses = (await handle('runtimes.statuses', [])) as Array<{
      runtimeId: string
      workload: { running: number; queued: number; maxConcurrent: number }
    }>
    expect(statuses).toEqual(
      expect.arrayContaining([
        { runtimeId: a.id, workload: { running: 1, queued: 1, maxConcurrent: 2 } },
        { runtimeId: b.id, workload: { running: 0, queued: 0, maxConcurrent: 1 } },
      ]),
    )
  })

  it('models 读该运行时的模型目录', async () => {
    const runtime = repo.runtimeCreate({ name: 'ds', command: 'dsh3', profile: 'p3' })
    const list = (await handle('runtimes.models', [runtime.id])) as Array<{ id: string }>
    expect(models).toHaveBeenCalledWith({ command: 'dsh3', profile: 'p3' })
    expect(list[0].id).toBe('magpie/auto%2Fflash')
  })

  it('detect 返回已安装 CLI 清单且不触发 changed', async () => {
    const result = (await handle('runtimes.detect', [])) as Array<{
      command: string
      label: string
      path: string
      supported: boolean
    }>
    expect(Array.isArray(result)).toBe(true)
    for (const item of result) {
      expect(typeof item.command).toBe('string')
      expect(typeof item.label).toBe('string')
      expect(typeof item.supported).toBe('boolean')
      expect(path.isAbsolute(item.path)).toBe(true)
    }
    expect(notify).not.toHaveBeenCalled()
  })

  it('agents.create 绑定运行时；被引用运行时删除报错且不触发 changed', () => {
    const rt = repo.runtimeCreate({ name: 'ds' })
    handle('agents.create', [{ name: 'coder', runtimeId: rt.id }])
    expect(notify).toHaveBeenCalledTimes(1)
    notify.mockClear()
    expect(() => handle('runtimes.remove', [rt.id])).toThrow(/引用/)
    expect(notify).not.toHaveBeenCalled()
  })

  it('未知方法抛错', () => {
    expect(() => handle('nope.nope', [])).toThrow(/未知方法/)
  })
})

describe('ai-workflow handler：聊天', () => {
  interface FakeChat {
    send: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }
  function withChat(): { h: AiWorkflowHandler; chat: FakeChat } {
    const chat: FakeChat = { send: vi.fn(async () => {}), cancel: vi.fn() }
    return {
      h: makeHandler({ chat: chat as unknown as ChatService }),
      chat,
    }
  }

  function seedAgent(h: AiWorkflowHandler): string {
    const rt = repo.runtimeCreate({ name: 'ds' })
    return (h('agents.create', [{ name: 'coder', runtimeId: rt.id }]) as { id: string }).id
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

    const bare = makeHandler()
    expect(() => bare('chat.send', [conv.id, 'hi'])).toThrow(/聊天服务未就绪/)
    expect(() => bare('chat.cancel', [conv.id])).toThrow(/聊天服务未就绪/)
  })
})

interface Wf {
  id: string
  stages: Array<{ id: string }>
}

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
    ]) as Wf
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
    ]) as Wf
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

describe('ai-workflow handler：任务/运行', () => {
  function seedAgent(): string {
    const rt = repo.runtimeCreate({ name: 'ds' })
    return (
      handle('agents.create', [{ name: 'coder', runtimeId: rt.id, systemPrompt: 'sys' }]) as {
        id: string
      }
    ).id
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
    const runs = handle('runs.listByTask', [task.id]) as Array<{
      status: string
      prompt: string
      runtimeId: string | null
    }>
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('queued')
    expect(runs[0].prompt).toContain('sys')
    expect(runs[0].runtimeId).toBeTruthy()

    expect(() => handle('tasks.moveToStage', [task.id, wf.stages[1].id])).toThrow(/不能拖动/)
    expect(() => handle('tasks.complete', [task.id])).toThrow(/不能完成/)
  })

  it('runs.events 返回事件流（空 / 有事件 / 不存在的 run）', () => {
    const agentId = seedAgent()
    const wf = handle('workflows.create', [
      {
        name: 'w3',
        stages: [
          { name: '执行', entryMode: 'agent', agentId },
          { name: '完成', entryMode: 'none' },
        ],
      },
    ]) as Wf
    const task = handle('tasks.create', [{ title: 'T3', workflowId: wf.id }]) as { id: string }
    const run = (handle('runs.listByTask', [task.id]) as Array<{ id: string }>)[0]
    expect(handle('runs.events', [run.id])).toEqual([])
    repo.runEventsAppend(run.id, [{ seq: 1, type: 'text', text: 'hi' }])
    expect(handle('runs.events', [run.id])).toEqual([{ seq: 1, type: 'text', text: 'hi' }])
    expect(handle('runs.events', ['ghost'])).toEqual([])
  })

  it('目标阶段无效 / 当前阶段无效时抛错', () => {
    const wf = handle('workflows.create', [
      { name: 'w4', stages: [{ name: '待办', entryMode: 'none' }] },
    ]) as Wf
    const task = handle('tasks.create', [{ title: 'T4', workflowId: wf.id }]) as { id: string }
    expect(() => handle('tasks.moveToStage', [task.id, 'ghost'])).toThrow(/目标阶段无效/)

    repo.taskUpdate(task.id, { currentStageId: null })
    expect(() => handle('tasks.moveToStage', [task.id, wf.stages[0].id])).toThrow(/无效/)
    expect(() => handle('tasks.complete', [task.id])).toThrow(/无效/)
  })
})

describe('ipc 补充', () => {
  it('agents.remove 删除未被引用的智能体', () => {
    const rt = repo.runtimeCreate({ name: 'ds' })
    const ag = handle('agents.create', [{ name: 'a', runtimeId: rt.id }]) as { id: string }
    handle('agents.remove', [ag.id])
    expect(handle('agents.list', [])).toEqual([])
  })

  it('runtimes/agents update 与 agents.list', async () => {
    const rt = repo.runtimeCreate({ name: 'ds' })
    await handle('runtimes.update', [rt.id, { name: 'ds2' }])
    const ag = handle('agents.create', [{ name: 'a', runtimeId: rt.id }]) as { id: string }
    handle('agents.update', [ag.id, { name: 'b' }])
    expect((handle('agents.list', []) as Array<{ name: string }>)[0].name).toBe('b')
    expect((repo.runtimesList() as Array<{ name: string }>)[0].name).toBe('ds2')
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
    registerAiWorkflowIpc({
      repo,
      notifyChanged: notify as unknown as () => void,
      backendFor: () => backend,
    })
    expect(ipcMainMock.handle).toHaveBeenCalledWith(AI_WORKFLOW_CHANNEL, expect.any(Function))
    const h = ipcMainMock.handle.mock.calls[0][1] as (
      e: unknown,
      m: string,
      a: unknown[],
    ) => unknown
    expect(h({}, 'runtimes.list', [])).toEqual([])
  })
})
