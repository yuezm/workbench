// @vitest-environment node
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Runtime, RuntimeModelOption, RuntimeProbe } from '../../src/shared/ai-workflow-api'
import { AI_WORKFLOW_CHANNEL } from '../../src/shared/ai-workflow-api'
import {
  createAiWorkflowHandler,
  registerAiWorkflowIpc,
  type AiWorkflowHandler,
} from '../../src/main/ai-workflow/ipc'
import type { ExecutorPort } from '../../src/protocol/executor'
import {
  agentById,
  createAgent,
  createRuntime,
  createTask,
  createWorkflow,
  createWorld,
  createdId,
  nextCommandId,
  resetCommandIds,
  runtimeById,
  taskById,
  updateRuntime,
  workflowById,
  type TestWorld,
} from './ipc-support'

const { ipcMainMock } = vi.hoisted(() => ({ ipcMainMock: { handle: vi.fn() } }))
vi.mock('electron', () => ({ ipcMain: ipcMainMock }))

let world: TestWorld
let notify: Mock<() => void>
let handle: AiWorkflowHandler
let probe: ReturnType<typeof vi.fn>
let models: ReturnType<typeof vi.fn>
let port: ExecutorPort

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

/**
 * 测试用统一写入口：真实 store.dispatch + 变更通知（模拟装配根的 effects.dispatch）。
 * handler 自身不再直接通知，通知语义由 effects 承担。
 */
function dispatch(input: unknown): ReturnType<TestWorld['store']['dispatch']> {
  const result = world.store.dispatch(input)
  notify()
  return result
}

function makeHandler(overrides: Partial<Parameters<typeof createAiWorkflowHandler>[0]> = {}) {
  return createAiWorkflowHandler({
    store: world.store,
    dispatch,
    executors: { forRuntime: () => port },
    executorDefaults: (key) => ({
      executorKey: key ?? 'dsh',
      command: 'dsh',
      profile: 'multica',
    }),
    ...overrides,
  })
}

/** 把任务投影改成非法状态（绕过 store 造数据损坏场景）。 */
function corruptTaskStage(taskId: string): void {
  world.db.prepare('UPDATE tasks SET current_stage_id=NULL WHERE id=?').run(taskId)
}

beforeEach(() => {
  vi.clearAllMocks()
  resetCommandIds()
  world = createWorld()
  notify = vi.fn<() => void>()
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
  port = {
    probe: async (runtime) =>
      (probe as unknown as (target: unknown) => Promise<RuntimeProbe>)(runtime),
    models: async (runtime) =>
      (models as unknown as (target: unknown) => Promise<RuntimeModelOption[]>)(runtime),
    run: vi.fn(),
  }
  handle = makeHandler()
})
afterEach(() => world.db.close())

