import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Command } from '../../../../../src/protocol/commands'
import type {
  Agent,
  Card,
  Conversation,
  Message,
  Project,
  Run,
  Runtime,
  Task,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../../../src/protocol/entities'
import type { CommandDispatchResult } from '../../../../../src/protocol/ipc'
import type { ThreadRow } from '../../../../../src/protocol/thread'
import { AiWorkflowPage } from '../../../../../src/renderer/src/apps/ai-workflow/AiWorkflowPage'
import { installFakeKernel, type FakeKernel } from '../../../shell/fake-kernel'

const runtime: Runtime = {
  id: 'r1',
  name: 'ds',
  executorKey: 'dsh',
  command: 'dsh',
  profile: 'multica',
  argsTemplate: '',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: null,
  maxConcurrent: 1,
  enabled: true,
  createdAt: 't',
  lastProbe: null,
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
    handoffWorkflowId: null,
    handoffStageId: null,
  }
}

const wf: WorkflowWithStages = {
  id: 'w1',
  name: '研发',
  description: '',
  createdAt: 't',
  stages: [stage('s0', '待办', 0, 'none'), stage('s1', '审核', 1, 'user')],
}

/** 当前项目（M10）：任务都落在它下面，看板与新建任务都依赖它存在 */
const project: Project = {
  id: 'p1',
  name: '工作台',
  path: 'D:\\Codes\\workbench',
  description: '',
  createdAt: 't',
  updatedAt: 't',
}

const task: Task = {
  id: 't1',
  title: '任务A',
  description: '',
  workflowId: 'w1',
  projectId: 'p1',
  currentStageId: 's0',
  status: 'active',
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: null,
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  createdAt: 't',
  updatedAt: 't',
}

const run: Run = {
  id: 'run1',
  taskId: 't1',
  stageId: 's0',
  agentId: 'a1',
  runtimeId: 'r1',
  status: 'succeeded',
  prompt: 'p',
  output: 'hello',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: 't',
  endedAt: 't',
  createdAt: 't',
}

const conversation: Conversation = {
  id: 'c1',
  title: '第一段对话',
  agentId: 'a1',
  sessionId: null,
  createdAt: 't',
  updatedAt: 't',
}

const chatMessage: Message = {
  id: 'm1',
  conversationId: 'c1',
  role: 'user',
  content: '你好',
  error: null,
  createdAt: 't',
}

const card: Card = {
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '继续吗',
  text: '选一个',
  options: ['继续', '停止'],
  key: 'k',
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: 't',
  updatedAt: 't',
}

const thread: ThreadRow = {
  id: 'th1',
  source: 'manual',
  externalRef: null,
  title: '任务A 的线程',
  status: 'open',
  taskIds: ['t1'],
  rootTaskIds: ['t1'],
  concurrency: 1,
  notesVersion: 0,
  notes: [],
  events: [],
  lastActivityAt: 't',
  createdAt: 't',
}

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

/** 工作台基础数据：项目 / 工作流 / 智能体 / 任务 / 运行记录 / 设置区清单 */
function seedBase(): void {
  kernel.setView('projects.all', undefined, [project])
  kernel.setView('workflows.all', undefined, [wf])
  kernel.setView('agents.all', undefined, [agent])
  kernel.setView('tasks.byProject', { projectId: 'p1' }, [task])
  kernel.setView('task.byId', { taskId: 't1' }, task)
  kernel.setView('runs.byTask', { taskId: 't1' }, [run])
  kernel.setView('runtimes.all', undefined, [runtime])
  kernel.setView('runtimes.statuses', undefined, [])
  kernel.setView('runtimes.executors', undefined, [
    { key: 'dsh', label: 'DeepSeek Harness', command: 'dsh', profile: 'multica' },
  ])
  kernel.setView('runtimes.detected', undefined, [])
  kernel.setView('conversations.all', undefined, [])
  kernel.setView('rules.all', undefined, { version: 0, rules: [] })
  kernel.setView('plugins.all', undefined, [])
}

