// @vitest-environment node
/**
 * 装配根接给宿主的只读查询（`packages/bundle/base/src/host-views.ts`）。
 *
 * 每个 `case` 与每个「查不到 / 没有字段」的降级分支都直接构造投影行断言：
 * 运行时不存在、run 不存在、任务/阶段/智能体缺失、聊天续接的四种回退。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutorPlugin } from '@workbench/capabilities/types'
import type { ExecutorRegistryEntry } from '@workbench/plugins-registry'
import type { ExecutorPort } from '@workbench/protocol/executor'
import type { RunRow } from '@workbench/protocol/entities'
import type { PluginView } from '@workbench/protocol/plugins'
import {
  chatFallbackPromptOf,
  describeRunOf,
  hostViewOf,
  reconcileReadsOf,
  type StoreReader,
} from '@workbench/bundle-base/host-views'

let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-views-'))
  dirs.push(dir)
  return dir
}

/** 只读查询面：按视图 id 回固定行（`query` 的泛型签名在这里被压平） */
const reader = (rows: Record<string, unknown>): StoreReader => ({
  query: ((view: string) => rows[view]) as StoreReader['query'],
})

const executorEntry = (key: string, label = key): ExecutorRegistryEntry => ({
  key,
  label,
  plugin: {} as ExecutorPlugin,
  manifest: {
    id: key,
    kind: 'executor',
    name: label,
    version: '1.0.0',
    capabilities: [],
    config: [{ key: 'command', label: '命令', type: 'text', default: `${key}-cmd` }],
  },
})

const baseDeps = (overrides: Partial<Parameters<typeof hostViewOf>[0]> = {}) =>
  ({
    executors: [executorEntry('dsh', 'DSH')],
    forRuntime: () => null,
    detect: async () => [],
    store: reader({}),
    sessionsDir: tempDir(),
    defaultWorkdir: '/work/default',
    plugins: () => [],
    ...overrides,
  }) satisfies Parameters<typeof hostViewOf>[0]

const runRow = (patch: Partial<RunRow> = {}): RunRow =>
  ({
    id: 'run-1',
    purpose: 'stage',
    taskId: 't1',
    stageId: 'st-1',
    agentId: 'a1',
    conversationId: null,
    sessionId: 'sess-1',
    ...patch,
  }) as RunRow

const pluginView = (id: string): PluginView => ({
  id,
  kind: 'source',
  name: id,
  version: '1.0.0',
  description: '',
  builtin: true,
  enabled: true,
  declared: [],
  granted: [],
  configFields: [],
  config: {},
  secretKeys: [],
  status: 'ready',
  error: null,
})