describe('ai-workflow handler：运行时', () => {
  it('create 先探测再落库，返回 lastProbe 并触发 changed', async () => {
    const runtime = (await handle('runtimes.create', [
      { name: 'ds', command: 'dsh', profile: 'multica' },
    ])) as Runtime
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'dsh', profile: 'multica' }),
    )
    expect(runtime.lastProbe).toEqual(readyProbe())
    const list = (await handle('runtimes.list', [])) as Array<{ name: string }>
    expect(list.map((r) => r.name)).toEqual(['ds'])
    // 配置事实与探测事实都已落投影
    expect(runtimeById(world.store, runtime.id).lastProbe).toEqual(readyProbe())
    // 两次提交（配置事实 + 探测事实）各通知一次；list 不触发通知
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('create 缺省命令/profile 时用 dsh + multica 探测', async () => {
    await handle('runtimes.create', [{ name: 'ds2' }])
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'dsh', profile: 'multica' }),
    )
  })

  it('create 探测失败且没有 error 文案：给出「未知错误」', async () => {
    probe.mockResolvedValueOnce(readyProbe({ state: 'unavailable', error: null }))
    await expect(handle('runtimes.create', [{ name: 'bad2' }])).rejects.toThrow(/未知错误/)
    expect(world.store.query('runtimes.all')).toHaveLength(0)
  })
  it('create 探测失败：抛可读错误且不落库', async () => {
    probe.mockResolvedValueOnce(
      readyProbe({ state: 'unavailable', protocolVersion: null, error: '找不到命令' }),
    )
    await expect(handle('runtimes.create', [{ name: 'bad' }])).rejects.toThrow(
      /探测失败：找不到命令/,
    )
    expect(world.store.query('runtimes.all')).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })
  it('create 名称重复：决策拒绝，错误文案原样抛出', async () => {
    createRuntime(world, { name: 'ds' })
    await expect(handle('runtimes.create', [{ name: 'ds' }])).rejects.toThrow(/已存在/)
  })

  it('update 保存后重新探测并把结论写回', async () => {
    const runtime = createRuntime(world, { name: 'ds' })
    probe.mockResolvedValueOnce(readyProbe({ cliVersion: '9.9.9' }))
    const updated = (await handle('runtimes.update', [
      runtime.id,
      { command: 'dsh2', profile: 'p2' },
    ])) as Runtime
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ command: 'dsh2', profile: 'p2' }))
    expect(updated.command).toBe('dsh2')
    expect(updated.lastProbe?.cliVersion).toBe('9.9.9')
    // 配置事实 + 探测事实两次提交
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('probe 直接探测并落库；运行时不存在时报错', async () => {
    const runtime = createRuntime(world, { name: 'ds' })
    const result = (await handle('runtimes.probe', [runtime.id])) as RuntimeProbe
    expect(result).toEqual(readyProbe())
    expect(runtimeById(world.store, runtime.id).lastProbe).toEqual(readyProbe())
    expect(notify).toHaveBeenCalledTimes(1)
    await expect(handle('runtimes.probe', ['ghost'])).rejects.toThrow(/运行时不存在/)
  })

  it('statuses 汇总实时负载（含 0 负载的运行时）', async () => {
    const a = createRuntime(world, { name: 'a', maxConcurrent: 2 })
    const b = createRuntime(world, { name: 'b' })
    // 走事实路径造两条 run：agent 阶段的任务进入时内核入队，领取一条变 running
    const agentId = (
      handle('agents.create', [{ name: 'coder', runtimeId: a.id }]) as { id: string }
    ).id
    const wf = handle('workflows.create', [
      { name: 'w-load', stages: [{ name: '执行', entryMode: 'agent', agentId }] },
    ]) as Wf
    handle('tasks.create', [{ title: 't1', workflowId: wf.id }])
    handle('tasks.create', [{ title: 't2', workflowId: wf.id }])
    dispatch({ type: 'run.claim', runtimeId: a.id, capacity: 1 })
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
    const runtime = createRuntime(world, { name: 'ds', command: 'dsh3', profile: 'p3' })
    const list = (await handle('runtimes.models', [runtime.id])) as Array<{ id: string }>
    expect(models).toHaveBeenCalledWith(expect.objectContaining({ command: 'dsh3', profile: 'p3' }))
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
    const rt = createRuntime(world, { name: 'ds' })
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
  function seedAgent(h: AiWorkflowHandler): string {
    const rt = createRuntime(world, { name: 'ds' })
    return (h('agents.create', [{ name: 'coder', runtimeId: rt.id }]) as { id: string }).id
  }

  it('会话创建/列表/删除走事实与投影，写操作经 dispatch 通知', () => {
    const agentId = seedAgent(handle)
    notify.mockClear()

    const conv = handle('chat.createConversation', [agentId]) as {
      id: string
      title: string
      agentId: string
    }
    expect(notify).toHaveBeenCalledTimes(1)
    expect(conv.title).toBe('新对话')
    expect(conv.agentId).toBe(agentId)

    expect((handle('chat.listConversations', []) as unknown[]).length).toBe(1)
    expect(handle('chat.listMessages', [conv.id])).toEqual([])

    handle('chat.removeConversation', [conv.id])
    expect(notify).toHaveBeenCalledTimes(2)
    expect(handle('chat.listConversations', [])).toEqual([])
  })

  it('创建不存在的智能体：内核 reject 原样抛', () => {
    expect(() => handle('chat.createConversation', ['ghost'])).toThrow(/智能体不存在/)
    expect(world.store.query('conversations.all')).toEqual([])
  })

  it('conversation.create 缺事实防御：dispatch 未产 conversation.created 时抛错', () => {
    const handler = makeHandler({ dispatch: () => ({ facts: [] }) })

    expect(() => handler('chat.createConversation', ['ag-1'])).toThrow(
      '缺少事实: conversation.created',
    )
  })

  it('chat.send 落用户消息与 run.queued；并发/空内容/未知对话都 reject', () => {
    const agentId = seedAgent(handle)
    const conv = handle('chat.createConversation', [agentId]) as { id: string }

    handle('chat.send', [conv.id, '  第一问  '])
    const messages = handle('chat.listMessages', [conv.id]) as Array<{
      role: string
      content: string
    }>
    expect(messages).toEqual([expect.objectContaining({ role: 'user', content: '第一问' })])
    // 首条消息给对话命名
    expect((handle('chat.listConversations', []) as Array<{ title: string }>)[0]?.title).toBe(
      '第一问',
    )
    // 同一对话只跑一轮：第二轮 reject，且不落用户消息
    expect(() => handle('chat.send', [conv.id, '第二问'])).toThrow(/正在执行/)
    expect(handle('chat.listMessages', [conv.id])).toHaveLength(1)
    expect(() => handle('chat.send', [conv.id, '   '])).toThrow(/不能为空/)
    expect(() => handle('chat.send', ['ghost', '问'])).toThrow(/对话不存在/)
  })

  it('chat.send：运行时停用不落用户消息', () => {
    const agentId = seedAgent(handle)
    const conv = handle('chat.createConversation', [agentId]) as { id: string }
    const agent = world.store.query('agents.all').find((item) => item.id === agentId)
    updateRuntime(world, String(agent?.runtimeId), { enabled: false })
    expect(() => handle('chat.send', [conv.id, '问'])).toThrow(/已停用/)
    expect(handle('chat.listMessages', [conv.id])).toEqual([])
  })

  it('chat.cancel：对活跃 chat run 发 run.cancel；空闲对话无害', () => {
    const agentId = seedAgent(handle)
    const conv = handle('chat.createConversation', [agentId]) as { id: string }
    handle('chat.send', [conv.id, '问'])

    handle('chat.cancel', [conv.id])
    const types = (
      world.db.prepare('SELECT type FROM facts ORDER BY seq').all() as unknown as Array<{
        type: string
      }>
    ).map((row) => row.type)
    expect(types).toContain('run.cancel_requested')

    // 空闲对话：没有活跃 run 时什么也不做
    const idle = handle('chat.createConversation', [agentId]) as { id: string }
    expect(() => handle('chat.cancel', [idle.id])).not.toThrow()
  })

  it('删除对话：先取消活跃 chat run 再删对话（消息随事实级联删除）', () => {
    const agentId = seedAgent(handle)
    const conv = handle('chat.createConversation', [agentId]) as { id: string }
    handle('chat.send', [conv.id, '问'])

    handle('chat.removeConversation', [conv.id])

    expect(handle('chat.listConversations', [])).toEqual([])
    expect(handle('chat.listMessages', [conv.id])).toEqual([])
    const types = (
      world.db.prepare('SELECT type FROM facts ORDER BY seq').all() as unknown as Array<{
        type: string
      }>
    ).map((row) => row.type)
    expect(types.indexOf('run.cancel_requested')).toBeLessThan(
      types.indexOf('conversation.removed'),
    )
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

  it('更新缺失工作流：错误文案透传', () => {
    expect(() =>
      handle('workflows.update', [
        'ghost',
        { name: 'x', stages: [{ name: 'a', entryMode: 'none' }] },
      ]),
    ).toThrow(/工作流不存在/)
  })
})

describe('ai-workflow handler：任务/运行', () => {
  function seedAgent(): string {
    const rt = createRuntime(world, { name: 'ds' })
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
    expect(runs[0].prompt).toContain('# 阶段：执行')
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
    const run = (
      handle('runs.listByTask', [task.id]) as Array<{
        id: string
        runtimeId: string
      }>
    )[0]
    expect(handle('runs.events', [run.id])).toEqual([])
    // 领到 running 后按帧事实入账（帧 seq 由宿主分配）
    dispatch({ type: 'run.claim', runtimeId: run.runtimeId, capacity: 1 })
    dispatch({
      type: 'run.frames',
      runId: run.id,
      turn: 1,
      frames: [{ runId: run.id, seq: 1, type: 'text', text: 'hi' }],
    })
    expect(handle('runs.events', [run.id])).toEqual([{ seq: 1, type: 'text', text: 'hi' }])
    expect(handle('runs.events', ['ghost'])).toEqual([])
  })

  it('目标阶段无效 / 当前阶段无效时抛错', () => {
    const wf = handle('workflows.create', [
      { name: 'w4', stages: [{ name: '待办', entryMode: 'none' }] },
    ]) as Wf
    const task = handle('tasks.create', [{ title: 'T4', workflowId: wf.id }]) as { id: string }
    expect(() => handle('tasks.moveToStage', [task.id, 'ghost'])).toThrow(/目标阶段无效/)

    corruptTaskStage(task.id)
    expect(() => handle('tasks.moveToStage', [task.id, wf.stages[0].id])).toThrow(/无效/)
    expect(() => handle('tasks.complete', [task.id])).toThrow(/无效/)
  })
})

describe('ipc 补充', () => {
  it('agents.remove 删除未被引用的智能体', () => {
    const rt = createRuntime(world, { name: 'ds' })
    const ag = handle('agents.create', [{ name: 'a', runtimeId: rt.id }]) as { id: string }
    handle('agents.remove', [ag.id])
    expect(handle('agents.list', [])).toEqual([])
  })

  it('runtimes/agents update 与 agents.list', async () => {
    const rt = createRuntime(world, { name: 'ds' })
    await handle('runtimes.update', [rt.id, { name: 'ds2' }])
    const ag = handle('agents.create', [{ name: 'a', runtimeId: rt.id }]) as { id: string }
    handle('agents.update', [ag.id, { name: 'b' }])
    expect((handle('agents.list', []) as Array<{ name: string }>)[0].name).toBe('b')
    expect((world.store.query('runtimes.all') as Array<{ name: string }>)[0].name).toBe('ds2')
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

  it('停用运行时后智能体仍可读；停用不改变 lastProbe', async () => {
    const rt = createRuntime(world, { name: 'ds' })
    const disabled = updateRuntime(world, rt.id, { enabled: false })
    expect(disabled.enabled).toBe(false)
    expect(disabled.lastProbe).toBeNull()
    expect(createAgent(world, { name: 'a', runtimeId: rt.id }).runtimeId).toBe(rt.id)
    expect(agentList(world)).toHaveLength(1)
  })
})

function agentList(worldArg: TestWorld): Array<{ id: string }> {
  return worldArg.store.query('agents.all')
}

describe('registerAiWorkflowIpc', () => {
  it('在单一 RPC 通道上注册 handler', () => {
    registerAiWorkflowIpc({
      store: world.store,
      dispatch,
      executors: { forRuntime: () => port },
      executorDefaults: (key) => ({
        executorKey: key ?? 'dsh',
        command: 'dsh',
        profile: 'multica',
      }),
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

describe('ipc：投影查询助手（原 projection-lookup）', () => {
  it('createdId 按事实类型取四类新实体 id', () => {
    const runtime = createRuntime(world, { name: 'ds' })
    const agentFacts = world.store.dispatch({
      type: 'agent.create',
      commandId: nextCommandId(),
      input: { name: 'a2', runtimeId: runtime.id },
    }).facts
    const workflowFacts = world.store.dispatch({
      type: 'workflow.create',
      commandId: nextCommandId(),
      input: { name: 'w2', stages: [{ name: 's', entryMode: 'none' }] },
    }).facts
    const workflow = workflowById(world.store, createdId(workflowFacts, 'workflow.created'))
    const taskFacts = world.store.dispatch({
      type: 'task.create',
      commandId: nextCommandId(),
      input: { title: 'T2', workflowId: workflow.id },
    }).facts
    const runtimeFacts = world.store.dispatch({
      type: 'runtime.create',
      commandId: nextCommandId(),
      input: { name: 'ds2', executorKey: 'dsh', command: 'dsh' },
    }).facts

    expect(runtimeById(world.store, createdId(runtimeFacts, 'runtime.created')).name).toBe('ds2')
    expect(agentById(world.store, createdId(agentFacts, 'agent.created')).name).toBe('a2')
    expect(workflowById(world.store, createdId(workflowFacts, 'workflow.created')).name).toBe('w2')
    expect(taskById(world.store, createdId(taskFacts, 'task.created')).title).toBe('T2')
  })

  it('createdId：缺少事实 / 事实不携带实体 id 都报可读错误', () => {
    expect(() => createdId([], 'runtime.created')).toThrow('缺少事实: runtime.created')

    const runtime = createRuntime(world, { name: 'ds' })
    const facts = world.store.dispatch({
      type: 'runtime.update',
      commandId: nextCommandId(),
      id: runtime.id,
      patch: { name: 'ds2' },
    }).facts
    expect(() => createdId(facts, 'runtime.updated')).toThrow('事实不携带实体 id: runtime.updated')
  })

  it('按 id 取投影行；取不到给可读错误', () => {
    const runtime = createRuntime(world, { name: 'ds', maxConcurrent: 2 })
    const agent = createAgent(world, { name: 'coder', runtimeId: runtime.id })
    const workflow = createWorkflow(world, {
      name: 'w',
      stages: [{ name: 's', entryMode: 'none' }],
    })
    const task = createTask(world, { title: 'T', workflowId: workflow.id })

    expect(runtimeById(world.store, runtime.id)).toEqual(runtime)
    expect(agentById(world.store, agent.id)).toEqual(agent)
    expect(workflowById(world.store, workflow.id)).toEqual(workflow)
    expect(workflowById(world.store, workflow.id).stages).toHaveLength(1)
    expect(taskById(world.store, task.id)).toEqual(task)

    expect(() => runtimeById(world.store, 'ghost-rt')).toThrow('运行时不存在: ghost-rt')
    expect(() => agentById(world.store, 'ghost-ag')).toThrow('智能体不存在: ghost-ag')
    expect(() => workflowById(world.store, 'ghost-wf')).toThrow('工作流不存在: ghost-wf')
    expect(() => taskById(world.store, 'ghost-tk')).toThrow('任务不存在: ghost-tk')
  })
})

describe('ipc：运行历史读投影（原 repository runs 段）', () => {
  function agentStageWorkflow(): { agentId: string; workflowId: string } {
    const rt = createRuntime(world, { name: 'ds' })
    const agentId = (
      handle('agents.create', [{ name: 'coder', runtimeId: rt.id, systemPrompt: 'sys' }]) as {
        id: string
      }
    ).id
    const wf = handle('workflows.create', [
      { name: 'w-history', stages: [{ name: '执行', entryMode: 'agent', agentId }] },
    ]) as Wf
    return { agentId, workflowId: wf.id }
  }

  it('runs.listByTask：只返回该任务的阶段 run（调度列不外露），聊天 run 不进看板', () => {
    const { agentId, workflowId } = agentStageWorkflow()
    const task = handle('tasks.create', [{ title: 'T', workflowId }]) as { id: string }
    const runs = handle('runs.listByTask', [task.id]) as Array<Record<string, unknown>>
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ taskId: task.id, status: 'queued' })
    expect(runs[0]?.prompt).toContain('# 阶段：执行')
    // IPC 行不含调度列（purpose / lease / attempts 等）
    expect(runs[0]).not.toHaveProperty('purpose')
    expect(runs[0]).not.toHaveProperty('leaseId')

    // 同一任务的聊天 run（旧数据允许挂 task_id）不混进阶段历史
    const conv = handle('chat.createConversation', [agentId]) as { id: string }
    handle('chat.send', [conv.id, '问'])
    expect(handle('runs.listByTask', [task.id])).toHaveLength(1)
    expect(handle('runs.listByTask', ['ghost'])).toEqual([])
  })

  it('runs.events：按 seq 返回事件流；帧幂等覆盖不新增行', () => {
    const { workflowId } = agentStageWorkflow()
    const task = handle('tasks.create', [{ title: 'T2', workflowId }]) as { id: string }
    const run = (
      handle('runs.listByTask', [task.id]) as Array<{
        id: string
        runtimeId: string
      }>
    )[0]
    dispatch({ type: 'run.claim', runtimeId: run.runtimeId, capacity: 1 })
    dispatch({
      type: 'run.frames',
      runId: run.id,
      turn: 1,
      frames: [
        { runId: run.id, seq: 1, type: 'text', text: 'a' },
        { runId: run.id, seq: 2, type: 'tool_call', tool: 'read', callId: 'c1', input: '{}' },
      ],
    })
    expect(handle('runs.events', [run.id])).toEqual([
      { seq: 1, type: 'text', text: 'a' },
      { seq: 2, type: 'tool_call', tool: 'read', callId: 'c1', input: '{}' },
    ])
    // 同一 (run, seq) 重放：投影纯追加，主键冲突直接拒绝（不覆盖历史）
    expect(() =>
      dispatch({
        type: 'run.frames',
        runId: run.id,
        turn: 1,
        frames: [{ runId: run.id, seq: 2, type: 'text', text: 'b' }],
      }),
    ).toThrow()
    expect(handle('runs.events', [run.id])).toEqual([
      { seq: 1, type: 'text', text: 'a' },
      { seq: 2, type: 'tool_call', tool: 'read', callId: 'c1', input: '{}' },
    ])
  })
})
