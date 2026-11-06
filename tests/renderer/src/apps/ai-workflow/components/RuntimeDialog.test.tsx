import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Runtime,
  RuntimeExecutorChoice,
  RuntimeModelOption,
  RuntimeProbe,
} from '../../../../../../src/protocol/entities'
import type { ViewId, ViewParams, ViewResult } from '../../../../../../src/protocol/views'
import { RuntimeDialog } from '../../../../../../src/renderer/src/apps/ai-workflow/components/RuntimeDialog'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

/** 执行器清单：顺序即注册表顺序（dsh 首项），command 的 command 默认值可体现「切执行器预填」 */
const EXECUTORS: RuntimeExecutorChoice[] = [
  { key: 'dsh', label: 'DeepSeek Harness', command: 'dsh', profile: 'multica' },
  { key: 'command', label: '通用命令', command: 'my-cli', profile: '' },
]

function makeProbe(over: Partial<RuntimeProbe> = {}): RuntimeProbe {
  return {
    state: 'ready',
    path: 'C:/tools/dsh.exe',
    cliVersion: '1.2.3',
    protocolVersion: 1,
    pluginVersion: null,
    error: null,
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
    lastProbe: makeProbe(),
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

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

afterEach(() => {
  stopFakeKernel()
})

/** 弹窗用两个宿主视图：executors（挂载即取）与 models（仅编辑时） */
function setup(
  options: { executors?: RuntimeExecutorChoice[]; models?: RuntimeModelOption[] } = {},
): void {
  kernel.setView('runtimes.executors', undefined, options.executors ?? EXECUTORS)
  if (options.models !== undefined) {
    kernel.setView('runtimes.models', { runtimeId: 'r1' }, options.models)
  }
}

/** 记录窗口对 store.query 的调用（不经 useKernelView，宿主视图走它） */
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

/** 让 `runtimes.models` 的查询悬起（验证读取中的禁用态）；返回手动 reject 的句柄 */
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

describe('RuntimeDialog', () => {
  it('新建：默认值渲染，模型与推理强度在创建前不可选', async () => {
    setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <RuntimeDialog
        initial={{ name: 'Codex CLI', command: 'codex' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveTextContent('新建运行时')
    expect(screen.getByLabelText('运行时名称')).toHaveValue('Codex CLI')
    expect(screen.getByLabelText('运行时命令')).toHaveValue('codex')
    await waitFor(() => expect(screen.getByLabelText('运行时 profile')).toHaveValue('multica'))
    expect(screen.getByRole('combobox', { name: '运行时执行器' })).toHaveTextContent(
      'DeepSeek Harness',
    )
    expect(screen.getByLabelText('运行时并发上限')).toHaveValue(1)
    expect(screen.getByRole('combobox', { name: '运行时权限模式' })).toHaveTextContent('可写')
    expect(screen.getByText(/越界操作直接失败/)).toBeInTheDocument()
    expect(screen.getByText(/占位符 \{model\}/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '运行时模型' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '运行时推理强度' })).toBeDisabled()
    expect(screen.queryByRole('checkbox', { name: '启用运行时' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('运行时模型手填')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({
      name: 'Codex CLI',
      executorKey: 'dsh',
      command: 'codex',
      profile: 'multica',
      argsTemplate: '',
      permissionMode: 'workspace-write',
      model: null,
      reasoningEffort: null,
      workdir: null,
      maxConcurrent: 1,
      enabled: true,
    })
  })

  it('新建：权限模式、工作目录、并发上限与错误都在弹窗内处理', async () => {
    setup()
    const onSubmit = vi.fn().mockRejectedValue(new Error('create-fail'))
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: 'x' }} onSubmit={onSubmit} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('combobox', { name: '运行时权限模式' }))
    await user.click(screen.getByRole('option', { name: '只读' }))
    await user.type(screen.getByLabelText('运行时工作目录'), ' D:/work ')
    await user.clear(screen.getByLabelText('运行时并发上限'))
    await user.type(screen.getByLabelText('运行时并发上限'), '0')
    await user.click(screen.getByRole('button', { name: '添加' }))

    expect(await screen.findByText('create-fail')).toBeInTheDocument()
    expect(screen.getByLabelText('运行时名称')).toBeInTheDocument()
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      permissionMode: 'read-only',
      workdir: 'D:/work',
      maxConcurrent: 1,
    })
  })

  it('编辑：预填、按运行时 id 读模型目录、推理强度随模型能力可选', async () => {
    const model = makeModel()
    setup({ models: [model] })
    const queries = recordQueries()
    const runtime = makeRuntime({
      model: model.id,
      reasoningEffort: 'high',
      maxConcurrent: 3,
      enabled: false,
    })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuntimeDialog runtime={runtime} onSubmit={onSubmit} onCancel={vi.fn()} />)

    expect(screen.getByRole('dialog')).toHaveTextContent('编辑运行时')
    expect(queries).toContainEqual({ view: 'runtimes.models', params: { runtimeId: 'r1' } })
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '运行时模型' })).toHaveTextContent(
        'DeepSeek Chat',
      ),
    )
    expect(screen.queryByLabelText('运行时模型手填')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '运行时推理强度' })).toBeEnabled(),
    )
    expect(screen.getByRole('combobox', { name: '运行时推理强度' })).toHaveTextContent('high')
    expect(screen.getByRole('checkbox', { name: '启用运行时' })).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      model: 'deepseek/chat',
      reasoningEffort: 'high',
      maxConcurrent: 3,
      enabled: false,
    })
  })

  it('编辑：模型目录读取中禁用下拉并提示；读取失败仍可手动填写模型 id', async () => {
    setup()
    const { reject } = holdModelsQuery()
    const runtime = makeRuntime({ model: 'custom/model' })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuntimeDialog runtime={runtime} onSubmit={onSubmit} onCancel={vi.fn()} />)

    expect(screen.getByText('读取模型中…')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '运行时模型' })).toBeDisabled()

    reject(new Error('models-down'))
    expect(await screen.findByText(/模型加载失败：models-down/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '运行时模型' })).toBeEnabled()
    expect(screen.getByLabelText('运行时模型手填')).toHaveValue('custom/model')

    await user.clear(screen.getByLabelText('运行时模型手填'))
    await user.type(screen.getByLabelText('运行时模型手填'), ' manual/model ')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ model: 'manual/model' })
  })

  it('编辑：模型下拉可切默认/手动输入，推理强度随模型清空', async () => {
    setup({ models: [makeModel()] })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <RuntimeDialog
        runtime={makeRuntime({ model: null, reasoningEffort: 'high' })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    // 未知目录时已有的推理强度仍显示出来
    expect(await screen.findByRole('combobox', { name: '运行时推理强度' })).toHaveTextContent(
      'high',
    )

    await user.click(screen.getByRole('combobox', { name: '运行时模型' }))
    await user.click(screen.getByRole('option', { name: 'DeepSeek Chat' }))
    expect(screen.getByRole('combobox', { name: '运行时模型' })).toHaveTextContent('DeepSeek Chat')
    expect(screen.getByRole('combobox', { name: '运行时推理强度' })).toHaveTextContent('默认')

    await user.click(screen.getByRole('combobox', { name: '运行时推理强度' }))
    await user.click(screen.getByRole('option', { name: 'high' }))

    await user.click(screen.getByRole('combobox', { name: '运行时模型' }))
    await user.click(screen.getByRole('option', { name: '手动输入…' }))
    expect(screen.getByLabelText('运行时模型手填')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: '运行时推理强度' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ model: null, reasoningEffort: null })
  })

  it('编辑：切回默认模型并保留/提交已有推理强度，启用开关可修改', async () => {
    setup({ models: [makeModel()] })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <RuntimeDialog
        runtime={makeRuntime({ model: 'deepseek/chat', reasoningEffort: 'low', enabled: true })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('checkbox', { name: '启用运行时' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      model: 'deepseek/chat',
      reasoningEffort: 'low',
      enabled: false,
    })
  })

  it('新建：命令与 profile 可手填并 trim 后提交', async () => {
    setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: 'n' }} onSubmit={onSubmit} onCancel={vi.fn()} />)
    // 等首项执行器的 manifest 默认值预填完成，再验证用户手填不被覆盖
    await waitFor(() => expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh'))

    await user.clear(screen.getByLabelText('运行时命令'))
    await user.type(screen.getByLabelText('运行时命令'), ' /opt/dsh ')
    await user.clear(screen.getByLabelText('运行时 profile'))
    await user.type(screen.getByLabelText('运行时 profile'), 'dev')
    await user.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ command: '/opt/dsh', profile: 'dev' })
  })

  it('编辑：已有模型不在目录里时保留手动输入，未知推理强度仍显示', async () => {
    setup({ models: [] })
    render(
      <RuntimeDialog
        runtime={makeRuntime({ model: 'custom/model', reasoningEffort: 'max' })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(await screen.findByLabelText('运行时模型手填')).toHaveValue('custom/model')
    expect(screen.getByRole('combobox', { name: '运行时推理强度' })).toHaveTextContent('max')
    expect(screen.getByRole('combobox', { name: '运行时推理强度' })).toBeDisabled()
  })

  it('提交失败为非 Error 时也字符串化展示', async () => {
    setup()
    const onSubmit = vi.fn().mockRejectedValue('plain-fail')
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: 'n' }} onSubmit={onSubmit} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText('plain-fail')).toBeInTheDocument()
  })

  it('编辑时模型目录未返回即卸载：不写状态也不报错', async () => {
    setup()
    const { resolve } = holdModelsQuery()
    const { unmount } = render(
      <RuntimeDialog runtime={makeRuntime()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    unmount()
    resolve([makeModel()])
    await new Promise((r) => setTimeout(r, 0))
  })

  it('取消与关闭按钮都回调 onCancel', async () => {
    setup()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: '' }} onSubmit={vi.fn()} onCancel={onCancel} />)

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('无预填时回落到空名称与首项执行器默认值', async () => {
    setup()
    render(<RuntimeDialog onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('运行时名称')).toHaveValue('')
    await waitFor(() => expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh'))
    await waitFor(() => expect(screen.getByLabelText('运行时 profile')).toHaveValue('multica'))
    expect(screen.getByRole('combobox', { name: '运行时执行器' })).toHaveTextContent(
      'DeepSeek Harness',
    )
    expect(screen.getByLabelText('运行时参数模板')).toHaveValue('')
    expect(screen.getByLabelText('运行时并发上限')).toHaveValue(1)
  })

  it('新建：切执行器按 manifest 预填 command/profile，手改后提交用户值', async () => {
    setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: 'n' }} onSubmit={onSubmit} onCancel={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh'))

    await user.click(screen.getByRole('combobox', { name: '运行时执行器' }))
    await user.click(screen.getByRole('option', { name: '通用命令' }))
    expect(screen.getByLabelText('运行时命令')).toHaveValue('my-cli')
    expect(screen.getByLabelText('运行时 profile')).toHaveValue('')

    await user.clear(screen.getByLabelText('运行时命令'))
    await user.type(screen.getByLabelText('运行时命令'), ' /opt/my-cli ')
    // 参数模板含 [] 与 {}：userEvent.type 会把它们当键位描述，改用 change 直接赋值
    fireEvent.change(screen.getByLabelText('运行时参数模板'), {
      target: { value: '["--print","{prompt}"]' },
    })
    await user.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      executorKey: 'command',
      command: '/opt/my-cli',
      profile: '',
      argsTemplate: '["--print","{prompt}"]',
    })
  })

  it('编辑：执行器与参数模板回填，保存提交携带 executorKey 与 argsTemplate', async () => {
    setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <RuntimeDialog
        runtime={makeRuntime({
          executorKey: 'command',
          command: 'my-cli',
          profile: '',
          argsTemplate: '["--print","{prompt}"]',
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '运行时执行器' })).toHaveTextContent('通用命令'),
    )
    expect(screen.getByLabelText('运行时参数模板')).toHaveValue('["--print","{prompt}"]')
    expect(screen.getByLabelText('运行时命令')).toHaveValue('my-cli')

    fireEvent.change(screen.getByLabelText('运行时参数模板'), {
      target: { value: ' ["{context}"] ' },
    })
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      executorKey: 'command',
      argsTemplate: '["{context}"]',
    })
  })

  it('执行器清单加载失败：提示原因，仍可手填并提交（不带空串 key）', async () => {
    setup()
    kernel.failView('runtimes.executors', undefined, 'exec-down')
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: 'n' }} onSubmit={onSubmit} onCancel={vi.fn()} />)

    expect(await screen.findByText(/执行器加载失败：exec-down/)).toBeInTheDocument()
    const executor = screen.getByRole('combobox', { name: '运行时执行器' })
    expect(executor).toBeDisabled()
    expect(executor).toHaveTextContent('无可用执行器')

    await user.type(screen.getByLabelText('运行时命令'), 'dsh')
    await user.type(screen.getByLabelText('运行时 profile'), 'multica')
    await user.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    const input = onSubmit.mock.calls[0][0] as { executorKey?: string }
    expect(input.executorKey).toBeUndefined()
    expect(input).toMatchObject({ command: 'dsh', profile: 'multica', argsTemplate: '' })
  })

  it('执行器清单为空：下拉禁用并提示无可用执行器', async () => {
    setup({ executors: [] })
    render(<RuntimeDialog initial={{ name: 'n' }} onSubmit={vi.fn()} onCancel={vi.fn()} />)

    expect(await screen.findByText('无可用执行器')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '运行时执行器' })).toBeDisabled()
    expect(screen.getByLabelText('运行时命令')).toHaveValue('')
  })

  it('编辑：切换执行器不覆盖已有 command/profile（只在新建时按 manifest 预填）', async () => {
    setup()
    const user = userEvent.setup()
    render(
      <RuntimeDialog
        runtime={makeRuntime({ executorKey: 'dsh', command: 'dsh', profile: 'multica' })}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    )

    await waitFor(() => expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh'))
    await user.click(screen.getByRole('combobox', { name: '运行时执行器' }))
    await user.click(screen.getByRole('option', { name: '通用命令' }))

    // 编辑态不预填：用户已有配置优先
    expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh')
    expect(screen.getByLabelText('运行时 profile')).toHaveValue('multica')
  })

  it('执行器清单查询无数据：按空清单处理并禁用下拉', async () => {
    // 不预置 runtimes.executors：查询返回 undefined，弹窗按空清单处理
    render(<RuntimeDialog initial={{ name: 'n' }} onSubmit={vi.fn()} onCancel={vi.fn()} />)

    expect(await screen.findByText('无可用执行器')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '运行时执行器' })).toBeDisabled()
    expect(screen.getByLabelText('运行时命令')).toHaveValue('')
  })

  it('新建：显式预填的 profile 不被执行器 manifest 默认值覆盖', async () => {
    setup()
    render(
      <RuntimeDialog
        initial={{ name: 'n', profile: 'from-detect' }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    // command 仍按 manifest 首项预填，profile 保留调用方带入的值
    await waitFor(() => expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh'))
    expect(screen.getByLabelText('运行时 profile')).toHaveValue('from-detect')
  })

  it('编辑：模型目录查询无数据时保留手动输入的模型 id', async () => {
    setup()
    render(
      <RuntimeDialog
        runtime={makeRuntime({ model: 'custom/model' })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(await screen.findByLabelText('运行时模型手填')).toHaveValue('custom/model')
    await waitFor(() => expect(screen.getByRole('combobox', { name: '运行时模型' })).toBeEnabled())
  })

  it('执行器清单查询在切换编辑态后迟到的失败：不写进当前弹窗', async () => {
    setup()
    const original = kernel.store.query
    let first = true
    let rejectLate!: (error: unknown) => void
    kernel.store.query = <T extends ViewId>(
      view: T,
      params?: ViewParams<T>,
    ): Promise<ViewResult<T>> => {
      if (view === 'runtimes.executors' && first) {
        first = false
        return new Promise<RuntimeExecutorChoice[]>((_resolve, reject) => {
          rejectLate = reject
        }) as Promise<ViewResult<T>>
      }
      return original(view, params)
    }

    const { rerender } = render(
      <RuntimeDialog initial={{ name: 'n' }} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    // editing 变化会重建 effect：上一轮查询被弃用，迟到的失败不得写进仍在显示的弹窗
    rerender(<RuntimeDialog runtime={makeRuntime()} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    // 第二轮执行器清单已返回（下拉可用）说明新 effect 已接管
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '运行时执行器' })).toBeEnabled(),
    )

    await act(async () => {
      rejectLate(new Error('stale-executors'))
      await Promise.resolve()
    })

    expect(screen.queryByText(/执行器加载失败/)).not.toBeInTheDocument()
  })

  it('模型目录查询在切换运行时后迟到的失败：不写进当前弹窗', async () => {
    setup()
    const original = kernel.store.query
    let first = true
    let rejectLate!: (error: unknown) => void
    kernel.store.query = <T extends ViewId>(
      view: T,
      params?: ViewParams<T>,
    ): Promise<ViewResult<T>> => {
      if (view === 'runtimes.models' && first) {
        first = false
        return new Promise<RuntimeModelOption[]>((_resolve, reject) => {
          rejectLate = reject
        }) as Promise<ViewResult<T>>
      }
      return original(view, params)
    }

    const { rerender } = render(
      <RuntimeDialog runtime={makeRuntime()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    // runtime 变化会重建 effect：旧运行时的模型查询被弃用，迟到的失败不写入
    rerender(
      <RuntimeDialog runtime={makeRuntime({ id: 'r2' })} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    // 新运行时的模型清单已返回（下拉可用）说明新 effect 已接管
    await waitFor(() => expect(screen.getByRole('combobox', { name: '运行时模型' })).toBeEnabled())

    await act(async () => {
      rejectLate(new Error('stale-models'))
      await Promise.resolve()
    })

    expect(screen.queryByText(/模型加载失败/)).not.toBeInTheDocument()
  })
})