describe('hostViewOf：宿主只读视图', () => {
  it('runtimes.executors：按注册表给出下拉', async () => {
    const hostView = hostViewOf(baseDeps())
    expect(await hostView('runtimes.executors', undefined)).toEqual([
      { key: 'dsh', label: 'DSH', command: 'dsh-cmd', profile: '' },
    ])
  })

  it('runtimes.detected：原样转发探测结果', async () => {
    const detected = [{ key: 'dsh', path: 'C:/dsh.exe', supported: true }]
    const hostView = hostViewOf(baseDeps({ detect: async () => detected as never }))
    expect(await hostView('runtimes.detected', undefined)).toBe(detected)
  })

  it('runtimes.models：运行时不存在 → 可读错误', async () => {
    const hostView = hostViewOf(baseDeps({ store: reader({ 'runtimes.all': [] }) }))
    expect(() => hostView('runtimes.models', { runtimeId: 'nope' })).toThrow('运行时不存在: nope')
  })

  it('runtimes.models：执行器没有模型目录 → 空数组（不是 undefined）', async () => {
    const hostView = hostViewOf(
      baseDeps({
        store: reader({ 'runtimes.all': [{ id: 'rt-1' }] }),
        forRuntime: () => ({}) as ExecutorPort,
      }),
    )
    await expect(hostView('runtimes.models', { runtimeId: 'rt-1' })).resolves.toEqual([])
  })

  it('runtimes.models：执行器带模型目录 → 转发端口结果', async () => {
    const models = vi.fn(async () => [{ id: 'sonnet', label: 'Sonnet' }])
    const hostView = hostViewOf(
      baseDeps({
        store: reader({ 'runtimes.all': [{ id: 'rt-1' }] }),
        forRuntime: () => ({ models }) as unknown as ExecutorPort,
      }),
    )
    await expect(hostView('runtimes.models', { runtimeId: 'rt-1' })).resolves.toEqual([
      { id: 'sonnet', label: 'Sonnet' },
    ])
    expect(models).toHaveBeenCalledWith({ id: 'rt-1' })
  })

  it('runtimes.models：没带 runtimeId 参数 → 按空 id 查，同样给可读错误', async () => {
    const hostView = hostViewOf(baseDeps({ store: reader({ 'runtimes.all': [] }) }))
    expect(() => hostView('runtimes.models', undefined)).toThrow('运行时不存在: ')
  })

  it('plugins.all：调用装配根注入的视图工厂（每次重取）', async () => {
    const plugins = vi.fn(() => [pluginView('webhook')])
    const hostView = hostViewOf(baseDeps({ plugins }))
    expect(await hostView('plugins.all', undefined)).toEqual([pluginView('webhook')])
    expect(plugins).toHaveBeenCalledTimes(1)
  })

  it('run.approvals：run 不存在 → 可读错误', () => {
    const hostView = hostViewOf(baseDeps({ store: reader({ 'run.byId': null }) }))
    expect(() => hostView('run.approvals', { runId: 'run-9' })).toThrow('运行不存在: run-9')
  })

  it('run.approvals：没带 runId 参数 → 按空 id 查，同样给可读错误', () => {
    const hostView = hostViewOf(baseDeps({ store: reader({ 'run.byId': null }) }))
    expect(() => hostView('run.approvals', undefined)).toThrow('运行不存在: ')
  })

  it('run.approvals：run 存在但会话日志没有 → 空数组（只读，不抛）', async () => {
    const sessionsDir = tempDir()
    const hostView = hostViewOf(
      baseDeps({
        sessionsDir,
        store: reader({ 'run.byId': runRow({ sessionId: 'sess-x' }) }),
      }),
    )
    await expect(hostView('run.approvals', { runId: 'run-1' })).resolves.toEqual([])
  })

  it('runtimes.default-workdir：回装配根解析出的默认目录', async () => {
    const hostView = hostViewOf(baseDeps({ defaultWorkdir: '/tmp/wb' }))
    expect(await hostView('runtimes.default-workdir', undefined)).toBe('/tmp/wb')
  })
})

describe('reconcileReadsOf：启动对账的三条读路径', () => {
  const waitingRow = (runId: string, hasOpenCard: boolean) => ({
    runId,
    leaseId: `${runId}:1`,
    turn: 2,
    hasOpenCard,
  })

  it('staleChatRuns / waitingRuns 原样映射（waiting 带上 hasOpenCard）', () => {
    const stale = [{ id: 'run-1', leaseId: 'run-1:1', turn: 1 }]
    const reads = reconcileReadsOf(
      reader({
        'runs.stale-chat': stale,
        'runs.waiting': [waitingRow('run-2', true), waitingRow('run-3', false)],
      }),
    )

    expect(reads.staleChatRuns?.()).toBe(stale)
    expect(reads.waitingRuns?.()).toEqual([
      { id: 'run-2', leaseId: 'run-2:1', turn: 2, hasOpenCard: true },
      { id: 'run-3', leaseId: 'run-3:1', turn: 2, hasOpenCard: false },
    ])
  })

  it('runStatus：投影里没有该 run → null（只清登记行，不按 pid 杀）', () => {
    const reads = reconcileReadsOf(reader({ 'run.byId': null }))
    expect(reads.runStatus('gone')).toBeNull()
  })

  it('runStatus：有 run 取其状态', () => {
    const reads = reconcileReadsOf(reader({ 'run.byId': { status: 'running' } }))
    expect(reads.runStatus('run-1')).toBe('running')
  })
})

