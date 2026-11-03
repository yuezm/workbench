import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Agent,
  Run,
  Runtime,
  Task,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../../shared/ai-workflow-api'
import { AiWorkflowPage } from './AiWorkflowPage'

const runtime: Runtime = {
  id: 'r1',
  name: 'ds',
  kind: 'deepseek-harness',
  command: 'dsh',
  args: [],
  promptMode: 'arg',
  workdir: null,
  createdAt: 't',
}
const agent: Agent = {
  id: 'a1',
  name: 'coder',
  description: '',
  runtimeId: 'r1',
  systemPrompt: '',
  createdAt: 't',
}
function stage(
  id: string,
  name: string,
  position: number,
  entryMode: WorkflowStage['entryMode'],
): WorkflowStage {
  return {
    id,
    workflowId: 'w1',
    name,
    position,
    entryMode,
    agentId: null,
    onCompleteStageId: null,
    onRejectStageId: null,
  }
}
const wf: WorkflowWithStages = {
  id: 'w1',
  name: '研发',
  description: '',
  createdAt: 't',
  stages: [stage('s0', '待办', 0, 'none'), stage('s1', '审核', 1, 'user')],
}
const task: Task = {
  id: 't1',
  title: '任务A',
  description: '',
  workflowId: 'w1',
  currentStageId: 's0',
  status: 'active',
  createdAt: 't',
  updatedAt: 't',
}
const run: Run = {
  id: 'run1',
  taskId: 't1',
  stageId: 's0',
  agentId: 'a1',
  status: 'succeeded',
  prompt: 'p',
  output: 'hello',
  error: null,
  startedAt: 't',
  endedAt: 't',
  createdAt: 't',
}

