import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  Runtime,
  RuntimeProbe,
  RuntimeProbeState,
} from '../../../../../../src/protocol/entities'
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

    expect(screen.getByText(/先添加运行时/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent('无')
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '添加' }))
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

    await user.click(screen.getByRole('combobox', { name: '智能体运行时' }))
    // 上游触发器没有 value 属性：改断言浮层里选中项的 checked 状态
    expect(screen.getByRole('option', { name: 'ds · 未检测' })).toHaveAttribute(
      'data-state',
      'checked',
    )
    expect(screen.getByRole('option', { name: 'claude · 可用' })).toHaveAttribute(
      'data-state',
      'unchecked',
    )
    expect(screen.getByRole('option', { name: 'ds · 未检测' })).toBeInTheDocument()
    // 浮层打开时 Radix 会把弹窗本体标成 aria-hidden：这时取触发器要带 hidden
    expect(screen.getByRole('combobox', { name: '智能体运行时', hidden: true })).toHaveTextContent(
      'ds · 未检测',
    )

    // 收起浮层（浮层打开时弹窗内其它元素不可点），再填名验证「默认运行时随提交带上」
    await user.keyboard('{Escape}')
    await user.type(screen.getByLabelText('智能体名称'), 'coder')
    await user.click(screen.getByRole('button', { name: '添加' }))
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
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent(
      'claude · 可用',
    )
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

    expect(screen.getByText(/不可用：挂了/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent(
      'claude · 可用',
    )

    // 先把名称填好：下拉浮层打开时点输入框会把焦点抢回触发器
    await user.type(screen.getByLabelText('智能体名称'), 'coder')

    await user.click(screen.getByRole('combobox', { name: '智能体运行时' }))
    expect(screen.getByRole('option', { name: '挂了 · 不可用' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await user.click(screen.getByRole('option', { name: '挂了 · 不可用' }))
    // 点禁用项不改变选择（浮层打开时弹窗被 Radix 标成 aria-hidden，取触发器要带 hidden）
    expect(screen.getByRole('combobox', { name: '智能体运行时', hidden: true })).toHaveTextContent(
      'claude · 可用',
    )

    // 收起浮层后再提交（浮层打开时弹窗内其它元素不可点）
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: '添加' }))
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
    // 禁用必须写原因：否则用户只看到点不动
    expect(screen.getByText(/缺少可绑定的运行时/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()
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
    await user.click(screen.getByRole('button', { name: '添加' }))

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
    await user.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ description: '', systemPrompt: '' })
  })

  it('提交失败在弹窗内展示错误，且错误条可关闭、输入不丢', async () => {
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

    await user.type(screen.getByLabelText('智能体名称'), 'coder')
    await user.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText('create-fail')).toBeInTheDocument()
    // 父级 reject 不关弹窗、不清输入
    expect(screen.getByLabelText('智能体名称')).toHaveValue('coder')

    await user.click(screen.getByRole('button', { name: '关闭错误提示' }))
    expect(screen.queryByText('create-fail')).not.toBeInTheDocument()
  })

  it('名称为空：保存时就地报必填并把焦点移到名称，不调父级', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={empty}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    // 名称与绑定运行时都标了必填（读屏读「必填」）
    expect(screen.getAllByText('必填')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '添加' }))

    expect(await screen.findByText('名称必填')).toBeInTheDocument()
    expect(screen.getByLabelText('智能体名称')).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('名称只有空格同样按空处理', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={empty}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('智能体名称'), '   ')
    await user.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText('名称必填')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('名称与多行文本提交前都 trim', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={empty}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    await user.type(screen.getByLabelText('智能体名称'), '  coder  ')
    await user.type(screen.getByLabelText('智能体描述'), ' 写代码 ')
    await user.type(screen.getByLabelText('智能体能力'), ' you are coder ')
    await user.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({
      name: 'coder',
      description: '写代码',
      runtimeId: 'r1',
      systemPrompt: 'you are coder',
    })
  })

  it('编辑态：标题与按钮文案切换，保留不可用的原运行时并提交 trim 后的值', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime({ id: 'r1', name: '挂了', lastProbe: probe('unavailable') })]}
        initial={{ name: ' coder ', runtimeId: 'r1' }}
        mode="edit"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText('编辑智能体')).toBeInTheDocument()
    // 编辑时保留原绑定：不因为该运行时已不可用就悄悄改绑 / 拦住保存
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent(
      '挂了 · 不可用',
    )
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'coder', runtimeId: 'r1' })
  })

  it('没有运行时时按钮禁用并写明原因；程序化提交落到运行时字段错误', async () => {
    const onSubmit = vi.fn()
    render(<AgentDialog runtimes={[]} initial={empty} onSubmit={onSubmit} onCancel={vi.fn()} />)

    expect(screen.getByText(/缺少可绑定的运行时/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()

    // 按钮禁用时表单也可能被回车 / 程序化提交：不能静默 return，要给字段级错误并聚焦
    fireEvent.change(screen.getByLabelText('智能体名称'), { target: { value: 'coder' } })
    // 弹窗内容渲染在 portal 里，表单不在 render 容器内：从弹窗里取
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement)
    expect(await screen.findByText(/没有可绑定的运行时/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
