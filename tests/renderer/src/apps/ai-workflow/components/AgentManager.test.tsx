import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Command } from '../../../../../../src/protocol/commands'
import type {
  Agent,
  Runtime,
  RuntimeProbe,
  RuntimeProbeState,
} from '../../../../../../src/protocol/entities'
import type { DispatchResult } from '../../../../../../src/protocol/ipc'
import { AgentManager } from '../../../../../../src/renderer/src/apps/ai-workflow/components/AgentManager'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

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
    executorKey: 'dsh',
    argsTemplate: '',
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

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

afterEach(() => {
  stopFakeKernel()
})

/** 预置两个视图：智能体清单与绑定运行时下拉的上游 */
function setup(agents: Agent[], runtimes: Runtime[]): void {
  kernel.setView('agents.all', undefined, agents)
  kernel.setView('runtimes.all', undefined, runtimes)
}

/** dispatch 注入：绕过 onDispatch 的泛型签名，测试里按命令 type 分支 */
function handleDispatch(
  handler: (command: Command) => Promise<DispatchResult<unknown>> | DispatchResult<unknown>,
): void {
  kernel.onDispatch(handler as unknown as Parameters<FakeKernel['onDispatch']>[0])
}

describe('AgentManager', () => {
  it('默认只显示清单，点击「新建智能体」才弹出表单', async () => {
    setup([agent()], [rt])

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
    setup(
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

  it('新建智能体（切换运行时、填描述与能力）后删除：都走 dispatch 且视图刷新', async () => {
    let agents: Agent[] = [agent()]
    setup(agents, [rt, rt2])
    handleDispatch((command) => {
      if (command.type === 'agent.create') {
        const created = agent({
          id: 'a2',
          name: command.input.name,
          runtimeId: command.input.runtimeId,
          description: command.input.description ?? '',
          systemPrompt: command.input.systemPrompt ?? '',
        })
        agents = [...agents, created]
        kernel.setView('agents.all', undefined, agents)
        return { facts: [], value: created }
      }
      if (command.type === 'agent.remove') {
        agents = agents.filter((item) => item.id !== command.id)
        kernel.setView('agents.all', undefined, agents)
        return { facts: [], value: null }
      }
      return { facts: [], value: null }
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

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'agent.create',
      input: {
        name: 'coder',
        runtimeId: 'r2',
        description: '写代码',
        systemPrompt: 'you are coder',
      },
    })
    expect(await screen.findByText('coder')).toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: /删除智能体/ })[0])
    await waitFor(() => expect(kernel.dispatched).toHaveLength(2))
    expect(kernel.dispatched[1]).toMatchObject({ type: 'agent.remove', id: 'a1' })
  })

  it('无运行时则禁用添加并提示；未知运行时的智能体显示原始 id 与描述', async () => {
    setup([agent({ id: 'a1', name: 'x', runtimeId: 'ghost', description: '有描述' })], [])

    const user = userEvent.setup()
    render(<AgentManager />)
    expect(await screen.findByText(/运行时：ghost · 未检测/)).toBeInTheDocument()
    expect(screen.getByText(/有描述/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新建智能体' }))
    expect(screen.getByRole('button', { name: '添加智能体' })).toBeDisabled()
    expect(screen.getByText(/请先在上方添加一个运行时/)).toBeInTheDocument()
  })

  it('智能体清单读取失败展示错误（非 Error 也会字符串化）', async () => {
    kernel.failView('agents.all', undefined, 'boom')
    kernel.setView('runtimes.all', undefined, [])
    render(<AgentManager />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('新建失败在弹窗内展示错误；删除失败展示错误', async () => {
    setup([agent()], [rt])
    handleDispatch((command) => {
      if (command.type === 'agent.create') return Promise.reject(new Error('create-fail'))
      if (command.type === 'agent.remove') return Promise.reject(new Error('remove-fail'))
      return { facts: [], value: null }
    })

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

  it('删除失败为非 Error 时按字符串展示', async () => {
    setup([agent()], [rt])
    handleDispatch((command) =>
      command.type === 'agent.remove'
        ? Promise.reject('删除纯文本失败')
        : { facts: [], value: null },
    )

    render(<AgentManager />)
    expect(await screen.findByText('old')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getAllByRole('button', { name: /删除智能体/ })[0])
    expect(await screen.findByText('删除纯文本失败')).toBeInTheDocument()
  })

  it('写入后清单重取失败也展示错误', async () => {
    setup([agent()], [rt])
    handleDispatch((command) => {
      if (command.type === 'agent.create') {
        // 命令成功落事实，但紧随其后的视图重取失败
        kernel.failView('agents.all', undefined, 'reload-boom')
        return { facts: [], value: agent({ id: 'a2', name: 'x' }) }
      }
      return { facts: [], value: null }
    })

    render(<AgentManager />)
    expect(await screen.findByText('old')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '新建智能体' }))
    await user.type(screen.getByLabelText('智能体名称'), 'x')
    await user.click(screen.getByRole('button', { name: '添加智能体' }))
    expect(await screen.findByText('reload-boom')).toBeInTheDocument()
  })

  it('新增运行时后经内核视图同步绑定下拉', async () => {
    setup([], [])

    const user = userEvent.setup()
    render(<AgentManager />)
    await user.click(screen.getByRole('button', { name: '新建智能体' }))
    expect(screen.getByRole('button', { name: '添加智能体' })).toBeDisabled()

    kernel.setView('runtimes.all', undefined, [rt])
    await waitFor(() => expect(screen.getByRole('button', { name: '添加智能体' })).toBeEnabled())
    expect(screen.getByLabelText('智能体运行时')).toHaveValue('r1')
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent('ds · 可用')

    // 运行时被删光后，下拉回落到空
    kernel.setView('runtimes.all', undefined, [])
    await waitFor(() => expect(screen.getByLabelText('智能体运行时')).toHaveValue(''))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent('（无）'),
    )
  })
})