describe('describeRunOf：归档标签', () => {
  const workflows = [
    {
      id: 'wf-1',
      name: '流程',
      stages: [
        { id: 'st-1', name: '干活' },
        { id: 'st-2', name: '收尾' },
      ],
    },
  ]

  it('任务 / 阶段 / 智能体都查得到：给名字', () => {
    const labels = describeRunOf(
      reader({
        'task.byId': { id: 't1', title: '写测试', workflowId: 'wf-1' },
        'workflows.all': workflows,
        'agents.all': [{ id: 'a1', name: '小助手' }],
      }),
      runRow(),
    )

    expect(labels).toEqual({
      taskId: 't1',
      taskTitle: '写测试',
      stageId: 'st-1',
      stageName: '干活',
      agentId: 'a1',
      agentName: '小助手',
    })
  })

  it('没有任务 / 没有阶段 / 没有智能体：id 照留，名字为 null（不阻断归档）', () => {
    const labels = describeRunOf(
      reader({ 'task.byId': null, 'workflows.all': workflows, 'agents.all': [] }),
      runRow({ taskId: null, stageId: null, agentId: null }),
    )

    expect(labels).toEqual({
      taskId: null,
      taskTitle: null,
      stageId: null,
      stageName: null,
      agentId: null,
      agentName: null,
    })
  })

  it('任务在但阶段不在流程里、智能体已删：名字回 null', () => {
    const labels = describeRunOf(
      reader({
        'task.byId': { id: 't1', title: '写测试', workflowId: 'wf-1' },
        'workflows.all': workflows,
        'agents.all': [],
      }),
      runRow({ stageId: 'st-9' }),
    )
    expect(labels.stageName).toBeNull()
    expect(labels.agentName).toBeNull()
    expect(labels.taskTitle).toBe('写测试')
  })

  it('run 有 taskId 但任务已删（只剩归档）：任务名回 null', () => {
    const labels = describeRunOf(
      reader({
        'task.byId': null,
        'workflows.all': workflows,
        'agents.all': [{ id: 'a1', name: '小助手' }],
      }),
      runRow(),
    )
    expect(labels.taskTitle).toBeNull()
    expect(labels.stageName).toBeNull()
    expect(labels.agentName).toBe('小助手')
  })
})

describe('chatFallbackPromptOf：续接被拒时的完整历史', () => {
  const messages = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
  ]

  it('聊天 run + 有会话 + 有消息：拼完整历史 prompt', () => {
    const prompt = chatFallbackPromptOf(
      reader({
        'agents.all': [{ id: 'a1', name: '小助手', systemPrompt: '你是助手' }],
        'messages.byConversation': messages,
      }),
      runRow({ purpose: 'chat', conversationId: 'conv-1' }),
    )

    expect(prompt).toContain('本轮对话')
    expect(prompt).toContain('用户：第一问')
    expect(prompt).toContain('你是助手')
  })

  it('非聊天 run → null（阶段 run 不走续接重试）', () => {
    const store = reader({
      'agents.all': [{ id: 'a1', name: '小助手' }],
      'messages.byConversation': messages,
    })
    expect(chatFallbackPromptOf(store, runRow({ purpose: 'stage' }))).toBeNull()
  })

  it('聊天 run 但没有会话 → null', () => {
    const store = reader({
      'agents.all': [{ id: 'a1', name: '小助手' }],
      'messages.byConversation': messages,
    })
    expect(
      chatFallbackPromptOf(store, runRow({ purpose: 'chat', conversationId: null })),
    ).toBeNull()
  })

  it('智能体已删 → null（退当前 prompt）', () => {
    const store = reader({
      'agents.all': [],
      'messages.byConversation': messages,
    })
    expect(
      chatFallbackPromptOf(store, runRow({ purpose: 'chat', conversationId: 'conv-1' })),
    ).toBeNull()
  })

  it('一条消息都没有 → null', () => {
    const store = reader({
      'agents.all': [{ id: 'a1', name: '小助手' }],
      'messages.byConversation': [],
    })
    expect(
      chatFallbackPromptOf(store, runRow({ purpose: 'chat', conversationId: 'conv-1' })),
    ).toBeNull()
  })
})
