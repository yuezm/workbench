import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiWorkflowApi,
  DetectedRuntime,
  Runtime,
  RuntimeInput,
} from '../../../../../shared/ai-workflow-api'
import { RuntimeManager } from './RuntimeManager'

function setApi(api: unknown): void {
  ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = api
}

const base: Runtime = {
  id: 'r1',
  name: 'ds',
  kind: 'deepseek-harness',
  command: 'dsh',
  args: ['-p'],
  promptMode: 'arg',
  workdir: null,
  createdAt: 't',
}

beforeEach(() => vi.clearAllMocks())

describe('RuntimeManager', () => {
  it('默认只显示清单，点击「新建运行时」才弹出表单', async () => {
    const user = userEvent.setup()
    setApi({
      runtimes: {
        list: vi.fn().mockResolvedValue([base]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    expect(await screen.findByText('ds')).toBeInTheDocument()
    expect(screen.queryByLabelText('运行时名称')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新建运行时' }))
    expect(screen.getByLabelText('运行时名称')).toBeInTheDocument()

    // 取消后表单关闭
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('运行时名称')).not.toBeInTheDocument()
  })

  it('加载列表、新建（含参数/prompt 模式/工作目录）并删除', async () => {
    let store: Runtime[] = [base]
    const list = vi.fn(async () => store)
    const create = vi.fn(async (input: RuntimeInput) => {
      const n: Runtime = {
        ...base,
        id: 'r2',
        name: input.name,
        command: input.command,
        args: input.args ?? [],
        promptMode: input.promptMode ?? 'arg',
        workdir: input.workdir ?? null,
      }
      store = [...store, n]
      return n
    })
    const remove = vi.fn(async (id: string) => {
      store = store.filter((x) => x.id !== id)
    })
    setApi({
      runtimes: { list, create, remove, update: vi.fn() },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    expect(await screen.findByText('ds')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '新建运行时' }))
    await user.type(screen.getByLabelText('运行时名称'), 'claude')
    await user.clear(screen.getByLabelText('运行时命令'))
    await user.type(screen.getByLabelText('运行时命令'), 'claude-cli')
    await user.type(screen.getByLabelText('运行时参数'), 'a b')
    await user.click(screen.getByRole('combobox', { name: 'prompt 传递方式' }))
    await user.click(screen.getByRole('option', { name: '标准输入' }))
    await user.type(screen.getByLabelText('运行时工作目录'), 'D:/work')
    await user.click(screen.getByRole('button', { name: '添加运行时' }))

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0]).toMatchObject({
      name: 'claude',
      command: 'claude-cli',
      args: ['a', 'b'],
      promptMode: 'stdin',
      workdir: 'D:/work',
    })
    expect(await screen.findByText('claude')).toBeInTheDocument()
    // 保存成功后弹窗关闭
    expect(screen.queryByLabelText('运行时名称')).not.toBeInTheDocument()

    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await waitFor(() => expect(remove).toHaveBeenCalledWith('r1'))
  })

  it('加载失败展示错误', async () => {
    const list = vi.fn().mockRejectedValue('boom')
    setApi({
      runtimes: { list, create: vi.fn(), remove: vi.fn(), update: vi.fn() },
    } as unknown as Partial<AiWorkflowApi>)
    render(<RuntimeManager />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('新建失败在弹窗内展示错误并保持打开；删除失败展示错误', async () => {
    const list = vi.fn().mockResolvedValue([base])
    const create = vi.fn().mockRejectedValue(new Error('create-fail'))
    const remove = vi.fn().mockRejectedValue(new Error('remove-fail'))
    setApi({
      runtimes: { list, create, remove, update: vi.fn() },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    expect(await screen.findByText('ds')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '新建运行时' }))
    await user.type(screen.getByLabelText('运行时名称'), 'x')
    await user.click(screen.getByRole('button', { name: '添加运行时' }))
    expect(await screen.findByText('create-fail')).toBeInTheDocument()
    expect(screen.getByLabelText('运行时名称')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '取消' }))
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    expect(await screen.findByText('remove-fail')).toBeInTheDocument()
  })

  it('加载未完成即卸载不报错', async () => {
    const slow = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve([]), 10)))
    setApi({
      runtimes: { list: slow, create: vi.fn(), remove: vi.fn(), update: vi.fn() },
    } as unknown as Partial<AiWorkflowApi>)
    const { unmount } = render(<RuntimeManager />)
    unmount()
    await new Promise((r) => setTimeout(r, 20))
  })

  it('刷新列表失败展示错误', async () => {
    const list = vi.fn().mockResolvedValueOnce([base]).mockRejectedValue(new Error('reload-boom'))
    setApi({
      runtimes: {
        list,
        create: vi.fn().mockResolvedValue({ ...base, id: 'r2' }),
        remove: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    expect(await screen.findByText('ds')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '新建运行时' }))
    await user.type(screen.getByLabelText('运行时名称'), 'x')
    await user.click(screen.getByRole('button', { name: '添加运行时' }))
    expect(await screen.findByText('reload-boom')).toBeInTheDocument()
  })

  it('自动识别本机已安装的运行时并可一键预填表单', async () => {
    const detected: DetectedRuntime[] = [
      { command: 'codex', label: 'Codex CLI', path: 'C:/tools/codex.cmd' },
    ]
    const detect = vi.fn(async () => detected)
    setApi({
      runtimes: {
        list: vi.fn().mockResolvedValue([base]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        detect,
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    expect(await screen.findByText('Codex CLI')).toBeInTheDocument()
    expect(screen.getByText('C:/tools/codex.cmd')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '使用' }))
    expect(screen.getByLabelText('运行时名称')).toHaveValue('Codex CLI')
    expect(screen.getByLabelText('运行时命令')).toHaveValue('codex')
  })

  it('名称与既有运行时冲突时预填带命令后缀', async () => {
    const detected: DetectedRuntime[] = [
      { command: 'codex', label: 'Codex CLI', path: 'C:/tools/codex.cmd' },
    ]
    setApi({
      runtimes: {
        list: vi.fn().mockResolvedValue([{ ...base, name: 'Codex CLI', command: 'codex-old' }]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        detect: vi.fn(async () => detected),
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '使用' }))
    expect(screen.getByLabelText('运行时名称')).toHaveValue('Codex CLI (codex)')
  })

  it('已添加过的命令显示「已添加」且不再提供预填按钮', async () => {
    const detected: DetectedRuntime[] = [
      { command: 'dsh', label: 'DeepSeek Harness', path: 'C:/tools/dsh.cmd' },
    ]
    setApi({
      runtimes: {
        list: vi.fn().mockResolvedValue([base]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        detect: vi.fn(async () => detected),
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    expect(await screen.findByText('已添加')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '使用' })).not.toBeInTheDocument()
  })

  it('未检测到已安装运行时时给出提示', async () => {
    setApi({
      runtimes: {
        list: vi.fn().mockResolvedValue([base]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        detect: vi.fn(async () => []),
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    expect(await screen.findByText(/未检测到已安装的 CLI/)).toBeInTheDocument()
  })

  it('检测失败展示错误', async () => {
    setApi({
      runtimes: {
        list: vi.fn().mockResolvedValue([base]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        detect: vi.fn().mockRejectedValue(new Error('detect-boom')),
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    expect(await screen.findByText('detect-boom')).toBeInTheDocument()
  })

  it('「重新扫描」重新拉取检测结果', async () => {
    const detect = vi
      .fn<() => Promise<DetectedRuntime[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ command: 'codex', label: 'Codex CLI', path: 'C:/tools/codex.cmd' }])
    setApi({
      runtimes: {
        list: vi.fn().mockResolvedValue([base]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        detect,
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '重新扫描' }))
    expect(await screen.findByText('Codex CLI')).toBeInTheDocument()
    expect(detect).toHaveBeenCalledTimes(2)
  })
})
