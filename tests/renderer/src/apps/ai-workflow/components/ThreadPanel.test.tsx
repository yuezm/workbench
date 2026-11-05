import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Command } from '../../../../../../src/protocol/commands'
import type { Task } from '../../../../../../src/protocol/entities'
import type { CommandDispatchResult } from '../../../../../../src/protocol/ipc'
import type { ThreadRow } from '../../../../../../src/protocol/thread'
import type { ThreadDetail } from '../../../../../../src/protocol/views'
import { ThreadPanel } from '../../../../../../src/renderer/src/apps/ai-workflow/components/ThreadPanel'
import { installFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

const parentTask: Task = {
  id: 'p1',
  title: '父任务',
  description: '',
  workflowId: 'w1',
  currentStageId: 's0',
  status: 'active',
  origin: 'rule',
  ruleId: 'r1',
  externalRef: 'issue-1',
  labels: [],
  threadId: 'th1',
  parentTaskId: null,
  createdAt: 't',
  updatedAt: 't',
}

const childTask: Task = {
  ...parentTask,
  id: 'c1',
  title: '子任务任务',
  parentTaskId: 'p1',
  status: 'active',
}

const doneTask: Task = {
  ...parentTask,
  id: 'p2',
  title: '已完成的根任务',
  parentTaskId: null,
  status: 'completed',
}

const thread: ThreadRow = {
  id: 'th1',
  source: 'github',
  externalRef: 'issue-1',
  title: 'Issue 1',
  status: 'open',
  taskIds: ['p1', 'c1', 'p2'],
  rootTaskIds: ['p1', 'p2'],
  concurrency: 1,
  notesVersion: 1,
  notes: [{ id: 'n1', author: 'agent', text: '上一轮笔记', at: '2026-11-05T10:00:00.000Z' }],
  events: [],
  lastActivityAt: 't',
  createdAt: 't',
}

/** 未绑定的隐式线程：绑定表单可用 */
const implicitThread: ThreadRow = {
  ...thread,
  source: 'manual',
  externalRef: null,
  title: '隐式线程',
  notes: [],
  notesVersion: 0,
}

function detailOf(row: ThreadRow, tasks: Task[] = [parentTask, childTask, doneTask]): ThreadDetail {
  return { thread: row, tasks, sessions: {} }
}

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

function setup(detail: ThreadDetail | null, onClose = vi.fn()): ReturnType<typeof vi.fn> {
  kernel.setView('thread.byId', { threadId: 'th1' }, detail)
  render(<ThreadPanel threadId="th1" onClose={onClose} />)
  return onClose
}

function dispatchWith(
  handler: <C extends Command>(
    command: C,
  ) => CommandDispatchResult<C> | Promise<CommandDispatchResult<C>>,
): void {
  kernel.onDispatch(handler)
}

describe('ThreadPanel', () => {
  it('渲染线程元信息、任务树（根任务 + 子任务缩进与状态）与笔记', async () => {
    setup(detailOf(thread))

    expect(await screen.findByRole('heading', { name: '线程 · Issue 1' })).toBeInTheDocument()
    const meta = screen.getByText('来源').closest('dl') as HTMLElement
    expect(meta).toHaveTextContent('github')
    expect(meta).toHaveTextContent('issue-1')
    expect(meta).toHaveTextContent('进行中')
    expect(meta).toHaveTextContent('并发')

    const tree = screen.getByRole('region', { name: '任务树' })
    expect(tree).toHaveTextContent('父任务')
    expect(tree).toHaveTextContent('子任务任务')
    expect(tree).toHaveTextContent('已完成的根任务')
    expect(tree).toHaveTextContent('已完成')
    // 子任务缩进一层，并带「子任务」标记
    const childRow = screen.getByText('子任务任务').closest('div') as HTMLDivElement
    expect(childRow).toHaveStyle({ paddingLeft: '14px' })

    const notes = screen.getByRole('region', { name: '笔记' })
    expect(notes).toHaveTextContent('上一轮笔记')
    expect(notes).toHaveTextContent('智能体')
    expect(notes).toHaveTextContent('2026-11-05T10:00:00.000Z')
  })

  it('线程内没有任务时展示空态', async () => {
    setup(detailOf({ ...thread, taskIds: [], rootTaskIds: [] }, []))
    expect(await screen.findByText('线程内暂无任务')).toBeInTheDocument()
  })

  it('父任务不在任务列表里的悬挂子任务作为根展示', async () => {
    setup(detailOf({ ...thread, taskIds: ['c1'], rootTaskIds: [] }, [childTask]))
    const title = await screen.findByText('子任务任务')
    const row = title.closest('div') as HTMLDivElement
    expect(row).toHaveStyle({ paddingLeft: '0px' })
  })

  it('父子关系成环时取首个节点为根，不死循环也不丢任务', async () => {
    const loopA: Task = { ...parentTask, id: 'a1', title: '环A', parentTaskId: 'b1' }
    const loopB: Task = { ...parentTask, id: 'b1', title: '环B', parentTaskId: 'a1' }
    setup(detailOf({ ...thread, taskIds: ['a1', 'b1'], rootTaskIds: [] }, [loopA, loopB]))

    expect(await screen.findByText('环A')).toBeInTheDocument()
    expect(screen.getByText('环B')).toBeInTheDocument()
    const childRow = screen.getByText('环B').closest('div') as HTMLDivElement
    expect(childRow).toHaveStyle({ paddingLeft: '14px' })
  })

  it('添加笔记：dispatch thread.note，成功后清空输入并随事实刷新列表', async () => {
    let current: ThreadRow = { ...thread, notes: [], notesVersion: 0 }
    dispatchWith(<C extends Command>(command: C): CommandDispatchResult<C> => {
      if (command.type === 'thread.note') {
        current = {
          ...current,
          notesVersion: current.notesVersion + 1,
          notes: [{ id: 'n2', author: 'owner', text: command.text, at: 't' }],
        }
        kernel.setView('thread.byId', { threadId: 'th1' }, detailOf(current))
      }
      return { facts: [], value: null } as CommandDispatchResult<C>
    })
    const user = userEvent.setup()
    setup(detailOf(current))

    await screen.findByText('还没有笔记')
    await user.type(screen.getByLabelText('线程笔记'), '  新笔记  ')
    await user.click(screen.getByRole('button', { name: '添加笔记' }))

    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({ type: 'thread.note', threadId: 'th1', text: '新笔记' }),
      ),
    )
    expect(await screen.findByText('新笔记')).toBeInTheDocument()
    expect(screen.getByLabelText('线程笔记')).toHaveValue('')
  })

  it('空笔记不发命令，错误就地展示', async () => {
    const user = userEvent.setup()
    setup(detailOf(thread))
    await screen.findByText('上一轮笔记')

    await user.click(screen.getByRole('button', { name: '添加笔记' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('笔记内容不能为空')
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('笔记写入失败展示错误，输入保留可重试', async () => {
    dispatchWith(<C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      command.type === 'thread.note'
        ? Promise.reject(new Error('笔记写不进去'))
        : Promise.resolve({ facts: [], value: null } as CommandDispatchResult<C>),
    )
    const user = userEvent.setup()
    setup(detailOf(thread))
    await screen.findByText('上一轮笔记')

    await user.type(screen.getByLabelText('线程笔记'), '重试文本')
    await user.click(screen.getByRole('button', { name: '添加笔记' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('笔记写不进去')
    expect(screen.getByLabelText('线程笔记')).toHaveValue('重试文本')
  })

  it('写入进行中禁用全部动作（笔记 / 绑定 / 关闭）', async () => {
    dispatchWith(
      <C extends Command>(): Promise<CommandDispatchResult<C>> =>
        new Promise<CommandDispatchResult<C>>(() => {}),
    )
    const user = userEvent.setup()
    setup(detailOf(implicitThread))
    await screen.findByRole('heading', { name: '线程 · 隐式线程' })

    await user.type(screen.getByLabelText('线程笔记'), '写很久')
    await user.click(screen.getByRole('button', { name: '添加笔记' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '添加笔记' })).toBeDisabled())
    expect(screen.getByLabelText('线程笔记')).toBeDisabled()
    expect(screen.getByRole('button', { name: '绑定' })).toBeDisabled()
    expect(screen.getByLabelText('入口来源')).toBeDisabled()
    expect(screen.getByLabelText('外部入口键')).toBeDisabled()
    expect(screen.getByRole('button', { name: '关闭线程' })).toBeDisabled()
  })

  it('未绑定线程提供绑定表单，提交 dispatch thread.bind 后显示已绑定', async () => {
    dispatchWith(<C extends Command>(command: C): CommandDispatchResult<C> => {
      if (command.type === 'thread.bind') {
        kernel.setView(
          'thread.byId',
          { threadId: 'th1' },
          detailOf({ ...implicitThread, source: command.source, externalRef: command.externalRef }),
        )
      }
      return { facts: [], value: null } as CommandDispatchResult<C>
    })
    const user = userEvent.setup()
    setup(detailOf(implicitThread))
    await screen.findByRole('heading', { name: '线程 · 隐式线程' })

    await user.type(screen.getByLabelText('入口来源'), 'github')
    await user.type(screen.getByLabelText('外部入口键'), 'issue-42')
    await user.click(screen.getByRole('button', { name: '绑定' }))

    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({
          type: 'thread.bind',
          threadId: 'th1',
          source: 'github',
          externalRef: 'issue-42',
        }),
      ),
    )
    expect(await screen.findByText(/已绑定/)).toBeInTheDocument()
    expect(screen.queryByLabelText('入口来源')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '绑定' })).not.toBeInTheDocument()
  })

  it('已绑定线程不渲染绑定表单，直接展示入口', async () => {
    setup(detailOf(thread))
    expect(await screen.findByText(/已绑定/)).toBeInTheDocument()
    expect(screen.queryByLabelText('入口来源')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '绑定' })).not.toBeInTheDocument()
  })

  it('绑定缺字段时就地提示，不发命令', async () => {
    const user = userEvent.setup()
    setup(detailOf(implicitThread))
    await screen.findByRole('heading', { name: '线程 · 隐式线程' })

    await user.click(screen.getByRole('button', { name: '绑定' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('入口来源必填')
    expect(kernel.dispatched).toHaveLength(0)

    await user.type(screen.getByLabelText('入口来源'), 'mail')
    await user.click(screen.getByRole('button', { name: '绑定' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('外部入口键必填')
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('绑定失败展示后端文案（非 Error 拒绝也转成文案）', async () => {
    dispatchWith(<C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      command.type === 'thread.bind'
        ? Promise.reject('外部入口已被占用')
        : Promise.resolve({ facts: [], value: null } as CommandDispatchResult<C>),
    )
    const user = userEvent.setup()
    setup(detailOf(implicitThread))
    await screen.findByRole('heading', { name: '线程 · 隐式线程' })

    await user.type(screen.getByLabelText('入口来源'), 'github')
    await user.type(screen.getByLabelText('外部入口键'), 'issue-1')
    await user.click(screen.getByRole('button', { name: '绑定' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('外部入口已被占用')
  })

  it('关闭线程：dispatch thread.close，归档后隐藏关闭按钮并展示归档态', async () => {
    dispatchWith(<C extends Command>(command: C): CommandDispatchResult<C> => {
      if (command.type === 'thread.close') {
        kernel.setView(
          'thread.byId',
          { threadId: 'th1' },
          detailOf({ ...thread, status: 'closed' }),
        )
      }
      return { facts: [], value: null } as CommandDispatchResult<C>
    })
    const user = userEvent.setup()
    setup(detailOf(thread))
    await screen.findByText('上一轮笔记')

    await user.click(screen.getByRole('button', { name: '关闭线程' }))
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({ type: 'thread.close', threadId: 'th1' }),
      ),
    )
    expect(await screen.findByText('已归档')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '关闭线程' })).not.toBeInTheDocument()
    expect(screen.getByText('线程已归档。')).toBeInTheDocument()
  })

  it('已归档线程直接展示归档态且不提供关闭按钮', async () => {
    setup(detailOf({ ...thread, status: 'closed' }))
    expect(await screen.findByText('已归档')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '关闭线程' })).not.toBeInTheDocument()
  })

  it('关闭失败就地展示后端文案，面板保持可操作', async () => {
    dispatchWith(<C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      command.type === 'thread.close'
        ? Promise.reject(new Error('线程不存在'))
        : Promise.resolve({ facts: [], value: null } as CommandDispatchResult<C>),
    )
    const user = userEvent.setup()
    setup(detailOf(thread))
    await screen.findByText('上一轮笔记')

    await user.click(screen.getByRole('button', { name: '关闭线程' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('线程不存在')
    expect(screen.getByRole('button', { name: '关闭线程' })).toBeEnabled()
  })

  it('线程不存在时展示空态', async () => {
    setup(null)
    expect(await screen.findByText(/线程不存在/)).toBeInTheDocument()
  })

  it('读取失败展示错误且不渲染空态正文', async () => {
    kernel.failView('thread.byId', { threadId: 'th1' }, '线程读取失败')
    render(<ThreadPanel threadId="th1" onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('线程读取失败')
    expect(screen.queryByText(/正在读取线程/)).not.toBeInTheDocument()
    expect(screen.queryByText(/线程不存在/)).not.toBeInTheDocument()
  })

  it('关闭按钮与 Esc 都调用 onClose', async () => {
    const user = userEvent.setup()
    const onClose = setup(detailOf(thread))
    await screen.findByText('上一轮笔记')

    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
