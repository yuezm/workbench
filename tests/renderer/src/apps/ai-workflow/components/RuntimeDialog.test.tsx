import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  Runtime,
  RuntimeModelOption,
  RuntimeProbe,
} from '../../../../../../src/shared/ai-workflow-api'
import { RuntimeDialog } from '../../../../../../src/renderer/src/apps/ai-workflow/components/RuntimeDialog'

function setApi(api: unknown): void {
  ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = api
}

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

describe('RuntimeDialog', () => {
  it('新建：默认值渲染，模型与推理强度在创建前不可选', async () => {
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
    expect(screen.getByLabelText('运行时 profile')).toHaveValue('multica')
    expect(screen.getByLabelText('运行时并发上限')).toHaveValue(1)
    expect(screen.getByRole('combobox', { name: '运行时权限模式' })).toHaveTextContent(
      '工作区可写（workspace-write）',
    )
    expect(screen.getByText(/stdio 传输没有审批往返/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '运行时模型' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '运行时推理强度' })).toBeDisabled()
    expect(screen.queryByRole('checkbox', { name: '启用运行时' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('运行时模型手填')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '添加运行时' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toEqual({
      name: 'Codex CLI',
      command: 'codex',
      profile: 'multica',
      permissionMode: 'workspace-write',
      model: null,
      reasoningEffort: null,
      workdir: null,
      maxConcurrent: 1,
      enabled: true,
    })
  })

  it('新建：权限模式、工作目录、并发上限与错误都在弹窗内处理', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('create-fail'))
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: 'x' }} onSubmit={onSubmit} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('combobox', { name: '运行时权限模式' }))
    await user.click(screen.getByRole('option', { name: '只读（read-only）' }))
    await user.type(screen.getByLabelText('运行时工作目录'), ' D:/work ')
    await user.clear(screen.getByLabelText('运行时并发上限'))
    await user.type(screen.getByLabelText('运行时并发上限'), '0')
    await user.click(screen.getByRole('button', { name: '添加运行时' }))

    expect(await screen.findByText('create-fail')).toBeInTheDocument()
    expect(screen.getByLabelText('运行时名称')).toBeInTheDocument()
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      permissionMode: 'read-only',
      workdir: 'D:/work',
      maxConcurrent: 1,
    })
  })

  it('编辑：预填、模型目录加载后切回已知选项、推理强度随模型能力可选', async () => {
    const model = makeModel()
    const models = vi.fn(async () => [model])
    setApi({ runtimes: { models } })
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
    expect(models).toHaveBeenCalledWith('r1')
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

    await user.click(screen.getByRole('button', { name: '保存运行时' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      model: 'deepseek/chat',
      reasoningEffort: 'high',
      maxConcurrent: 3,
      enabled: false,
    })
  })

  it('编辑：模型目录读取中禁用下拉并提示；读取失败仍可手动填写模型 id', async () => {
    let reject!: (e: unknown) => void
    const pending = new Promise<RuntimeModelOption[]>((_res, rej) => {
      reject = rej
    })
    setApi({ runtimes: { models: vi.fn(() => pending) } })
    const runtime = makeRuntime({ model: 'custom/model' })
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuntimeDialog runtime={runtime} onSubmit={onSubmit} onCancel={vi.fn()} />)

    expect(screen.getByText('正在读取模型清单…')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '运行时模型' })).toBeDisabled()

    reject(new Error('models-down'))
    expect(await screen.findByText(/模型清单加载失败：models-down/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '运行时模型' })).toBeEnabled()
    expect(screen.getByLabelText('运行时模型手填')).toHaveValue('custom/model')

    await user.clear(screen.getByLabelText('运行时模型手填'))
    await user.type(screen.getByLabelText('运行时模型手填'), ' manual/model ')
    await user.click(screen.getByRole('button', { name: '保存运行时' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ model: 'manual/model' })
  })

  it('编辑：模型下拉可切默认/手动输入，推理强度随模型清空', async () => {
    setApi({ runtimes: { models: vi.fn(async () => [makeModel()]) } })
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
    expect(screen.getByRole('combobox', { name: '运行时推理强度' })).toHaveTextContent(
      '默认（模型默认）',
    )

    await user.click(screen.getByRole('combobox', { name: '运行时推理强度' }))
    await user.click(screen.getByRole('option', { name: 'high' }))

    await user.click(screen.getByRole('combobox', { name: '运行时模型' }))
    await user.click(screen.getByRole('option', { name: '手动输入模型 id…' }))
    expect(screen.getByLabelText('运行时模型手填')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: '运行时推理强度' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: '保存运行时' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ model: null, reasoningEffort: null })
  })

  it('编辑：切回默认模型并保留/提交已有推理强度，启用开关可修改', async () => {
    setApi({ runtimes: { models: vi.fn(async () => [makeModel()]) } })
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
    await user.click(screen.getByRole('button', { name: '保存运行时' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      model: 'deepseek/chat',
      reasoningEffort: 'low',
      enabled: false,
    })
  })

  it('新建：命令与 profile 可手填并 trim 后提交', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: 'n' }} onSubmit={onSubmit} onCancel={vi.fn()} />)

    await user.clear(screen.getByLabelText('运行时命令'))
    await user.type(screen.getByLabelText('运行时命令'), ' /opt/dsh ')
    await user.clear(screen.getByLabelText('运行时 profile'))
    await user.type(screen.getByLabelText('运行时 profile'), 'dev')
    await user.click(screen.getByRole('button', { name: '添加运行时' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ command: '/opt/dsh', profile: 'dev' })
  })

  it('编辑：已有模型不在目录里时保留手动输入，未知推理强度仍显示', async () => {
    setApi({ runtimes: { models: vi.fn(async () => []) } })
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
    const onSubmit = vi.fn().mockRejectedValue('plain-fail')
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: 'n' }} onSubmit={onSubmit} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '添加运行时' }))
    expect(await screen.findByText('plain-fail')).toBeInTheDocument()
  })

  it('编辑时模型目录未返回即卸载：不写状态也不报错', async () => {
    let resolve!: (list: RuntimeModelOption[]) => void
    setApi({
      runtimes: {
        models: vi.fn(
          () =>
            new Promise<RuntimeModelOption[]>((res) => {
              resolve = res
            }),
        ),
      },
    })
    const { unmount } = render(
      <RuntimeDialog runtime={makeRuntime()} onSubmit={vi.fn()} onCancel={vi.fn()} />,
    )
    unmount()
    resolve([makeModel()])
    await new Promise((r) => setTimeout(r, 0))
  })

  it('取消与关闭按钮都回调 onCancel', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<RuntimeDialog initial={{ name: '' }} onSubmit={vi.fn()} onCancel={onCancel} />)

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('无预填时回落到空名称与默认值', () => {
    render(<RuntimeDialog onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('运行时名称')).toHaveValue('')
    expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh')
    expect(screen.getByLabelText('运行时并发上限')).toHaveValue(1)
  })
})
