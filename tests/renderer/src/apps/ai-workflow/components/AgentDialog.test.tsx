import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  Runtime,
  RuntimeProbe,
  RuntimeProbeState,
} from '../../../../../../src/shared/ai-workflow-api'
import { AgentDialog } from '../../../../../../src/renderer/src/apps/ai-workflow/components/AgentDialog'

function probe(state: RuntimeProbeState, over: Partial<RuntimeProbe> = {}): RuntimeProbe {
  return {
    state,
    path: 'C:/tools/dsh.exe',
    cliVersion: '1.2.3',
    protocolVersion: 1,
    pluginVersion: null,
    error: state === 'ready' ? null : '探测失败',
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

const empty = { name: '', description: '', runtimeId: '', systemPrompt: '' }

describe('AgentDialog', () => {
  it('无运行时时给出提示并禁用提交', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<AgentDialog runtimes={[]} initial={empty} onSubmit={onSubmit} onCancel={vi.fn()} />)

    expect(screen.getByText(/请先在上方添加一个运行时/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent('（无）')
    expect(screen.getByRole('button', { name: '添加智能体' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '添加智能体' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('运行时下拉展示健康状态，默认选中第一个可用（未检测也可用）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[
          makeRuntime({ id: 'r1', name: 'ds', lastProbe: null }),
          makeRuntime({ id: 'r2', name: 'claude', lastProbe: probe('ready') }),
        ]}
        initial={empty}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent('ds · 未检测')
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveValue('r1')

    await user.click(screen.getByRole('combobox', { name: '智能体运行时' }))
    expect(screen.getByRole('option', { name: 'ds · 未检测' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'claude · 可用' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '添加智能体' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ runtimeId: 'r1' })
  })

  it('初始运行时可用时保留绑定，不强行切到第一个', async () => {
    render(
      <AgentDialog
        runtimes={[
          makeRuntime({ id: 'r1', name: 'ds' }),
          makeRuntime({ id: 'r2', name: 'claude', lastProbe: probe('ready') }),
        ]}
        initial={{ ...empty, runtimeId: 'r2' }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveValue('r2')
  })

  it('不可用运行时选项禁用并提示，默认回落到首个可用项', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <AgentDialog
        runtimes={[
          makeRuntime({
            id: 'r1',
            name: '挂了',
            lastProbe: probe('unavailable', { error: '登录态失效' }),
          }),
          makeRuntime({ id: 'r2', name: 'claude', lastProbe: probe('ready') }),
        ]}
        initial={{ ...empty, runtimeId: 'r1' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText(/已禁用不可用运行时：挂了/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveValue('r2')

    await user.click(screen.getByRole('combobox', { name: '智能体运行时' }))
    expect(screen.getByRole('option', { name: '挂了 · 不可用' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.click(screen.getByRole('option', { name: '挂了 · 不可用' }))
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveValue('r2')

    await user.click(screen.getByRole('button', { name: '添加智能体' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ runtimeId: 'r2' })
  })

  it('所有运行时都不可用时禁用提交并提示', () => {
    render(
      <AgentDialog
        runtimes={[makeRuntime({ name: '挂了', lastProbe: probe('unavailable') })]}
        initial={empty}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText(/没有可用运行时/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加智能体' })).toBeDisabled()
  })

  it('填写名称/描述/能力后提交（含切换运行时）', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[
          makeRuntime({ id: 'r1', name: 'ds' }),
          makeRuntime({ id: 'r2', name: 'claude' }),
        ]}
        initial={empty}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('智能体名称'), 'coder')
    await user.type(screen.getByLabelText('智能体描述'), '写代码')
    await user.type(screen.getByLabelText('智能体能力'), 'you are coder')
    await user.click(screen.getByRole('combobox', { name: '智能体运行时' }))
    await user.click(screen.getByRole('option', { name: 'claude · 可用' }))
    await user.click(screen.getByRole('button', { name: '添加智能体' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({
      name: 'coder',
      description: '写代码',
      runtimeId: 'r2',
      systemPrompt: 'you are coder',
    })
  })

  it('预填缺省描述与能力时回落到空串', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime({ lastProbe: null })]}
        initial={{ name: 'n', runtimeId: 'r1' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('智能体描述')).toHaveValue('')
    expect(screen.getByLabelText('智能体能力')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: '添加智能体' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ description: '', systemPrompt: '' })
  })

  it('提交失败在弹窗内展示错误', async () => {
    const onSubmit = vi.fn().mockRejectedValue('create-fail')
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={empty}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '添加智能体' }))
    expect(await screen.findByText('create-fail')).toBeInTheDocument()
  })
})
