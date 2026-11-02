import { render, screen, waitFor } from '@testing-library/react'
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
      move: vi.fn(async () => {}),
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

beforeEach(() => vi.clearAllMocks())

describe('AiWorkflowPage', () => {
  it('看板/运行记录/推进/新建任务/编辑与新建工作流全流程', async () => {
    const api = makeApi()
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getByLabelText('选择任务查看运行').querySelectorAll('option').length,
      ).toBeGreaterThan(1),
    )

    await user.selectOptions(screen.getByLabelText('选择任务查看运行'), 't1')
    await waitFor(() => expect(api.runs.listByTask).toHaveBeenCalledWith('t1'))
    expect(await screen.findByText('hello')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '推进' }))
    await waitFor(() => expect(api.tasks.move).toHaveBeenCalledWith('t1', 'next'))

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.type(screen.getByLabelText('任务标题'), '新任务')
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(api.tasks.create).toHaveBeenCalled())

    await user.click(screen.getByRole('button', { name: '编辑' }))
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
    await waitFor(() =>
      expect(
        screen.getByLabelText('选择任务查看运行').querySelectorAll('option').length,
      ).toBeGreaterThan(1),
    )
    await user.selectOptions(screen.getByLabelText('选择任务查看运行'), 't1')
    expect(await screen.findByText('rboom')).toBeInTheDocument()
    // 通过/推进时也会尝试刷新运行记录，覆盖 loadRunsFor 的错误分支
    await user.click(await screen.findByRole('button', { name: '推进' }))
    expect(await screen.findByText('rboom')).toBeInTheDocument()
  })

  it('推进失败展示错误', async () => {
    const api = makeApi()
    api.tasks.move.mockRejectedValue(new Error('mboom'))
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)
    await user.click(await screen.findByRole('button', { name: '推进' }))
    expect(await screen.findByText('mboom')).toBeInTheDocument()
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
    await user.click(screen.getByRole('button', { name: '编辑' }))
    await screen.findByLabelText('工作流名称')
    await user.click(screen.getByRole('button', { name: '保存工作流' }))
    expect(await screen.findByText('sboom')).toBeInTheDocument()
  })

  it('推进未选任务刷新；清空运行选择；取消编辑与对话框', async () => {
    const api = makeApi()
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)

    await user.click(await screen.findByRole('button', { name: '推进' }))
    await waitFor(() => expect(api.tasks.move).toHaveBeenCalled())

    await user.selectOptions(screen.getByLabelText('选择任务查看运行'), 't1')
    await user.selectOptions(screen.getByLabelText('选择任务查看运行'), '')

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.click(screen.getByRole('button', { name: '取消' }))

    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
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

  it('移动后任务刷新失败展示错误', async () => {
    const api = makeApi()
    api.tasks.list.mockResolvedValueOnce([task]).mockRejectedValue(new Error('tb'))
    install(api)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await screen.findByText(/工作流「研发」/)
    await user.click(await screen.findByRole('button', { name: '推进' }))
    expect(await screen.findByText('tb')).toBeInTheDocument()
  })

  it('异步未完成即卸载不报错', async () => {
    const api = makeApi()
    install(api)
    const { unmount } = render(<AiWorkflowPage />)
    unmount()
    await new Promise((r) => setTimeout(r, 0))
  })
})