/** dispatch 注入：默认零事实成功；覆盖时按命令返回实体/更新视图 */
function dispatchWith(
  handler: <C extends Command>(
    command: C,
  ) => CommandDispatchResult<C> | Promise<CommandDispatchResult<C>>,
): void {
  kernel.onDispatch(handler)
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

/** 工作台默认落在「聊天」栏：看板相关用例先切到「任务」栏 */
async function openTasks(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: '任务' }))
}

/** 把任务卡拖到落点：cardLabel 为卡片 aria-label，targetLabel 为阶段列 / 归档区 aria-label */
function dragTo(cardLabel: string, targetLabel: string): void {
  fireEvent.dragStart(screen.getByLabelText(cardLabel))
  fireEvent.drop(screen.getByRole('group', { name: targetLabel }))
}

function expectDispatched(match: Record<string, unknown>): void {
  expect(kernel.dispatched).toContainEqual(expect.objectContaining(match))
}

describe('AiWorkflowPage', () => {
  it('看板/任务详情页/拖拽/新建任务/拖到归档全流程', async () => {
    seedBase()
    dispatchWith(<C extends Command>(command: C): CommandDispatchResult<C> => {
      if (command.type === 'task.create') {
        const created: Task = { ...task, id: 't2', title: command.input.title }
        kernel.setView('tasks.byProject', { projectId: 'p1' }, [task, created])
        return { facts: [], value: created } as unknown as CommandDispatchResult<C>
      }
      return { facts: [], value: null } as CommandDispatchResult<C>
    })
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()

    // 单击任务卡进入任务详情页（页面，不是弹窗）：运行记录来自 runs.byTask 视图；
    // 事件视图未就绪时回落 output
    await user.click(screen.getByLabelText('任务：任务A'))
    expect(await screen.findByRole('region', { name: '任务详情' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByText('hello')).toBeInTheDocument()

    // 返回回到看板
    await user.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument()
    expect(screen.getByText(/工作流「研发」/)).toBeInTheDocument()

    // 拖到另一阶段：发 task.move 命令
    dragTo('任务：任务A', '阶段：审核')
    await waitFor(() => expectDispatched({ type: 'task.move', id: 't1', stageId: 's1' }))

    // 新建任务：默认从首阶段开始，创建后由视图刷新出现新卡片
    await user.click(screen.getByRole('button', { name: '新建任务' }))
    expect(screen.getByRole('combobox', { name: '起始阶段' })).toHaveTextContent('待办')
    await user.type(screen.getByLabelText('任务标题'), '新任务')
    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() =>
      expectDispatched({
        type: 'task.create',
        input: expect.objectContaining({
          workflowId: 'w1',
          stageId: 's0',
          title: '新任务',
          projectId: 'p1',
        }),
      }),
    )

    // 拖到「归档」区：发 task.complete 命令
    expect(await screen.findByText('新任务')).toBeInTheDocument()
    dragTo('任务：新任务', '归档区')
    await waitFor(() => expectDispatched({ type: 'task.complete', id: 't2' }))
  })

  it('配置项都收在设置里，左侧二级栏目切换，互不混排', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
    expect(screen.queryByText('运行时')).not.toBeInTheDocument()
    // 工作台里没有设置栏目
    expect(screen.queryByRole('navigation', { name: '设置栏目' })).not.toBeInTheDocument()

    await openSection(user, '运行时')
    expect(await screen.findByRole('heading', { name: '运行时' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建运行时' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '智能体' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '工作流' })).not.toBeInTheDocument()

    await openSection(user, '智能体')
    expect(await screen.findByRole('heading', { name: '智能体' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建智能体' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '运行时' })).not.toBeInTheDocument()

    await openSection(user, '工作流')
    expect(await screen.findByRole('heading', { name: '工作流' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建工作流' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '智能体' })).not.toBeInTheDocument()

    await openSection(user, '规则')
    expect(await screen.findByRole('heading', { name: '规则' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建规则' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Issue 进研发' })).toBeEnabled()
    expect(screen.queryByRole('heading', { name: '工作流' })).not.toBeInTheDocument()

    await openSection(user, '插件')
    expect(await screen.findByRole('heading', { name: '插件' })).toBeInTheDocument()
    expect(await screen.findByText('未发现插件')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '规则' })).not.toBeInTheDocument()
  })

  it('配置页默认不显示新增表单，点击新建才弹出', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    await openSection(user, '运行时')
    expect(await screen.findByRole('button', { name: '新建运行时' })).toBeInTheDocument()
    expect(screen.queryByLabelText('运行时名称')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '新建运行时' }))
    expect(await screen.findByLabelText('运行时名称')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('运行时名称')).not.toBeInTheDocument()

    await openSection(user, '智能体')
    await user.click(await screen.findByRole('button', { name: '新建智能体' }))
    expect(await screen.findByLabelText('智能体名称')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('智能体名称')).not.toBeInTheDocument()

    await openSection(user, '工作流')
    await user.click(await screen.findByRole('button', { name: '新建工作流' }))
    expect(await screen.findByLabelText('工作流名称')).toBeInTheDocument()

    await openSection(user, '规则')
    await user.click(await screen.findByRole('button', { name: '新建规则' }))
    expect(await screen.findByLabelText('规则名称')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('规则名称')).not.toBeInTheDocument()
  })

  it('工作流视图加载失败展示错误', async () => {
    kernel.failView('workflows.all', undefined, 'boom')
    render(<AiWorkflowPage />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('任务列表加载失败展示错误', async () => {
    kernel.setView('projects.all', undefined, [project])
    kernel.setView('workflows.all', undefined, [wf])
    kernel.setView('agents.all', undefined, [agent])
    kernel.failView('tasks.byProject', { projectId: 'p1' }, 'tboom')
    render(<AiWorkflowPage />)
    expect(await screen.findByText('tboom')).toBeInTheDocument()
  })

  it('运行记录加载失败在任务详情页展示错误', async () => {
    seedBase()
    kernel.failView('runs.byTask', { taskId: 't1' }, 'rboom')
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await user.click(await screen.findByLabelText('任务：任务A'))
    expect(await screen.findByText('rboom')).toBeInTheDocument()
  })

  it('拖拽失败展示错误', async () => {
    seedBase()
    dispatchWith(() => Promise.reject(new Error('mboom')))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await screen.findByText(/工作流「研发」/)
    dragTo('任务：任务A', '阶段：审核')
    expect(await screen.findByText('mboom')).toBeInTheDocument()
  })

  it('写命令失败为非 Error 时按字符串展示', async () => {
    seedBase()
    dispatchWith(() => Promise.reject('纯文本失败'))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await screen.findByText(/工作流「研发」/)
    dragTo('任务：任务A', '阶段：审核')
    expect(await screen.findByText('纯文本失败')).toBeInTheDocument()
  })

  it('拖到归档失败展示错误', async () => {
    seedBase()
    dispatchWith(() => Promise.reject(new Error('dboom')))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await screen.findByText(/工作流「研发」/)
    dragTo('任务：任务A', '归档区')
    expect(await screen.findByText('dboom')).toBeInTheDocument()
  })

  it('创建任务失败展示错误', async () => {
    seedBase()
    dispatchWith(() => Promise.reject(new Error('cboom')))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await screen.findByText(/工作流「研发」/)
    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.type(screen.getByLabelText('任务标题'), 'x')
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByText('cboom')).toBeInTheDocument()
  })

  it('工作流视图失效后看板跟随刷新', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()

    kernel.setView('workflows.all', undefined, [{ ...wf, name: '研发v2' }])
    kernel.pushFacts(['workflow.updated'])
    expect(await screen.findByText(/工作流「研发v2」/)).toBeInTheDocument()
  })

  it('拖拽仍发命令；任务详情页可返回；取消新建弹窗', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await screen.findByText(/工作流「研发」/)

    dragTo('任务：任务A', '阶段：审核')
    await waitFor(() => expectDispatched({ type: 'task.move', id: 't1', stageId: 's1' }))

    await user.click(screen.getByLabelText('任务：任务A'))
    expect(await screen.findByRole('region', { name: '任务详情' })).toBeInTheDocument()
    // 其它按键不影响详情路由
    await user.keyboard('a')
    expect(screen.getByRole('region', { name: '任务详情' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument(),
    )

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('任务标题')).not.toBeInTheDocument()
  })

  it('事实批次让任务视图重取；工作流清空后看板回到空态', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await screen.findByText(/工作流「研发」/)

    const second: Task = { ...task, id: 't2', title: '任务B' }
    kernel.setView('tasks.byProject', { projectId: 'p1' }, [task, second])
    kernel.pushFacts(['task.created'])
    expect(await screen.findByText('任务B')).toBeInTheDocument()

    kernel.setView('workflows.all', undefined, [])
    kernel.pushFacts(['workflow.removed'])
    expect(await screen.findByText(/尚无工作流/)).toBeInTheDocument()
  })

  it('任务视图失效后查询失败展示错误', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await screen.findByText('任务A')

    kernel.failView('tasks.byProject', { projectId: 'p1' }, 'tb')
    expect(await screen.findByText('tb')).toBeInTheDocument()
  })

  it('工作流视图失效后查询失败展示错误', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await screen.findByText(/工作流「研发」/)

    kernel.failView('workflows.all', undefined, 'reload-boom')
    expect(await screen.findByText('reload-boom')).toBeInTheDocument()
  })

  it('没有工作流时可到设置里新建（dispatch workflow.create）', async () => {
    kernel.setView('projects.all', undefined, [project])
    kernel.setView('workflows.all', undefined, [])
    kernel.setView('agents.all', undefined, [agent])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    // 没有当前工作流时不订阅任务视图：不出现「必填」类参数错误
    await openTasks(user)
    expect(await screen.findByText(/尚无工作流/)).toBeInTheDocument()
    expect(screen.queryByText(/必填/)).toBeNull()

    await openSection(user, '工作流')
    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    await user.type(screen.getByLabelText('工作流名称'), '第一条')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expectDispatched({
        type: 'workflow.create',
        input: expect.objectContaining({ name: '第一条' }),
      }),
    )
  })

  it('视图失败后卸载不再更新状态', async () => {
    seedBase()
    kernel.failView('tasks.byProject', { projectId: 'p1' }, 'late')
    const { container, unmount } = render(<AiWorkflowPage />)
    await act(async () => {
      await Promise.resolve()
    })
    unmount()
    kernel.pushFacts(['task.created'])
    expect(container).toBeEmptyDOMElement()
  })

  it('异步未完成即卸载不报错', async () => {
    seedBase()
    const { container, unmount } = render(<AiWorkflowPage />)
    unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('任务视图未就绪时看板为空，挂载/卸载不报错', async () => {
    kernel.setView('projects.all', undefined, [project])
    kernel.setView('workflows.all', undefined, [wf])
    kernel.setView('agents.all', undefined, [agent])
    const user = userEvent.setup()
    const { unmount } = render(<AiWorkflowPage />)
    await openTasks(user)
    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
    expect(screen.queryByText('任务A')).not.toBeInTheDocument()
    expect(kernel.store.peek('tasks.byProject', { projectId: 'p1' })).toBeUndefined()
    unmount()
  })

  it('工作台默认落在聊天栏；任务栏显示看板；切回聊天隐藏看板', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    // 页头已移除：一级标题归 shell 顶部栏；app 侧栏用 h2 标识当前所在
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    // 默认聊天：侧栏顶部是工作台栏目，下方紧接会话清单
    expect(await screen.findByRole('navigation', { name: '工作台栏目' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '聊天' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '新对话' })).toBeInTheDocument()
    expect(screen.getByLabelText('消息输入')).toBeInTheDocument()
    expect(screen.queryByText(/工作流「研发」/)).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument()
    // 工作流切换器只在任务栏目显示
    expect(screen.queryByRole('combobox', { name: '选择工作流' })).not.toBeInTheDocument()

    // 切到任务：看板就位，侧栏换成工作流切换器
    await openTasks(user)
    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '选择工作流' })).toBeInTheDocument()
    expect(screen.queryByLabelText('消息输入')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新对话' })).not.toBeInTheDocument()

    // 切回聊天：看板隐藏，会话清单回来
    await user.click(screen.getByRole('button', { name: '聊天' }))
    expect(screen.getByLabelText('消息输入')).toBeInTheDocument()
    expect(screen.queryByText(/工作流「研发」/)).not.toBeInTheDocument()

    // 设置视图不显示工作台栏目
    await openSection(user, '运行时')
    expect(screen.queryByRole('navigation', { name: '工作台栏目' })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '设置栏目' })).toBeInTheDocument()
  })

  it('侧栏底部的视图切换在工作台与设置间往返', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    // 底部固定分段控件：两个 tab 常驻
    expect(await screen.findByRole('tab', { name: '工作台' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('tab', { name: '设置' })).toHaveAttribute('aria-selected', 'false')

    await user.click(screen.getByRole('tab', { name: '设置' }))
    expect(screen.getByRole('tab', { name: '设置' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('navigation', { name: '设置栏目' })).toBeInTheDocument()
    // 默认设置栏目 = 运行时配置
    expect(await screen.findByRole('heading', { name: '运行时' })).toBeInTheDocument()
    // 内容区让位给设置内容
    expect(screen.queryByLabelText('消息输入')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: '工作台' }))
    expect(screen.getByLabelText('消息输入')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '运行时' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '设置栏目' })).not.toBeInTheDocument()
  })

  it('任务栏的工作流切换器换工作流后看板随之切换', async () => {
    seedBase()
    const secondWf: WorkflowWithStages = {
      ...wf,
      id: 'w2',
      name: '写作',
      stages: [{ ...stage('s9', '草稿', 0, 'none'), workflowId: 'w2' }],
    }
    kernel.setView('workflows.all', undefined, [wf, secondWf])
    // 项目视图装的是项目下全部任务（混着两个工作流）：看板按 workflowId 自己过滤
    kernel.setView('tasks.byProject', { projectId: 'p1' }, [
      task,
      { ...task, id: 't9', title: '写稿', workflowId: 'w2', currentStageId: 's9' },
    ])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
    // 研发看板里不出现写作工作流的任务
    expect(screen.queryByText('写稿')).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: '选择工作流' }))
    await user.click(await screen.findByRole('option', { name: '写作' }))
    expect(await screen.findByText(/工作流「写作」/)).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '阶段：草稿' })).toBeInTheDocument()
    expect(await screen.findByText('写稿')).toBeInTheDocument()
    expect(screen.queryByText('任务A')).not.toBeInTheDocument()
  })

  it('没有项目时看板显示项目空态，且没有新建任务入口', async () => {
    kernel.setView('projects.all', undefined, [])
    kernel.setView('workflows.all', undefined, [wf])
    kernel.setView('agents.all', undefined, [agent])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    // 任务只能建在项目下：没有项目就给一句能照做的空态，而不是空看板
    expect(
      await screen.findByText('先添加项目（本地文件夹），任务只能建在项目下'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建任务' })).not.toBeInTheDocument()
    // 侧栏项目列表空态 + 添加入口
    expect(screen.getByText('还没有项目')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '+ 添加' })).toBeInTheDocument()
    // 没有项目不订阅任务视图：不出现「必填」类参数错误
    expect(screen.queryByText(/必填/)).toBeNull()
    expect(kernel.store.peek('tasks.byProject', { projectId: 'p1' })).toBeUndefined()
  })

  it('有项目时新建任务：只读展示所属项目，命令带 projectId', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '新建任务' }))
    // 所属项目是只读展示：弹窗里给出项目名与文件夹路径（侧栏也有同名文字，按弹窗取）
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('工作台')).toBeInTheDocument()
    expect(within(dialog).getByText('D:\\Codes\\workbench')).toBeInTheDocument()

    await user.type(screen.getByLabelText('任务标题'), '要素')
    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() =>
      expectDispatched({
        type: 'task.create',
        input: expect.objectContaining({ title: '要素', workflowId: 'w1', projectId: 'p1' }),
      }),
    )
  })

  it('项目弹窗：新建项目 dispatch project.create，成功后选中新项目', async () => {
    seedBase()
    const created: Project = {
      ...project,
      id: 'p2',
      name: '新项目',
      path: 'D:\\Codes\\new-folder',
    }
    dispatchWith(<C extends Command>(command: C): CommandDispatchResult<C> => {
      if (command.type === 'project.create') {
        return { facts: [], value: created } as unknown as CommandDispatchResult<C>
      }
      return { facts: [], value: null } as CommandDispatchResult<C>
    })
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '+ 添加' }))
    await user.type(screen.getByLabelText('项目名称'), '新项目')
    await user.type(screen.getByLabelText('文件夹路径'), 'D:\\Codes\\new-folder')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expectDispatched({
        type: 'project.create',
        input: expect.objectContaining({ name: '新项目', path: 'D:\\Codes\\new-folder' }),
      }),
    )
    // 保存成功即关闭弹窗
    expect(screen.queryByLabelText('项目名称')).not.toBeInTheDocument()

    // 视图刷新后：新项目排在已有项目之后，但返回值让它成为选中项
    kernel.setView('projects.all', undefined, [project, created])
    expect(await screen.findByRole('button', { name: '项目：新项目' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('button', { name: '项目：工作台' })).not.toHaveAttribute('aria-current')
  })

  it('项目弹窗：删除失败时文案同时挂到页面顶部错误条，弹窗不关', async () => {
    seedBase()
    dispatchWith(() => Promise.reject(new Error('项目下还有任务')))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '编辑项目 工作台' }))
    await user.click(screen.getByRole('button', { name: '删除项目' }))

    // 页面顶部错误条 + 弹窗内就地提示各一份
    await waitFor(async () =>
      expect((await screen.findAllByText('项目下还有任务')).length).toBeGreaterThan(0),
    )
    expectDispatched({ type: 'project.remove', id: 'p1' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('未归属任务：出现入口，选中后看板照常展示但没有新建任务入口', async () => {
    seedBase()
    // 老数据 / 老规则建的任务没有项目：它不能因为没有项目而从界面上消失
    kernel.setView('tasks.unassigned', undefined, [
      { ...task, id: 't0', title: '老任务', projectId: null, threadId: null },
    ])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    const entry = await screen.findByRole('button', { name: '未归属' })
    expect(screen.getByText('没有项目的任务')).toBeInTheDocument()
    expect(within(entry).getByText('1')).toBeInTheDocument()

    await user.click(entry)
    expect(await screen.findByText('老任务')).toBeInTheDocument()
    // 看板只展示未归属那批：项目里的任务不混进来
    expect(screen.queryByText('任务A')).not.toBeInTheDocument()
    expect(entry).toHaveAttribute('aria-current', 'page')
    // 没有项目可挂：不给新建入口，改为一句说明
    expect(screen.queryByRole('button', { name: '新建任务' })).not.toBeInTheDocument()
    expect(screen.getByText('未归属任务没有项目，先添加项目再建新任务')).toBeInTheDocument()

    // 切回项目：新建入口回来
    await user.click(screen.getByRole('button', { name: '项目：工作台' }))
    expect(await screen.findByText('任务A')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建任务' })).toBeInTheDocument()
  })

  it('一个项目都没有但有未归属任务：默认落在未归属，不显示项目空态', async () => {
    kernel.setView('projects.all', undefined, [])
    kernel.setView('workflows.all', undefined, [wf])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('tasks.unassigned', undefined, [
      { ...task, id: 't0', title: '老任务', projectId: null, threadId: null },
    ])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    expect(await screen.findByText('老任务')).toBeInTheDocument()
    expect(
      screen.queryByText('先添加项目（本地文件夹），任务只能建在项目下'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '未归属' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('button', { name: '新建任务' })).not.toBeInTheDocument()
  })

  it('聊天栏：新对话 dispatch chat.create、删除对话 dispatch chat.remove、归档 dispatch chat.archive', async () => {
    seedBase()
    kernel.setView('conversations.all', undefined, [conversation])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    await user.click(await screen.findByRole('button', { name: '新对话' }))
    await waitFor(() => expectDispatched({ type: 'chat.create', agentId: 'a1' }))

    // 删除收在 hover 才出现的三点菜单里
    await user.click(await screen.findByRole('button', { name: '会话 第一段对话 更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '删除' }))
    await waitFor(() => expectDispatched({ type: 'chat.remove', conversationId: 'c1' }))

    await user.click(screen.getByRole('button', { name: '会话 第一段对话 更多操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '归档' }))
    await waitFor(() =>
      expectDispatched({ type: 'chat.archive', conversationId: 'c1', archived: true }),
    )
  })

  it('聊天栏：发送中「停止」dispatch chat.cancel', async () => {
    seedBase()
    kernel.setView('conversations.all', undefined, [conversation])
    dispatchWith(
      <C extends Command>(
        command: C,
      ): CommandDispatchResult<C> | Promise<CommandDispatchResult<C>> => {
        // 发送挂起：保持 sending=true，「停止」按钮出现
        if (command.type === 'chat.send') return new Promise<CommandDispatchResult<C>>(() => {})
        return { facts: [], value: null } as CommandDispatchResult<C>
      },
    )
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    await user.type(await screen.findByLabelText('消息输入'), '你好')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await user.click(await screen.findByRole('button', { name: '停止' }))

    expectDispatched({ type: 'chat.cancel', conversationId: 'c1' })
  })

  it('聊天：消息来自当前会话的消息视图', async () => {
    seedBase()
    kernel.setView('conversations.all', undefined, [conversation])
    kernel.setView('messages.byConversation', { conversationId: 'c1' }, [chatMessage])
    render(<AiWorkflowPage />)

    expect(await screen.findByRole('heading', { name: '第一段对话' })).toBeInTheDocument()
    expect(await screen.findByText('你好')).toBeInTheDocument()
    expect(screen.getAllByText('coder').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('正在输出…')).not.toBeInTheDocument()
    // 消息视图失效后界面跟随刷新
    kernel.setView('messages.byConversation', { conversationId: 'c1' }, [
      chatMessage,
      { ...chatMessage, id: 'm2', role: 'assistant', content: '在的' },
    ])
    kernel.pushFacts(['message.appended'])
    expect(await screen.findByText('在的')).toBeInTheDocument()
    // 未输入不发消息
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('顶部审批条读 cards.open 并 dispatch card.answer', async () => {
    seedBase()
    kernel.setView('cards.open', undefined, [card])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    expect(await screen.findByRole('region', { name: '待审批' })).toBeInTheDocument()
    expect(screen.getByText('继续吗')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() =>
      expectDispatched({ type: 'card.answer', cardId: 'card-1', optionIndex: 0, via: 'ui' }),
    )
  })

  it('任务卡线程入口打开线程详情页；线程内点任务进详情；Esc 逐级返回看板', async () => {
    seedBase()
    const threadedTask: Task = { ...task, threadId: 'th1' }
    kernel.setView('tasks.byProject', { projectId: 'p1' }, [threadedTask])
    kernel.setView('task.byId', { taskId: 't1' }, threadedTask)
    kernel.setView(
      'thread.byId',
      { threadId: 'th1' },
      {
        thread,
        tasks: [threadedTask],
        sessions: {},
      },
    )
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await screen.findByText(/工作流「研发」/)

    await user.click(screen.getByRole('button', { name: '打开线程：任务A' }))
    expect(await screen.findByRole('region', { name: '线程详情' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: '线程 · 任务A 的线程' })).toBeInTheDocument()
    expect(screen.getByText('manual')).toBeInTheDocument()

    // 线程的任务列表进任务详情页
    await user.click(screen.getByRole('button', { name: '打开任务：任务A' }))
    expect(await screen.findByRole('region', { name: '任务详情' })).toBeInTheDocument()

    // 返回回到线程详情
    await user.click(screen.getByRole('button', { name: '返回' }))
    expect(await screen.findByRole('region', { name: '线程详情' })).toBeInTheDocument()

    // Esc 逐级回退：回到看板
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '线程详情' })).not.toBeInTheDocument(),
    )
    expect(screen.getByText(/工作流「研发」/)).toBeInTheDocument()
  })

  it('详情页在切换栏目 / 视图后回到看板，不残留上一页', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByLabelText('任务：任务A'))
    expect(await screen.findByRole('region', { name: '任务详情' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '聊天' }))
    expect(screen.getByLabelText('消息输入')).toBeInTheDocument()
    await openTasks(user)
    expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument()
    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()

    // 设置视图同样清空详情栈
    await user.click(screen.getByLabelText('任务：任务A'))
    expect(await screen.findByRole('region', { name: '任务详情' })).toBeInTheDocument()
    await openSection(user, '运行时')
    await user.click(screen.getByRole('tab', { name: '工作台' }))
    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument()
  })
})
