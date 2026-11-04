import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Agent,
  AiWorkflowApi,
  Runtime,
  RuntimeProbe,
  RuntimeProbeState,
} from '../../../../../../src/shared/ai-workflow-api'
import { AgentManager } from '../../../../../../src/renderer/src/apps/ai-workflow/components/AgentManager'

function setApi(api: unknown): void {
  ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = api
}

function probe(state: RuntimeProbeState, over: Partial<RuntimeProbe> = {}): RuntimeProbe {
  return {
    state,
    path: 'C:/tools/dsh.exe',
    cliVersion: '1.2.3',
    protocolVersion: 1,
    pluginVersion: null,
    error: state === 'ready' ? null : '登录态失效',
    output: '',
    elapsedMs: 12,
    checkedAt: 't',
    ...over,
  }
}

function makeRuntime(over: Partial<Runtime> = {}): Runtime {
  return {
    id: 'r1',
    name: 'ds',
    protocolFamily: 'dsh',
    command: 'dsh',
    profile: 'multica',
    permissionMode: 'workspace-write',
    model: null,
    reasoningEffort: null,
    workdir: null,
    maxConcurrent: 1,
    enabled: true,
    createdAt: 't',
    lastProbe: probe('ready'),
    ...over,
  }
}

const rt = makeRuntime()
const rt2 = makeRuntime({ id: 'r2', name: 'claude' })

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: 'old',
    description: '',
    runtimeId: 'r1',
    systemPrompt: '',
    createdAt: 't',
    ...over,
  }
}

function makeApi(agents: unknown[], runtimes: Runtime[]) {
  const api = {
    agents: {
      list: vi.fn(async () => agents as Agent[]),
      create: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
    },
    runtimes: {
      list: vi.fn(async () => runtimes),
      create: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
    },
  }
  setApi(api as unknown as Partial<AiWorkflowApi>)
  return api
}

beforeEach(() => vi.clearAllMocks())