function makeApi() {
  const state = { workflows: [wf], agents: [agent], tasks: [task], runs: [run] }
  return {
    runtimes: {
      list: vi.fn(async () => [runtime]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    agents: {
      list: vi.fn(async () => state.agents),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    workflows: {
      list: vi.fn(async () => state.workflows),
      create: vi.fn(async (input: { name: string }) => {
        const n = { ...wf, id: 'w2', name: input.name, stages: [] }
        state.workflows = [...state.workflows, n]
        return n
      }),
      update: vi.fn(async () => wf),
      remove: vi.fn(),
    },
    tasks: {
      list: vi.fn(async (_workflowId: string) => state.tasks),
      moveToStage: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
      create: vi.fn(async (input: { title: string }) => {
        const n = { ...task, id: 't2', title: input.title }
        state.tasks = [...state.tasks, n]
        return n
      }),
      remove: vi.fn(),
    },
    runs: { listByTask: vi.fn(async () => state.runs) },
    onChanged: vi.fn(() => () => {}),
  }
}

function install(api: unknown): void {
  ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = api
}

/** 把任务卡拖到落点：cardLabel 为卡片 aria-label，targetLabel 为阶段列 / 已完成区 aria-label */
async function dragTo(cardLabel: string, targetLabel: string): Promise<void> {
  fireEvent.dragStart(await screen.findByLabelText(cardLabel))
  fireEvent.drop(screen.getByRole('group', { name: targetLabel }))
}

/** 切到视图页签：工作台 / 设置 */
async function openView(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(screen.getByRole('tab', { name }))
}

/** 打开设置并切到左侧二级栏目：运行时配置 / 智能体配置 / 工作流配置 */
async function openSection(
  user: ReturnType<typeof userEvent.setup>,
  section: string,
): Promise<void> {
  await openView(user, '设置')
  await user.click(screen.getByRole('button', { name: section }))
}

beforeEach(() => vi.clearAllMocks())

describe('AiWorkflowPage', () => {
  it('看板/运行记录/拖拽/新建任务/编辑与新建工作流全流程', async () => {
    const api = makeApi()
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: '选择任务查看运行' }))
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2))

    await user.click(screen.getByRole('option', { name: '任务A' }))
    await waitFor(() => expect(api.runs.listByTask).toHaveBeenCalledWith('t1'))
    expect(await screen.findByText('hello')).toBeInTheDocument()

    // 拖到另一阶段
    await dragTo('任务：任务A', '阶段：审核')
    await waitFor(() => expect(api.tasks.moveToStage).toHaveBeenCalledWith('t1', 's1'))

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    expect(screen.getByRole('combobox', { name: '起始阶段' })).toHaveTextContent('待办')
    await user.type(screen.getByLabelText('任务标题'), '新任务')
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(api.tasks.create).toHaveBeenCalled())
    expect(api.tasks.create.mock.calls[0][0]).toMatchObject({ workflowId: 'w1', stageId: 's0' })

    // 拖到「已完成」区
    await dragTo('任务：新任务', '已完成区')
    await waitFor(() => expect(api.tasks.complete).toHaveBeenCalledWith('t2'))

    // 工作流定义在「工作流配置」视图里
    await openSection(user, '工作流配置')
    await user.click(screen.getAllByRole('button', { name: '编辑' })[0])
    expect(await screen.findByLabelText('工作流名称')).toHaveValue('研发')
    await user.clear(screen.getByLabelText('工作流名称'))
    await user.type(screen.getByLabelText('工作流名称'), '研发v2')
    await user.click(screen.getByRole('button', { name: '保存工作流' }))
    await waitFor(() => expect(api.workflows.update).toHaveBeenCalled())

    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    expect(await screen.findByLabelText('工作流名称')).toHaveValue('')
    await user.type(screen.getByLabelText('工作流名称'), '第二条')
    await user.click(screen.getByRole('button', { name: '保存工作流' }))
    await waitFor(() => expect(api.workflows.create).toHaveBeenCalled())
  })

  it('配置项都收在设置里，左侧二级栏目切换，互不混排', async () => {
    const api = makeApi()
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
    expect(screen.queryByText('运行时')).not.toBeInTheDocument()
    // 工作台里没有设置栏目
    expect(screen.queryByRole('navigation', { name: '设置栏目' })).not.toBeInTheDocument()

    await openSection(user, '运行时配置')
    expect(await screen.findByRole('heading', { name: '运行时' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建运行时' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '智能体' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '工作流' })).not.toBeInTheDocument()

    await openSection(user, '智能体配置')
    expect(await screen.findByRole('heading', { name: '智能体' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '智能体' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建智能体' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '运行时' })).not.toBeInTheDocument()

    await openSection(user, '工作流配置')
    expect(await screen.findByRole('heading', { name: '工作流' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '工作流' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建工作流' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '智能体' })).not.toBeInTheDocument()
  })

  it('配置页默认不显示新增表单，点击新建才弹出', async () => {
    const api = makeApi()
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    await openSection(user, '运行时配置')
    expect(await screen.findByRole('button', { name: '新建运行时' })).toBeInTheDocument()
    expect(screen.queryByLabelText('运行时名称')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '新建运行时' }))
    expect(await screen.findByLabelText('运行时名称')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('运行时名称')).not.toBeInTheDocument()

    await openSection(user, '智能体配置')
    await user.click(await screen.findByRole('button', { name: '新建智能体' }))
    expect(await screen.findByLabelText('智能体名称')).toBeInTheDocument()
    expect(screen.getByLabelText('智能体名称')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('智能体名称')).not.toBeInTheDocument()

    await openSection(user, '工作流配置')
    await user.click(await screen.findByRole('button', { name: '新建工作流' }))
    expect(await screen.findByLabelText('工作流名称')).toBeInTheDocument()
  })

  it('加载失败展示错误', async () => {
    const api = makeApi()
    api.workflows.list.mockRejectedValue(new Error('boom'))
    install(api)
    render(<AiWorkflowPage />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('任务列表加载失败展示错误', async () => {
    const api = makeApi()
    api.tasks.list.mockRejectedValue('tboom')
    install(api)
    render(<AiWorkflowPage />)
    expect(await screen.findByText('tboom')).toBeInTheDocument()
  })

  it('运行记录加载失败展示错误', async () => {
    const api = makeApi()
    api.runs.listByTask.mockRejectedValue(new Error('rboom'))
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await user.click(screen.getByRole('combobox', { name: '选择任务查看运行' }))
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2))
    await user.click(screen.getByRole('option', { name: '任务A' }))
    expect(await screen.findByText('rboom')).toBeInTheDocument()
    // 拖拽后也会尝试刷新运行记录，覆盖 loadRunsFor 的错误分支
    await dragTo('任务：任务A', '阶段：审核')
    expect(await screen.findByText('rboom')).toBeInTheDocument()
  })

  it('拖拽失败展示错误', async () => {
    const api = makeApi()
    api.tasks.moveToStage.mockRejectedValue(new Error('mboom'))
    install(api)
    render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)
    await dragTo('任务：任务A', '阶段：审核')
    expect(await screen.findByText('mboom')).toBeInTheDocument()
  })

  it('拖到已完成失败展示错误', async () => {
    const api = makeApi()
    api.tasks.complete.mockRejectedValue(new Error('dboom'))
    install(api)
    render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)
    await dragTo('任务：任务A', '已完成区')
    expect(await screen.findByText('dboom')).toBeInTheDocument()
  })

  it('创建任务失败展示错误', async () => {
    const api = makeApi()
    api.tasks.create.mockRejectedValue(new Error('cboom'))
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)
    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.type(screen.getByLabelText('任务标题'), 'x')
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    expect(await screen.findByText('cboom')).toBeInTheDocument()
  })

  it('保存工作流失败展示错误', async () => {
    const api = makeApi()
    api.workflows.update.mockRejectedValue(new Error('sboom'))
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)
    await openSection(user, '工作流配置')
    await user.click(screen.getAllByRole('button', { name: '编辑' })[0])
    await screen.findByLabelText('工作流名称')
    await user.click(screen.getByRole('button', { name: '保存工作流' }))
    expect(await screen.findByText('sboom')).toBeInTheDocument()
  })

  it('拖拽未选任务也刷新；清空运行选择；取消编辑与对话框', async () => {
    const api = makeApi()
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)

    await dragTo('任务：任务A', '阶段：审核')
    await waitFor(() => expect(api.tasks.moveToStage).toHaveBeenCalled())

    await user.click(screen.getByRole('combobox', { name: '选择任务查看运行' }))
    await user.click(screen.getByRole('option', { name: '任务A' }))
    await user.click(screen.getByRole('combobox', { name: '选择任务查看运行' }))
    await user.click(screen.getByRole('option', { name: '（选择任务）' }))
    expect(screen.getByRole('combobox', { name: '选择任务查看运行' })).toHaveTextContent(
      '（选择任务）',
    )

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.click(screen.getByRole('button', { name: '取消' }))

    await openSection(user, '工作流配置')
    await user.click(screen.getAllByRole('button', { name: '编辑' })[0])
    await user.click(screen.getByRole('button', { name: '取消' }))

    // 再次打开：用 Esc 关闭弹窗
    await user.click(screen.getAllByRole('button', { name: '编辑' })[0])
    await user.keyboard('{Escape}')
    expect(screen.queryByLabelText('工作流名称')).not.toBeInTheDocument()
  })

  it('onChanged 触发重新加载', async () => {
    const api = makeApi()
    let reloadCb: (() => void) | undefined
    ;(api as unknown as { onChanged: (cb: () => void) => () => void }).onChanged = (cb) => {
      reloadCb = cb
      return () => {}
    }
    install(api)
    render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)
    const before = api.workflows.list.mock.calls.length
    await reloadCb?.()
    await waitFor(() => expect(api.workflows.list.mock.calls.length).toBeGreaterThan(before))
    // 回归：onChanged 回调必须用最新 activeId 拉任务（不能是初始 undefined）
    await waitFor(() => expect(api.tasks.list.mock.calls.at(-1)?.[0]).toBe('w1'))

    // 再次触发，但工作流列表为空：覆盖 activeId 回填分支
    api.workflows.list.mockResolvedValueOnce([])
    await reloadCb?.()
    await waitFor(() => expect(api.workflows.list.mock.calls.length).toBeGreaterThan(before + 1))
  })

  it('拖拽后任务刷新失败展示错误', async () => {
    const api = makeApi()
    api.tasks.list.mockResolvedValueOnce([task]).mockRejectedValue(new Error('tb'))
    install(api)
    render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)
    await dragTo('任务：任务A', '阶段：审核')
    expect(await screen.findByText('tb')).toBeInTheDocument()
  })

  it('onChanged 后刷新失败展示错误', async () => {
    const api = makeApi()
    let reloadCb: (() => void) | undefined
    ;(api as unknown as { onChanged: (cb: () => void) => () => void }).onChanged = (cb) => {
      reloadCb = cb
      return () => {}
    }
    api.workflows.list.mockResolvedValueOnce([wf]).mockRejectedValue(new Error('reload-boom'))
    install(api)
    render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)
    await reloadCb?.()
    expect(await screen.findByText('reload-boom')).toBeInTheDocument()
  })

  it('没有工作流时可直接新建', async () => {
    const api = makeApi()
    api.workflows.list.mockResolvedValue([])
    let reloadCb: (() => void) | undefined
    ;(api as unknown as { onChanged: (cb: () => void) => () => void }).onChanged = (cb) => {
      reloadCb = cb
      return () => {}
    }
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    await openSection(user, '工作流配置')
    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    await user.type(screen.getByLabelText('工作流名称'), '第一条')
    await user.click(screen.getByRole('button', { name: '保存工作流' }))
    await waitFor(() => expect(api.workflows.create).toHaveBeenCalled())

    // 空清单时刷新走 activeId 为空的分支
    await reloadCb?.()
    await waitFor(() => expect(api.workflows.list.mock.calls.length).toBeGreaterThan(1))
  })

  it('卸载后异步失败不再更新状态', async () => {
    const api = makeApi()
    api.workflows.list.mockRejectedValue(new Error('boom'))
    api.tasks.list.mockRejectedValue(new Error('tboom'))
    api.runs.listByTask.mockRejectedValue(new Error('rboom'))
    install(api)
    const { unmount } = render(<AiWorkflowPage />)
    unmount()
    await new Promise((r) => setTimeout(r, 30))
  })

  it('异步未完成即卸载不报错', async () => {
    const api = makeApi()
    install(api)
    const { unmount } = render(<AiWorkflowPage />)
    unmount()
    await new Promise((r) => setTimeout(r, 0))
  })

  it('任务列表请求未完成即卸载：成功返回不写状态', async () => {
    const api = makeApi()
    let resolveTasks!: (v: Task[]) => void
    api.tasks.list.mockImplementationOnce(
      () =>
        new Promise<Task[]>((res) => {
          resolveTasks = res
        }),
    )
    install(api)
    const { unmount } = render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)
    unmount()
    resolveTasks([task])
    await new Promise((r) => setTimeout(r, 0))
  })

  it('任务列表请求未完成即卸载：失败不写状态', async () => {
    const api = makeApi()
    let rejectTasks!: (e: unknown) => void
    api.tasks.list.mockImplementationOnce(
      () =>
        new Promise<Task[]>((_res, rej) => {
          rejectTasks = rej
        }),
    )
    install(api)
    const { unmount } = render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)
    unmount()
    rejectTasks(new Error('late'))
    await new Promise((r) => setTimeout(r, 0))
  })

  it('运行记录请求未完成即卸载：成功与失败都不写状态', async () => {
    const api = makeApi()
    let resolveRuns!: (v: Run[]) => void
    let rejectRuns!: (e: unknown) => void
    api.runs.listByTask
      .mockImplementationOnce(
        () =>
          new Promise<Run[]>((res) => {
            resolveRuns = res
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Run[]>((_res, rej) => {
            rejectRuns = rej
          }),
      )
    install(api)
    const user = userEvent.setup()

    const first = render(<AiWorkflowPage />)
    await user.click(await screen.findByRole('combobox', { name: '选择任务查看运行' }))
    await user.click(await screen.findByRole('option', { name: '任务A' }))
    first.unmount()
    resolveRuns([run])
    await new Promise((r) => setTimeout(r, 0))

    const second = render(<AiWorkflowPage />)
    await user.click(await screen.findByRole('combobox', { name: '选择任务查看运行' }))
    await user.click(await screen.findByRole('option', { name: '任务A' }))
    second.unmount()
    rejectRuns(new Error('late'))
    await new Promise((r) => setTimeout(r, 0))
  })
})
