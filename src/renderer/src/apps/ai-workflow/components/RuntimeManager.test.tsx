import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiWorkflowApi,
  DetectedRuntime,
  Runtime,
  RuntimeInput,
  RuntimeTestResult,
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

  it('点击「测试」以该运行时 id 调用；测试中禁用并显示「测试中…」，成功后显示连通与耗时', async () => {
    let release: (result: RuntimeTestResult) => void = () => {}
    const test = vi.fn(
      () =>
        new Promise<RuntimeTestResult>((resolve) => {
          release = resolve
        }),
    )
    setApi({
      runtimes: {
        list: vi.fn().mockResolvedValue([base]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        detect: vi.fn(async () => []),
        test,
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '测试运行时 ds' }))

    expect(test).toHaveBeenCalledWith('r1')
    const pending = screen.getByRole('button', { name: '测试运行时 ds' })
    expect(pending).toBeDisabled()
    expect(pending).toHaveTextContent('测试中…')
    // 测试中不影响其它按钮
    expect(screen.getByRole('button', { name: '新建运行时' })).toBeEnabled()

    release({ ok: true, code: 0, elapsedMs: 12, output: 'OK', error: null })

    const badge = await screen.findByText('连通 · 12ms')
    expect(badge.className).toContain('text-emerald-300')
    expect(screen.getByRole('button', { name: '测试运行时 ds' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '测试运行时 ds' })).toHaveTextContent('测试')
  })

  it('测试失败显示行内失败文案，title 携带输出尾部，且不进页面级 error', async () => {
    const test = vi.fn().mockResolvedValue({
      ok: false,
      code: 3,
      elapsedMs: 8,
      output: 'stderr 尾部',
      error: '退出码 3',
    } satisfies RuntimeTestResult)
    setApi({
      runtimes: {
        list: vi.fn().mockResolvedValue([base]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        detect: vi.fn(async () => []),
        test,
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '测试运行时 ds' }))

    const badge = await screen.findByText('失败：退出码 3')
    expect(badge.className).toContain('text-red-300')
    expect(badge).toHaveAttribute('title', 'stderr 尾部')
    // 连通性失败只是该行的行内结果：出现在运行时行内，且没有别处再渲染一份
    expect(badge.closest('li')).not.toBeNull()
    expect(screen.getAllByText('失败：退出码 3')).toHaveLength(1)
  })

  it('失败结果缺少原因时用兜底文案', async () => {
    const test = vi.fn().mockResolvedValue({
      ok: false,
      code: null,
      elapsedMs: 1,
      output: '',
      error: null,
    } satisfies RuntimeTestResult)
    setApi({
      runtimes: {
        list: vi.fn().mockResolvedValue([base]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        detect: vi.fn(async () => []),
        test,
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '测试运行时 ds' }))
    expect(await screen.findByText('失败：未知错误')).toBeInTheDocument()
  })

  it('不同行的测试状态与结果互相独立', async () => {
    const other: Runtime = { ...base, id: 'r2', name: 'claude', command: 'claude' }
    let release: (result: RuntimeTestResult) => void = () => {}
    const test = vi.fn(
      (id: string) =>
        new Promise<RuntimeTestResult>((resolve) => {
          if (id === 'r1') release = resolve
          else resolve({ ok: false, code: 1, elapsedMs: 3, output: 'c2', error: '退出码 1' })
        }),
    )
    setApi({
      runtimes: {
        list: vi.fn().mockResolvedValue([base, other]),
        create: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        detect: vi.fn(async () => []),
        test,
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '测试运行时 ds' }))

    // r1 测试中，r2 仍可点
    expect(screen.getByRole('button', { name: '测试运行时 ds' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '测试运行时 claude' })).toBeEnabled()

    release({ ok: true, code: 0, elapsedMs: 7, output: 'OK', error: null })
    expect(await screen.findByText('连通 · 7ms')).toBeInTheDocument()
    // r2 没有结果
    expect(screen.queryByText('失败：退出码 1')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '测试运行时 claude' }))
    expect(await screen.findByText('失败：退出码 1')).toBeInTheDocument()
    expect(screen.getByText('连通 · 7ms')).toBeInTheDocument()
  })

  it('旧桩没有 test 方法时点击后显示失败而不是崩溃', async () => {
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
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '测试运行时 ds' }))
    expect(await screen.findByText('失败：当前 preload 不支持连通性测试')).toBeInTheDocument()
  })

  it('「重新扫描」失败展示错误', async () => {
    const detect = vi
      .fn<() => Promise<DetectedRuntime[]>>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('rescan-boom'))
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
    expect(await screen.findByText('rescan-boom')).toBeInTheDocument()
  })

  it('结果按 id 记住：删除条目清掉其结论，重新扫描清空全部结论', async () => {
    const other: Runtime = { ...base, id: 'r2', name: 'claude', command: 'claude' }
    let store: Runtime[] = [base, other]
    const list = vi.fn(async () => store)
    const remove = vi.fn(async (id: string) => {
      store = store.filter((x) => x.id !== id)
    })
    const test = vi
      .fn()
      .mockResolvedValue({ ok: true, code: 0, elapsedMs: 5, output: 'OK', error: null })
    setApi({
      runtimes: {
        list,
        create: vi.fn(),
        remove,
        update: vi.fn(),
        detect: vi.fn(async () => []),
        test,
      },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '测试运行时 ds' }))
    await user.click(screen.getByRole('button', { name: '测试运行时 claude' }))
    await waitFor(() => expect(screen.getAllByText('连通 · 5ms')).toHaveLength(2))

    // 删除 ds 后只剩 claude 的结论
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    await waitFor(() => expect(screen.queryByText('ds')).not.toBeInTheDocument())
    expect(screen.getAllByText('连通 · 5ms')).toHaveLength(1)

    // 重新扫描清空结论
    await user.click(screen.getByRole('button', { name: '重新扫描' }))
    await waitFor(() => expect(screen.queryByText('连通 · 5ms')).not.toBeInTheDocument())
  })
})