describe('AgentManager', () => {
  it('默认只显示清单，点击「新建智能体」才弹出表单', async () => {
    makeApi([agent()], [rt])

    const user = userEvent.setup()
    render(<AgentManager />)
    expect(await screen.findByText('old')).toBeInTheDocument()
    expect(screen.queryByLabelText('智能体名称')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新建智能体' }))
    expect(screen.getByLabelText('智能体名称')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('智能体名称')).not.toBeInTheDocument()
  })

  it('行内展示绑定运行时名与健康状态点', async () => {
    makeApi(
      [agent({ description: '写代码' }), agent({ id: 'a3', name: 'ghost', runtimeId: 'missing' })],
      [
        makeRuntime({ id: 'r1', name: 'ds', lastProbe: probe('unavailable') }),
        makeRuntime({ id: 'r2', name: 'claude', lastProbe: probe('ready') }),
      ],
    )
    render(<AgentManager />)

    expect(await screen.findByText(/运行时：ds · 不可用/)).toBeInTheDocument()
    expect(screen.getByText(/写代码/)).toBeInTheDocument()
    expect(screen.getByText(/运行时：missing · 未检测/)).toBeInTheDocument()
  })

  it('加载运行时后新建智能体（切换运行时、填描述与能力）并删除', async () => {
    let agents: Agent[] = [agent()]
    const api = makeApi(agents, [rt, rt2])
    api.agents.list.mockImplementation(async () => agents)
    api.agents.create.mockImplementation(async (input: Agent & { name: string }) => {
      const n = agent({ id: 'a2', name: input.name, runtimeId: input.runtimeId })
      agents = [...agents, n]
      return n
    })
    api.agents.remove.mockImplementation(async (id: string) => {
      agents = agents.filter((x) => x.id !== id)
    })

    render(<AgentManager />)
    expect(await screen.findByText('old')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '新建智能体' }))
    await user.type(screen.getByLabelText('智能体名称'), 'coder')
    await user.click(screen.getByRole('combobox', { name: '智能体运行时' }))
    await user.click(screen.getByRole('option', { name: 'claude · 可用' }))
    await user.type(screen.getByLabelText('智能体描述'), '写代码')
    await user.type(screen.getByLabelText('智能体能力'), 'you are coder')
    await user.click(screen.getByRole('button', { name: '添加智能体' }))

    await waitFor(() => expect(api.agents.create).toHaveBeenCalled())
    expect(api.agents.create.mock.calls[0][0]).toMatchObject({
      name: 'coder',
      runtimeId: 'r2',
      description: '写代码',
      systemPrompt: 'you are coder',
    })
    expect(await screen.findByText('coder')).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: /删除智能体/ })[0])
    await waitFor(() => expect(api.agents.remove).toHaveBeenCalledWith('a1'))
  })

  it('无运行时则禁用添加并提示；未知运行时的智能体显示原始 id 与描述', async () => {
    makeApi([agent({ id: 'a1', name: 'x', runtimeId: 'ghost', description: '有描述' })], [])

    const user = userEvent.setup()
    render(<AgentManager />)
    expect(await screen.findByText(/运行时：ghost · 未检测/)).toBeInTheDocument()
    expect(screen.getByText(/有描述/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新建智能体' }))
    expect(screen.getByRole('button', { name: '添加智能体' })).toBeDisabled()
    expect(screen.getByText(/请先在上方添加一个运行时/)).toBeInTheDocument()
  })

  it('加载失败展示错误（非 Error 也会字符串化）', async () => {
    const api = makeApi([], [])
    api.agents.list.mockRejectedValue('boom')
    render(<AgentManager />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('新建失败在弹窗内展示错误；删除失败展示错误', async () => {
    const api = makeApi([agent()], [rt])
    api.agents.create.mockRejectedValue(new Error('create-fail'))
    api.agents.remove.mockRejectedValue(new Error('remove-fail'))

    render(<AgentManager />)
    expect(await screen.findByText('old')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '新建智能体' }))
    await user.type(screen.getByLabelText('智能体名称'), 'x')
    await user.click(screen.getByRole('button', { name: '添加智能体' }))
    expect(await screen.findByText('create-fail')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '取消' }))
    await user.click(screen.getAllByRole('button', { name: /删除智能体/ })[0])
    expect(await screen.findByText('remove-fail')).toBeInTheDocument()
  })

  it('加载未完成即卸载不报错', async () => {
    const api = makeApi([], [])
    api.agents.list.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 10)),
    )
    const { unmount } = render(<AgentManager />)
    unmount()
    await new Promise((r) => setTimeout(r, 20))
  })

  it('刷新列表失败展示错误', async () => {
    const api = makeApi([agent()], [rt])
    api.agents.list.mockResolvedValueOnce([agent()]).mockRejectedValueOnce(new Error('reload-boom'))

    render(<AgentManager />)
    expect(await screen.findByText('old')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '新建智能体' }))
    await user.type(screen.getByLabelText('智能体名称'), 'x')
    await user.click(screen.getByRole('button', { name: '添加智能体' }))
    expect(await screen.findByText('reload-boom')).toBeInTheDocument()
  })

  it('新增运行时后经变更事件同步绑定下拉', async () => {
    let runtimes: Runtime[] = []
    let changed: (() => void) | undefined
    setApi({
      agents: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
      },
      runtimes: {
        list: vi.fn(async () => runtimes),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
      },
      onChanged: vi.fn((cb: () => void) => {
        changed = cb
        return () => {}
      }),
    } as unknown as Partial<AiWorkflowApi>)

    const user = userEvent.setup()
    render(<AgentManager />)
    await user.click(screen.getByRole('button', { name: '新建智能体' }))
    expect(screen.getByRole('button', { name: '添加智能体' })).toBeDisabled()

    runtimes = [rt]
    changed?.()
    await waitFor(() => expect(screen.getByRole('button', { name: '添加智能体' })).toBeEnabled())
    expect(screen.getByLabelText('智能体运行时')).toHaveValue('r1')
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent('ds · 可用')

    // 运行时被删光后，下拉回落到空
    runtimes = []
    changed?.()
    await waitFor(() => expect(screen.getByLabelText('智能体运行时')).toHaveValue(''))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent('（无）'),
    )
  })
})
