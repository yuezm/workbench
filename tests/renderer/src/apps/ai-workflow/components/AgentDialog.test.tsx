import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Runtime,
  RuntimeModelOption,
  RuntimeProbe,
  RuntimeProbeState,
} from '../../../../../../src/protocol/entities'
import type { ViewId, ViewParams, ViewResult } from '../../../../../../src/protocol/views'
import {
  AgentDialog,
  formatEnvText,
  parseEnvText,
} from '../../../../../../src/renderer/src/apps/ai-workflow/components/AgentDialog'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

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

/** 运行时只是一条连接：执行配置全在智能体上 */
function makeRuntime(over: Partial<Runtime> = {}): Runtime {
  return {
    id: 'r1',
    name: 'ds',
    executorKey: 'dsh',
    argsTemplate: '',
    command: 'dsh',
    profile: 'multica',
    enabled: true,
    createdAt: 't',
    lastProbe: probe('ready'),
    ...over,
  }
}

function makeModel(over: Partial<RuntimeModelOption> = {}): RuntimeModelOption {
  return {
    id: 'deepseek/chat',
    label: 'DeepSeek Chat',
    provider: 'deepseek',
    default: true,
    thinkingLevels: ['low', 'high'],
    defaultThinkingLevel: 'low',
    ...over,
  }
}

const empty = { name: '', description: '', runtimeId: '', systemPrompt: '' }

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

afterEach(() => {
  stopFakeKernel()
})

/** 弹窗用两个宿主视图：models（按所选运行时）与 default-workdir（工作目录占位） */
function setup(
  options: { runtimeId?: string; models?: RuntimeModelOption[]; defaultWorkdir?: string } = {},
): void {
  if (options.models !== undefined) {
    kernel.setView('runtimes.models', { runtimeId: options.runtimeId ?? 'r1' }, options.models)
  }
  if (options.defaultWorkdir !== undefined) {
    kernel.setView('runtimes.default-workdir', undefined, options.defaultWorkdir)
  }
}

/** 记录窗口对 store.query 的调用（宿主视图走它，不经 useKernelView） */
function recordQueries(): Array<{ view: ViewId; params?: unknown }> {
  const calls: Array<{ view: ViewId; params?: unknown }> = []
  const original = kernel.store.query
  kernel.store.query = <T extends ViewId>(
    view: T,
    params?: ViewParams<T>,
  ): Promise<ViewResult<T>> => {
    calls.push({ view, params })
    return original(view, params)
  }
  return calls
}

/** 让 `runtimes.models` 的查询悬起（验证读取中的禁用态）；返回手动收尾的句柄 */
function holdModelsQuery(): {
  reject: (e: unknown) => void
  resolve: (v: RuntimeModelOption[]) => void
} {
  let reject!: (e: unknown) => void
  let resolve!: (v: RuntimeModelOption[]) => void
  const pending = new Promise<RuntimeModelOption[]>((res, rej) => {
    reject = rej
    resolve = res
  })
  const original = kernel.store.query
  kernel.store.query = <T extends ViewId>(
    view: T,
    params?: ViewParams<T>,
  ): Promise<ViewResult<T>> => {
    if (view === 'runtimes.models') return pending as Promise<ViewResult<T>>
    return original(view, params)
  }
  return { reject, resolve }
}

