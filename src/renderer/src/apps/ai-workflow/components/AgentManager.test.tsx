import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, AiWorkflowApi, Runtime } from '../../../../../shared/ai-workflow-api'
import { AgentManager } from './AgentManager'

function setApi(api: unknown): void {
  ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = api
}

const rt: Runtime = {
  id: 'r1',
  name: 'ds',
  kind: 'deepseek-harness',
  command: 'dsh',
  args: [],
  promptMode: 'arg',
  workdir: null,
  createdAt: 't',
}
const rt2: Runtime = { ...rt, id: 'r2', name: 'claude' }

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

beforeEach(() => vi.clearAllMocks())

describe('AgentManager', () => {
  it('加载运行时后新建智能体（切换运行时、填描述与能力）并删除', async () => {
    let agents: Agent[] = [agent()]
    const agentList = vi.fn(async () => agents)
    const create = vi.fn(async (input: { name: string; runtimeId: string }) => {
      const n = agent({ id: 'a2', name: input.name, runtimeId: input.runtimeId })
      agents = [...agents, n]
      return n
    })
    const remove = vi.fn(async (id: string) => {
      agents = agents.filter((x) => x.id !== id)
    })
    setApi({
      agents: { list: agentList, create, remove, update: vi.fn() },
      runtimes: { list: vi.fn().mockResolvedValue([rt, rt2]) },
    } as unknown as Partial<AiWorkflowApi>)

    render(<AgentManager />)
    expect(await screen.findByText('old')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('智能体名称'), 'coder')
    await user.click(screen.getByRole('combobox', { name: '智能体运行时' }))
    await user.click(screen.getByRole('option', { name: 'claude' }))
    await user.type(screen.getByLabelText('智能体描述'), '写代码')
    await user.type(screen.getByLabelText('智能体能力'), 'you are coder')
    await user.click(screen.getByRole('button', { name: '添加智能体' }))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0]).toMatchObject({
      name: 'coder',
      runtimeId: 'r2',
      description: '写代码',
      systemPrompt: 'you are coder',
    })
    expect(await screen.findByText('coder')).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await waitFor(() => expect(remove).toHaveBeenCalledWith('a1'))
  })

  it('无运行时则禁用添加并提示；未知运行时的智能体显示原始 id 与描述', async () => {
    setApi({
      agents: {
        list: vi
          .fn()
          .mockResolvedValue([
            agent({ id: 'a1', name: 'x', runtimeId: 'ghost', description: '有描述' }),
          ]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
      },
      runtimes: { list: vi.fn().mockResolvedValue([]) },
    } as unknown as Partial<AiWorkflowApi>)

    render(<AgentManager />)
    expect(await screen.findByText(/ghost/)).toBeInTheDocument()
    expect(screen.getByText(/有描述/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加智能体' })).toBeDisabled()
    expect(screen.getByText(/请先在上方添加一个运行时/)).toBeInTheDocument()
  })

  it('加载失败展示错误（非 Error 也会字符串化）', async () => {
    setApi({
      agents: {
        list: vi.fn().mockRejectedValue('boom'),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
      },
      runtimes: { list: vi.fn().mockResolvedValue([]) },
    } as unknown as Partial<AiWorkflowApi>)
    render(<AgentManager />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('新建失败与删除失败均展示错误', async () => {
    setApi({
      agents: {
        list: vi.fn().mockResolvedValue([agent()]),
        create: vi.fn().mockRejectedValue(new Error('create-fail')),
        remove: vi.fn().mockRejectedValue(new Error('remove-fail')),
        update: vi.fn(),
      },
      runtimes: { list: vi.fn().mockResolvedValue([rt]) },
    } as unknown as Partial<AiWorkflowApi>)

    render(<AgentManager />)
    expect(await screen.findByText('old')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('智能体名称'), 'x')
    await user.click(screen.getByRole('button', { name: '添加智能体' }))
    expect(await screen.findByText('create-fail')).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    expect(await screen.findByText('remove-fail')).toBeInTheDocument()
  })

  it('加载未完成即卸载不报错', async () => {
    const slow = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 10)))
    setApi({
      agents: { list: slow, create: vi.fn(), remove: vi.fn(), update: vi.fn() },
      runtimes: { list: vi.fn().mockResolvedValue([]) },
    } as unknown as Partial<AiWorkflowApi>)
    const { unmount } = render(<AgentManager />)
    unmount()
    await new Promise((r) => setTimeout(r, 20))
  })

  it('刷新列表失败展示错误', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([agent()])
      .mockRejectedValue(new Error('reload-boom'))
    setApi({
      agents: {
        list,
        create: vi.fn().mockResolvedValue(agent({ id: 'a2' })),
        remove: vi.fn(),
        update: vi.fn(),
      },
      runtimes: { list: vi.fn().mockResolvedValue([rt]) },
    } as unknown as Partial<AiWorkflowApi>)

    render(<AgentManager />)
    expect(await screen.findByText('old')).toBeInTheDocument()
    const user = userEvent.setup()
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

    render(<AgentManager />)
    expect(screen.getByRole('button', { name: '添加智能体' })).toBeDisabled()

    runtimes = [rt]
    changed?.()
    await waitFor(() => expect(screen.getByRole('button', { name: '添加智能体' })).toBeEnabled())
    expect(screen.getByLabelText('智能体运行时')).toHaveValue('r1')
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent('ds')

    // 运行时被删光后，下拉回落到空
    runtimes = []
    changed?.()
    await waitFor(() => expect(screen.getByLabelText('智能体运行时')).toHaveValue(''))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent('（无）'),
    )
  })
})
