import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Runtime,
  RuntimeExecutorChoice,
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

/** 运行时 = 一条连接：只有执行器 / 命令 / profile / 参数模板 / 启停 */
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
    lastProbe: makeProbe(),
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

/** 弹窗只用一个宿主视图：executors（挂载即取） */
function setup(options: { executors?: RuntimeExecutorChoice[] } = {}): void {
  kernel.setView('runtimes.executors', undefined, options.executors ?? EXECUTORS)
}

/** 记录窗口对 store.query 的调用（宿主视图走它） */
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

describe('RuntimeDialog', () => {
  it('新建：只渲染连接字段，执行配置字段一个都不出现', async () => {
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
    expect(screen.getByText(/占位符 \{model\}/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: '启用运行时' })).not.toBeInTheDocument()

    // 执行配置迁到智能体：弹窗里不再有这些控件
    expect(screen.queryByLabelText('运行时并发上限')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '运行时权限模式' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('运行时工作目录')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '运行时模型' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '运行时推理强度' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('运行时模型手填')).not.toBeInTheDocument()
    // 但要说清「这些去哪配」：弹窗里给出指向智能体的说明
    expect(screen.getByText(/都在「智能体」里配/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({
      name: 'Codex CLI',
      executorKey: 'dsh',
      command: 'codex',
      profile: 'multica',
      argsTemplate: '',
      enabled: true,
    })
  })

  it('新建：名称为空就地报必填并聚焦，不调父级', async () => {
    setup()
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<RuntimeDialog onSubmit={onSubmit} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText('名称必填')).toBeInTheDocument()
    expect(screen.getByLabelText('运行时名称')).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('新建：命令为空就地报必填并聚焦，不调父级（命令执行器没有默认可解析的命令）', async () => {
    setup()
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: 'pnpm' }} onSubmit={onSubmit} onCancel={vi.fn()} />)

    // 首次进入按 registry 首项预填了 dsh：清空后就是「命令执行器」的默认形态
    await waitFor(() => expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh'))
    await user.clear(screen.getByLabelText('运行时命令'))
    await user.click(screen.getByRole('button', { name: '添加' }))

    expect(await screen.findByText('命令必填：填命令名或绝对路径（如 pnpm）')).toBeInTheDocument()
    expect(screen.getByLabelText('运行时命令')).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()

    // 填上就撤掉红字，再交出去
    await user.type(screen.getByLabelText('运行时命令'), 'pnpm')
    expect(screen.queryByText(/命令必填/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'pnpm', command: 'pnpm' })
  })

  it('新建：名称手填后 trim 提交，并清掉之前的必填错误', async () => {
    setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuntimeDialog onSubmit={onSubmit} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText('名称必填')).toBeInTheDocument()

    await user.type(screen.getByLabelText('运行时名称'), '  Codex  ')
    // 一改就不再挂旧红字
    expect(screen.queryByText('名称必填')).not.toBeInTheDocument()

    await waitFor(() => expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh'))
    await user.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'Codex' })
  })

  it('编辑：预填连接字段与启用开关，提交只带连接字段', async () => {
    setup()
    const runtime = makeRuntime({ enabled: false })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuntimeDialog runtime={runtime} onSubmit={onSubmit} onCancel={vi.fn()} />)

    expect(screen.getByRole('dialog')).toHaveTextContent('编辑运行时')
    expect(screen.getByLabelText('运行时名称')).toHaveValue('ds')
    expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh')
    expect(screen.getByRole('checkbox', { name: '启用运行时' })).not.toBeChecked()

    await user.click(screen.getByRole('checkbox', { name: '启用运行时' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({
      name: 'ds',
      executorKey: 'dsh',
      command: 'dsh',
      profile: 'multica',
      argsTemplate: '',
      enabled: true,
    })
  })

  it('编辑：不再读模型目录与默认工作目录（执行配置已迁到智能体）', async () => {
    setup()
    const queries = recordQueries()
    render(<RuntimeDialog runtime={makeRuntime()} onSubmit={vi.fn()} onCancel={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '运行时执行器' })).toHaveTextContent(
        'DeepSeek Harness',
      ),
    )
    expect(queries.map((call) => call.view)).toEqual(['runtimes.executors'])
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

  it('提交失败为非 Error 时也字符串化展示，并可在弹窗内关掉继续改', async () => {
    setup()
    const onSubmit = vi.fn().mockRejectedValue('plain-fail')
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: 'n' }} onSubmit={onSubmit} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText('plain-fail')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '关闭错误提示' }))
    expect(screen.queryByText('plain-fail')).not.toBeInTheDocument()
    expect(screen.getByLabelText('运行时名称')).toHaveValue('n')
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

  it('执行器清单查询在卸载后迟到成功：丢弃结果，不写进已关闭的弹窗', async () => {
    setup()
    const original = kernel.store.query
    let first = true
    let resolveLate!: (list: RuntimeExecutorChoice[]) => void
    kernel.store.query = <T extends ViewId>(
      view: T,
      params?: ViewParams<T>,
    ): Promise<ViewResult<T>> => {
      if (view === 'runtimes.executors' && first) {
        first = false
        return new Promise<RuntimeExecutorChoice[]>((resolve) => {
          resolveLate = resolve
        }) as Promise<ViewResult<T>>
      }
      return original(view, params)
    }

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = render(
      <RuntimeDialog initial={{ name: 'n' }} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    unmount()

    // 卸载后迟到的成功：effect 已 cleanup，结果必须被丢弃（不 setState、不告警）
    resolveLate([{ key: 'dsh', label: 'DSH', command: 'dsh', profile: 'multica' }])
    await Promise.resolve()
    await Promise.resolve()

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
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

  it('Esc 关闭弹窗：走 dismiss 收口到 onCancel，不提交', async () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: 'ds' }} onSubmit={onSubmit} onCancel={onCancel} />)

    await user.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