/** 默认提交值：执行配置全走缺省（默认模型 / 默认强度 / 并发 1 / 可写 / 无目录 / 无变量） */
const DEFAULT_EXECUTION = {
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
}

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
    setup()
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
    setup({ runtimeId: 'r2' })
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
    setup()
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

  it('填写名称/描述/能力后提交（含切换运行时），执行配置走缺省', async () => {
    setup({ runtimeId: 'r2' })
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
      ...DEFAULT_EXECUTION,
    })
  })

  it('预填缺省描述与能力时回落到空串', async () => {
    setup()
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
    setup()
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
    setup()
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
    setup()
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
    setup()
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
      ...DEFAULT_EXECUTION,
    })
    // 并行全量跑时 userEvent 逐字符输入会排队：给用例更长的超时，断言一条不动
  }, 20_000)

  it('编辑态：标题与按钮文案切换，保留不可用的原运行时并提交 trim 后的值', async () => {
    setup()
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

  it('Esc 关闭弹窗：走 dismiss 收口到 onCancel，不提交任何东西', async () => {
    setup()
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={empty}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    )

    await user.type(screen.getByLabelText('智能体名称'), 'coder')
    await user.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('模型目录按所选运行时查询：预填的模型与思考强度回显，提交原样带上', async () => {
    const model = makeModel()
    setup({ models: [model] })
    const queries = recordQueries()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{
          name: 'n',
          runtimeId: 'r1',
          model: model.id,
          reasoningEffort: 'high',
          maxConcurrent: 3,
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    // 模型目录是「连接决定有哪些模型」：查询参数必须是所选运行时
    expect(queries).toContainEqual({ view: 'runtimes.models', params: { runtimeId: 'r1' } })
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '智能体模型' })).toHaveTextContent(
        'DeepSeek Chat',
      ),
    )
    expect(screen.queryByLabelText('智能体模型手填')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '智能体思考强度' })).toBeEnabled(),
    )
    expect(screen.getByRole('combobox', { name: '智能体思考强度' })).toHaveTextContent('high')

    await user.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      model: 'deepseek/chat',
      reasoningEffort: 'high',
      maxConcurrent: 3,
    })
  })

  it('模型目录读取中禁用下拉并提示；读取失败仍可手动填模型 id', async () => {
    setup()
    const { reject } = holdModelsQuery()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'n', runtimeId: 'r1', model: 'custom/model' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText('读取模型中…')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '智能体模型' })).toBeDisabled()

    reject(new Error('models-down'))
    expect(await screen.findByText(/模型加载失败：models-down/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '智能体模型' })).toBeEnabled()
    expect(screen.getByRole('combobox', { name: '智能体模型' })).toHaveTextContent('custom/model')

    // 切到手动输入再改：目录不可用时也能落一个明确的值
    await user.click(screen.getByRole('combobox', { name: '智能体模型' }))
    await user.click(screen.getByRole('option', { name: '手动输入…' }))
    await user.clear(screen.getByLabelText('智能体模型手填'))
    await user.type(screen.getByLabelText('智能体模型手填'), ' manual/model ')
    await user.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ model: 'manual/model' })
  })

  it('模型下拉可切默认/手动输入，思考强度随模型清空', async () => {
    setup({ models: [makeModel()] })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'n', runtimeId: 'r1', model: null, reasoningEffort: 'high' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    // 未知目录时已有的思考强度仍显示出来
    expect(await screen.findByRole('combobox', { name: '智能体思考强度' })).toHaveTextContent(
      'high',
    )

    await user.click(screen.getByRole('combobox', { name: '智能体模型' }))
    await user.click(screen.getByRole('option', { name: 'DeepSeek Chat' }))
    expect(screen.getByRole('combobox', { name: '智能体模型' })).toHaveTextContent('DeepSeek Chat')
    expect(screen.getByRole('combobox', { name: '智能体思考强度' })).toHaveTextContent('默认')

    await user.click(screen.getByRole('combobox', { name: '智能体思考强度' }))
    await user.click(screen.getByRole('option', { name: 'high' }))

    await user.click(screen.getByRole('combobox', { name: '智能体模型' }))
    await user.click(screen.getByRole('option', { name: '手动输入…' }))
    expect(screen.getByLabelText('智能体模型手填')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: '智能体思考强度' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ model: null, reasoningEffort: null })
  })

  it('编辑：模型与思考强度保留预填值，提交不丢', async () => {
    setup({ models: [makeModel()] })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{
          name: 'n',
          runtimeId: 'r1',
          model: 'deepseek/chat',
          reasoningEffort: 'low',
        }}
        mode="edit"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '智能体模型' })).toHaveTextContent(
        'DeepSeek Chat',
      ),
    )
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      model: 'deepseek/chat',
      reasoningEffort: 'low',
    })
  })

  it('已有模型不在目录里时补一条选项，未知思考强度仍显示且无能力清单时禁用', async () => {
    setup({ models: [] })
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{
          name: 'n',
          runtimeId: 'r1',
          model: 'custom/model',
          reasoningEffort: 'max',
        }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '智能体模型' })).toHaveTextContent(
        'custom/model',
      ),
    )
    expect(screen.getByRole('combobox', { name: '智能体思考强度' })).toHaveTextContent('max')
    expect(screen.getByRole('combobox', { name: '智能体思考强度' })).toBeDisabled()
  })

  it('模型目录查询无数据时保留已有模型 id（不悄悄改成默认）', async () => {
    // 不预置 runtimes.models：查询返回 undefined，按空目录处理
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'n', runtimeId: 'r1', model: 'custom/model' }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '智能体模型' })).toHaveTextContent(
        'custom/model',
      ),
    )
    expect(screen.getByRole('combobox', { name: '智能体模型' })).toBeEnabled()
  })

  it('模型 id 不是 provider/model：就地报错并聚焦，不调父级', async () => {
    setup({ models: [makeModel()] })
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'n', runtimeId: 'r1' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByRole('combobox', { name: '智能体模型' })).toBeEnabled())
    await user.click(screen.getByRole('combobox', { name: '智能体模型' }))
    await user.click(screen.getByRole('option', { name: '手动输入…' }))
    await user.type(screen.getByLabelText('智能体模型手填'), 'nomodel')
    await user.click(screen.getByRole('button', { name: '添加' }))

    expect(await screen.findByText('模型 id 必须是 provider/model 形式')).toBeInTheDocument()
    expect(screen.getByLabelText('智能体模型手填')).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('已有模型不是 provider/model：同样就地报错，焦点落回模型下拉', async () => {
    setup({ models: [makeModel()] })
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'n', runtimeId: 'r1', model: 'nomodel' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByRole('combobox', { name: '智能体模型' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '添加' }))

    expect(await screen.findByText('模型 id 必须是 provider/model 形式')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '智能体模型' })).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('并发上限非法：给文案并聚焦，不静默回落成 1', async () => {
    setup()
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

    await user.type(screen.getByLabelText('智能体名称'), 'x')
    await user.type(screen.getByLabelText('智能体工作目录'), ' D:/work ')

    const concurrent = screen.getByLabelText('智能体并发上限')
    await user.clear(concurrent)
    await user.type(concurrent, '0')
    await user.click(screen.getByRole('button', { name: '添加' }))

    // 0 不再被悄悄改成 1：就地报错、聚焦该字段、不调父级
    expect(await screen.findByText('并发上限必须是 ≥1 的整数')).toBeInTheDocument()
    expect(concurrent).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()

    // 小数同样非法（不是正整数）
    await user.clear(concurrent)
    await user.type(concurrent, '1.5')
    await user.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByText('并发上限必须是 ≥1 的整数')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    await user.clear(concurrent)
    await user.type(concurrent, '2')
    await user.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ maxConcurrent: 2, workdir: 'D:/work' })
  })

  it('完全访问未勾确认：按钮禁用并写明「为什么点不动」', async () => {
    setup()
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'x', runtimeId: 'r1' }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('combobox', { name: '智能体访问权限' }))
    await user.click(screen.getByRole('option', { name: '完全访问' }))

    expect(screen.getByText(/先勾选上面的/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()

    await user.click(screen.getByLabelText('已确认完全访问风险'))
    expect(screen.queryByText(/先勾选上面的/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加' })).toBeEnabled()
  })

  it('完全访问：必须勾选风险确认才可保存，勾选后提交带上 danger-full-access', async () => {
    setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'x', runtimeId: 'r1' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('combobox', { name: '智能体访问权限' }))
    await user.click(screen.getByRole('option', { name: '完全访问' }))

    const save = screen.getByRole('button', { name: '添加' })
    expect(screen.getByText(/完全访问没有沙箱/)).toBeInTheDocument()
    expect(save).toBeDisabled()

    await user.click(screen.getByLabelText('已确认完全访问风险'))
    expect(save).toBeEnabled()
    await user.click(save)
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ permissionMode: 'danger-full-access' }),
      ),
    )
  })

  it('完全访问确认只对当前选择有效：换模式即撤销，再选回要重新勾', async () => {
    setup()
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'x', runtimeId: 'r1' }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    const save = screen.getByRole('button', { name: '添加' })

    await user.click(screen.getByRole('combobox', { name: '智能体访问权限' }))
    await user.click(screen.getByRole('option', { name: '完全访问' }))
    await user.click(screen.getByLabelText('已确认完全访问风险'))
    expect(save).toBeEnabled()

    await user.click(screen.getByRole('combobox', { name: '智能体访问权限' }))
    await user.click(screen.getByRole('option', { name: '可写' }))
    expect(screen.queryByText(/完全访问没有沙箱/)).toBeNull()
    expect(save).toBeEnabled()

    await user.click(screen.getByRole('combobox', { name: '智能体访问权限' }))
    await user.click(screen.getByRole('option', { name: '完全访问' }))
    expect(save).toBeDisabled()
  })

  it('工作目录：留空时占位提示宿主默认目录，并说明用 WORKBENCH_WORKDIR 覆盖', async () => {
    setup({ defaultWorkdir: 'C:/Users/me/.workbench' })
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'x', runtimeId: 'r1' }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('智能体工作目录')).toHaveAttribute(
        'placeholder',
        'C:/Users/me/.workbench',
      ),
    )
    expect(screen.getByText(/WORKBENCH_WORKDIR/)).toBeInTheDocument()
  })

  it('默认工作目录读取失败：占位回落到「留空用默认目录」，不留错误条', async () => {
    setup()
    kernel.failView('runtimes.default-workdir', undefined, 'workdir-down')
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'x', runtimeId: 'r1' }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('智能体工作目录')).toHaveAttribute(
        'placeholder',
        '留空用默认目录',
      ),
    )
    // 读不到只是占位文案问题：不把智能体弹窗变成错误页
    expect(screen.queryByText(/workdir-down/)).not.toBeInTheDocument()
    // 留空提交仍按「走项目 / 宿主默认目录」处理
    expect(screen.getByLabelText('智能体工作目录')).toHaveValue('')
  })

  it('默认工作目录读取在卸载后失败：丢弃结果，不报错', async () => {
    setup()
    let queried = false
    let rejectLate!: (error: unknown) => void
    const original = kernel.store.query
    kernel.store.query = <T extends ViewId>(
      view: T,
      params?: ViewParams<T>,
    ): Promise<ViewResult<T>> => {
      if (view === 'runtimes.default-workdir') {
        queried = true
        return new Promise<string>((_resolve, reject) => {
          rejectLate = reject
        }) as Promise<ViewResult<T>>
      }
      return original(view, params)
    }

    const { container, unmount } = render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'x', runtimeId: 'r1' }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    unmount()
    await act(async () => {
      rejectLate(new Error('late-workdir'))
      await Promise.resolve()
    })
    // 查询确实发过，但迟到的失败被 alive 守卫吃掉：没有未处理拒绝，也没有重新渲染
    expect(queried).toBe(true)
    expect(container).toBeEmptyDOMElement()
  })

  it('模型目录查询在切换运行时后迟到的失败：不写进当前弹窗', async () => {
    setup({ runtimeId: 'r2', models: [makeModel()] })
    const original = kernel.store.query
    let first = true
    let rejectLate!: (error: unknown) => void
    kernel.store.query = <T extends ViewId>(
      view: T,
      params?: ViewParams<T>,
    ): Promise<ViewResult<T>> => {
      // 只悬起第一个连接的模型查询：切到新连接后查询要照常返回
      if (view === 'runtimes.models' && first) {
        first = false
        return new Promise<RuntimeModelOption[]>((_resolve, reject) => {
          rejectLate = reject
        }) as Promise<ViewResult<T>>
      }
      return original(view, params)
    }

    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime(), makeRuntime({ id: 'r2', name: 'claude' })]}
        initial={{ name: 'n', runtimeId: 'r1' }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: '智能体模型' })).toBeDisabled()

    // 换连接：runtimeId 变化会重建 effect，旧连接的查询被弃用
    await user.click(screen.getByRole('combobox', { name: '智能体运行时' }))
    await user.click(screen.getByRole('option', { name: 'claude · 可用' }))
    // 新连接的模型清单已返回（下拉可用）说明新 effect 已接管
    await waitFor(() => expect(screen.getByRole('combobox', { name: '智能体模型' })).toBeEnabled())

    await act(async () => {
      rejectLate(new Error('stale-models'))
      await Promise.resolve()
    })

    expect(screen.queryByText(/模型加载失败/)).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '智能体模型' })).toBeEnabled()
  })

  it('模型目录未返回即卸载：不写状态也不报错', async () => {
    setup()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { resolve } = holdModelsQuery()
    const { unmount } = render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'n', runtimeId: 'r1' }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    unmount()
    resolve([makeModel()])
    await new Promise((r) => setTimeout(r, 0))
    // 迟到的模型目录被丢弃：不写状态，也不告警（React 的越界 setState 会走 console.error）
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('环境变量：每行 KEY=VALUE 解析进 env，等号只在第一个位置切开', async () => {
    setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'n', runtimeId: 'r1' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('智能体环境变量'), {
      target: { value: 'HTTP_PROXY=http://127.0.0.1:7890\nGREETING=a=b' },
    })
    await user.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      env: { HTTP_PROXY: 'http://127.0.0.1:7890', GREETING: 'a=b' },
    })
  })

  it('环境变量：非法行就地报错并聚焦，不调父级', async () => {
    setup()
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{ name: 'n', runtimeId: 'r1' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('智能体环境变量'), {
      target: { value: 'OK=1\n没有等号' },
    })
    await user.click(screen.getByRole('button', { name: '添加' }))

    expect(await screen.findByText('第 2 行缺少「键=值」')).toBeInTheDocument()
    expect(screen.getByLabelText('智能体环境变量')).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()

    // 改一行就清掉红字
    fireEvent.change(screen.getByLabelText('智能体环境变量'), {
      target: { value: '1BAD=x' },
    })
    expect(screen.queryByText('第 2 行缺少「键=值」')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText('第 1 行的变量名非法：1BAD')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('编辑：已有环境变量回显成 KEY=VALUE 文本', async () => {
    setup()
    render(
      <AgentDialog
        runtimes={[makeRuntime()]}
        initial={{
          name: 'n',
          runtimeId: 'r1',
          env: { HTTP_PROXY: 'http://127.0.0.1:7890', AGENT_HOME: 'D:/agents/a1' },
        }}
        mode="edit"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('智能体环境变量')).toHaveValue(
      'HTTP_PROXY=http://127.0.0.1:7890\nAGENT_HOME=D:/agents/a1',
    )
  })
})

describe('parseEnvText / formatEnvText', () => {
  it('parseEnvText：忽略空行、保留值里的等号、trim 键', () => {
    expect(parseEnvText('')).toEqual({ env: {}, error: null })
    expect(parseEnvText('\n\n')).toEqual({ env: {}, error: null })
    expect(parseEnvText(' A=1 \n\nB=x=y\n')).toEqual({
      env: { A: '1', B: 'x=y' },
      error: null,
    })
  })

  it('parseEnvText：缺等号、空键、非法键名与超长值都整体报错（不静默丢行）', () => {
    expect(parseEnvText('A=1\nBAD')).toEqual({ env: {}, error: '第 2 行缺少「键=值」' })
    expect(parseEnvText('=1')).toEqual({ env: {}, error: '第 1 行缺少「键=值」' })
    expect(parseEnvText('1BAD=x')).toEqual({ env: {}, error: '第 1 行的变量名非法：1BAD' })
    expect(parseEnvText(`${'K'.repeat(65)}=x`)).toEqual({
      env: {},
      error: `第 1 行的变量名非法：${'K'.repeat(65)}`,
    })
    expect(parseEnvText(`A=${'x'.repeat(1001)}`)).toEqual({
      env: {},
      error: '第 1 行的值超过 1000 字符',
    })
  })

  it('parseEnvText：超过 32 项整体报错', () => {
    const many = Array.from({ length: 33 }, (_, index) => `K${index}=v`).join('\n')
    expect(parseEnvText(many)).toEqual({ env: {}, error: '最多 32 个环境变量' })
  })

  it('formatEnvText：对象回显成一行一条，空对象为空串', () => {
    expect(formatEnvText({})).toBe('')
    expect(formatEnvText({ A: '1', B: 'x=y' })).toBe('A=1\nB=x=y')
  })
})
