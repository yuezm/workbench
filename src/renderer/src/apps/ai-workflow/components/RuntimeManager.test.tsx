import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiWorkflowApi, Runtime, RuntimeInput } from '../../../../../shared/ai-workflow-api'
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
    await user.type(screen.getByLabelText('运行时名称'), 'claude')
    await user.clear(screen.getByLabelText('运行时命令'))
    await user.type(screen.getByLabelText('运行时命令'), 'claude-cli')
    await user.type(screen.getByLabelText('运行时参数'), 'a b')
    await user.selectOptions(screen.getByLabelText('prompt 传递方式'), 'stdin')
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

  it('新建失败与删除失败均展示错误', async () => {
    const list = vi.fn().mockResolvedValue([base])
    const create = vi.fn().mockRejectedValue(new Error('create-fail'))
    const remove = vi.fn().mockRejectedValue(new Error('remove-fail'))
    setApi({
      runtimes: { list, create, remove, update: vi.fn() },
    } as unknown as Partial<AiWorkflowApi>)

    render(<RuntimeManager />)
    expect(await screen.findByText('ds')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('运行时名称'), 'x')
    await user.click(screen.getByRole('button', { name: '添加运行时' }))
    expect(await screen.findByText('create-fail')).toBeInTheDocument()

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
    await user.type(screen.getByLabelText('运行时名称'), 'x')
    await user.click(screen.getByRole('button', { name: '添加运行时' }))
    expect(await screen.findByText('reload-boom')).toBeInTheDocument()
  })
})
