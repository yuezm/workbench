import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import {
  AiWorkflowPage,
  cardLanding,
} from '../../../../../src/renderer/src/apps/ai-workflow/AiWorkflowPage'
import {
  pushOpenTarget,
  resetOpenTargetForTest,
} from '../../../../../src/renderer/src/shell/openTarget'
import { installFakeKernel, type FakeKernel } from '../../../shell/fake-kernel'

const runtime: Runtime = {
  id: 'r1',
  name: 'ds',
  executorKey: 'dsh',
  command: 'dsh',
  profile: 'multica',
  argsTemplate: '',
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
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
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

/** 另一个项目：系统通知的落点可能来自别的项目，左侧项目要跟着任务走 */
const otherProject: Project = {
  id: 'p2',
  name: '另一个项目',
  path: 'D:\\Codes\\other',
  description: '',
  createdAt: 't',
  updatedAt: 't',
}

/** 宿主默认目录（M11）：没有项目时的落点，由 `runtimes.default-workdir` 视图给出 */
const DEFAULT_PATH = 'C:\\Users\\me\\.workbench'

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
  projectId: 'p1',
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
  kind: 'ask',
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
  // 落点是 shell 的模块级 store：每个用例从「没有落点」开始，避免上一个用例的点击串场
  resetOpenTargetForTest()
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
  kernel.setView('conversations.byProject', { projectId: 'p1' }, [])
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

/** 切到视图：进设置点侧栏底部的「设置」，回工作台点设置侧栏顶部的「返回工作台」 */
async function openView(
  user: ReturnType<typeof userEvent.setup>,
  name: '设置' | '工作台',
): Promise<void> {
  if (name === '设置') {
    // 已经在设置视图（侧栏显示「返回工作台」）就不用再点「设置」
    if (screen.queryByRole('button', { name: '返回工作台' }) === null) {
      await user.click(screen.getByRole('button', { name: '设置' }))
    }
    return
  }
  await user.click(screen.getByRole('button', { name: '返回工作台' }))
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
    await user.click(screen.getByRole('menuitem', { name: '从空白创建工作流' }))
    expect(await screen.findByLabelText('工作流名称')).toBeInTheDocument()
    // 编辑器是模态弹窗：开着时背景（栏目切换）不可交互，先关掉再切下一个栏目
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('工作流名称')).not.toBeInTheDocument()

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

  it('创建任务失败：弹窗就地提示 + 页面顶部错误条各一份，弹窗不关', async () => {
    seedBase()
    dispatchWith(() => Promise.reject(new Error('cboom')))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await screen.findByText(/工作流「研发」/)
    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.type(screen.getByLabelText('任务标题'), 'x')
    await user.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(async () => expect((await screen.findAllByText('cboom')).length).toBe(2))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('任务标题')).toHaveValue('x')
  })

  it('创建任务失败为非 Error 时按字符串展示', async () => {
    seedBase()
    dispatchWith(() => Promise.reject('纯文本创建失败'))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await screen.findByText(/工作流「研发」/)
    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.type(screen.getByLabelText('任务标题'), 'x')
    await user.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(async () => expect((await screen.findAllByText('纯文本创建失败')).length).toBe(2))
  })

  it('标题为空时不发命令，弹窗里给出必填错误', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await user.click(await screen.findByRole('button', { name: '新建任务' }))
    await user.click(screen.getByRole('button', { name: '创建' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('任务标题必填')
    expect(kernel.dispatched.filter((command) => command.type === 'task.create')).toHaveLength(0)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('页面级错误条可关闭：顶部条关掉后只剩弹窗内的就地提示', async () => {
    seedBase()
    dispatchWith(() => Promise.reject(new Error('可关闭的错误')))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)
    await user.click(await screen.findByRole('button', { name: '新建任务' }))
    await user.type(screen.getByLabelText('任务标题'), 'x')
    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(screen.getAllByText('可关闭的错误')).toHaveLength(2))

    // 模态弹窗开着时 Radix 把背景标成 aria-hidden：关闭按钮要带 hidden 才取得到，
    // 再按容器区分——页面级错误条在弹窗外，弹窗内的 FormError 没有关闭入口
    const pageLevelDismiss = screen
      .getAllByRole('button', { name: '关闭错误提示', hidden: true })
      .find((el) => !el.closest('[role="dialog"]'))
    expect(pageLevelDismiss).toBeDefined()
    // 背景此刻不可交互（模态语义）：按钮落在 aria-hidden 的背景里
    expect(pageLevelDismiss?.closest('[aria-hidden="true"]')).not.toBeNull()

    // 关掉页面级错误条：只剩弹窗内那份就地提示
    // 背景按钮不可点（模态把背景的 pointer-events 也关掉了），这里程序化触发它的 onDismiss
    fireEvent.click(pageLevelDismiss as HTMLElement)
    const remaining = screen.getAllByText('可关闭的错误')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].closest('[role="dialog"]')).not.toBeNull()

    // 弹窗关掉后错误不再残留
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByText('可关闭的错误')).not.toBeInTheDocument()
  })

  it('通知条的卡片视图读失败也在页面级错误条里暴露', async () => {
    seedBase()
    kernel.failView('cards.open', undefined, 'cards-boom')
    render(<AiWorkflowPage />)
    expect(await screen.findByText('cards-boom')).toBeInTheDocument()
  })

  it('项目视图读失败：页面级错误条播报，不静默退化成空态', async () => {
    seedBase()
    kernel.failView('projects.all', undefined, 'projects-boom')
    render(<AiWorkflowPage />)
    expect(await screen.findByText('projects-boom')).toBeInTheDocument()
  })

  it('智能体视图读失败：同样进页面级错误条（否则「没智能体」看起来像没配置）', async () => {
    seedBase()
    kernel.failView('agents.all', undefined, 'agents-boom')
    render(<AiWorkflowPage />)
    expect(await screen.findByText('agents-boom')).toBeInTheDocument()
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
    await user.click(screen.getByRole('menuitem', { name: '从空白创建工作流' }))
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

    // 入口在侧栏底部（带文字的整行按钮）；出口在设置侧栏顶部，跟着栏目一起出现在第一屏
    expect(await screen.findByRole('button', { name: '设置' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '返回工作台' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getByRole('button', { name: '返回工作台' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: '设置栏目' })).toBeInTheDocument()
    // 出口在栏目之上：设置视图里第一屏就能看到，不像原来那样只留在左下角
    const back = screen.getByRole('button', { name: '返回工作台' })
    const nav = screen.getByRole('navigation', { name: '设置栏目' })
    expect(back.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 默认设置栏目 = 运行时配置
    expect(await screen.findByRole('heading', { name: '运行时' })).toBeInTheDocument()
    // 内容区让位给设置内容
    expect(screen.queryByLabelText('消息输入')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '返回工作台' }))
    expect(screen.getByLabelText('消息输入')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '运行时' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: '设置栏目' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument()
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

  it('没有项目时落在默认目录：看板照常可用，新建入口仍在', async () => {
    kernel.setView('projects.all', undefined, [])
    kernel.setView('workflows.all', undefined, [wf])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('runtimes.default-workdir', undefined, DEFAULT_PATH)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    // 项目列表空态 + 默认目录行（当前选中）
    expect(await screen.findByText('还没有项目，可先落到默认目录')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '默认目录' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText(DEFAULT_PATH)).toBeInTheDocument()
    // 任务可以落默认目录：看板与新建入口都在
    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建任务' })).toBeInTheDocument()
    // 没有项目不订阅项目任务视图：不出现「必填」类参数错误
    expect(screen.queryByText(/必填/)).toBeNull()
    expect(kernel.store.peek('tasks.byProject', { projectId: 'p1' })).toBeUndefined()
  })

  it('默认目录下新建任务：只读展示默认目录，命令 projectId 为 null', async () => {
    seedBase()
    kernel.setView('runtimes.default-workdir', undefined, DEFAULT_PATH)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '默认目录' }))
    await user.click(await screen.findByRole('button', { name: '新建任务' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('默认目录')).toBeInTheDocument()
    expect(within(dialog).getByText(DEFAULT_PATH)).toBeInTheDocument()

    await user.type(screen.getByLabelText('任务标题'), '落在默认目录')
    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() =>
      expectDispatched({
        type: 'task.create',
        input: expect.objectContaining({ title: '落在默认目录', projectId: null }),
      }),
    )
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

  it('列内快速新建（默认目录）：projectId 落成 null，标题与要求一起提交', async () => {
    seedBase()
    kernel.setView('runtimes.default-workdir', undefined, DEFAULT_PATH)
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    // 先切到默认目录：此时没有选中项目，快速新建必须把归属落成 null
    await user.click(await screen.findByRole('button', { name: '默认目录' }))
    await user.click(await screen.findByRole('button', { name: '在「待办」阶段添加任务' }))
    await user.type(screen.getByLabelText('阶段「待办」的新任务标题'), '快速建的')
    await user.type(screen.getByLabelText('阶段「待办」的新任务要求'), '只写标题也行')
    await user.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() =>
      expectDispatched({
        type: 'task.create',
        input: expect.objectContaining({
          title: '快速建的',
          description: '只写标题也行',
          workflowId: 'w1',
          stageId: 's0',
          projectId: null,
        }),
      }),
    )
  })

  it('列内快速新建失败且后端抛非 Error：页面错误条与列内都按字符串展示，输入不丢', async () => {
    seedBase()
    dispatchWith(<C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      command.type === 'task.create'
        ? Promise.reject('看板写不进去')
        : Promise.resolve({ facts: [], value: null } as CommandDispatchResult<C>),
    )
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '在「待办」阶段添加任务' }))
    await user.type(screen.getByLabelText('阶段「待办」的新任务标题'), '会失败的')
    await user.click(screen.getByRole('button', { name: '添加' }))

    // 页面顶部一条 + 列内一条：同一个字符串，界面不崩、输入留着可重试
    await waitFor(() => expect(screen.getAllByText('看板写不进去')).toHaveLength(2))
    expect(screen.getByLabelText('阶段「待办」的新任务标题')).toHaveValue('会失败的')
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
    dispatchWith(() => Promise.reject(new Error('项目下有执行中的任务')))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '编辑项目 工作台' }))
    await user.click(screen.getByRole('button', { name: '删除项目' }))

    // 页面顶部错误条 + 弹窗内就地提示各一份
    await waitFor(async () =>
      expect((await screen.findAllByText('项目下有执行中的任务')).length).toBeGreaterThan(0),
    )
    expectDispatched({ type: 'project.remove', id: 'p1' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('默认目录：入口常驻，选中后看板展示没有项目的任务，新建入口仍在', async () => {
    seedBase()
    // 老数据 / 老规则建的任务没有项目：它不能因为没有项目而从界面上消失
    kernel.setView('tasks.unassigned', undefined, [
      { ...task, id: 't0', title: '老任务', projectId: null, threadId: null },
    ])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    const entry = await screen.findByRole('button', { name: '默认目录' })
    await user.click(entry)
    expect(await screen.findByText('老任务')).toBeInTheDocument()
    // 看板只展示默认目录那批：项目里的任务不混进来
    expect(screen.queryByText('任务A')).not.toBeInTheDocument()
    expect(entry).toHaveAttribute('aria-current', 'page')
    // 默认目录也能建任务：入口不消失
    expect(screen.getByRole('button', { name: '新建任务' })).toBeInTheDocument()

    // 切回项目：看板换回项目任务
    await user.click(screen.getByRole('button', { name: '项目：工作台' }))
    expect(await screen.findByText('任务A')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建任务' })).toBeInTheDocument()
  })

  it('一个项目都没有：默认落在默认目录', async () => {
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
    expect(screen.getByRole('button', { name: '默认目录' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '新建任务' })).toBeInTheDocument()
  })

  it('项目切换同时换聊天上下文：会话清单按项目取，头部显示项目名', async () => {
    seedBase()
    kernel.setView('conversations.byProject', { projectId: 'p1' }, [conversation])
    kernel.setView('conversations.unassigned', undefined, [
      { ...conversation, id: 'c-default', title: '默认目录会话', projectId: null },
    ])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    // 默认落在第一个项目：清单是该项目的会话，头部交代项目名
    expect(await screen.findByRole('button', { name: /^第一段对话/ })).toBeInTheDocument()
    expect(screen.getByLabelText('所属项目')).toHaveTextContent('工作台')

    // 切到默认目录：清单换成没有项目的会话
    await user.click(screen.getByRole('button', { name: '默认目录' }))
    expect(await screen.findByRole('button', { name: /^默认目录会话/ })).toBeInTheDocument()
    expect(screen.queryByText('第一段对话')).not.toBeInTheDocument()
    expect(screen.getByLabelText('所属项目')).toHaveTextContent('默认目录')
  })

  it('聊天栏：新对话 dispatch chat.create、删除对话 dispatch chat.remove、归档 dispatch chat.archive', async () => {
    seedBase()
    kernel.setView('conversations.byProject', { projectId: 'p1' }, [conversation])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    await user.click(await screen.findByRole('button', { name: '新对话' }))
    // 聊天与任务同口径落项目：新对话带当前项目 id
    await waitFor(() => expectDispatched({ type: 'chat.create', agentId: 'a1', projectId: 'p1' }))

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
    kernel.setView('conversations.byProject', { projectId: 'p1' }, [conversation])
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
    kernel.setView('conversations.byProject', { projectId: 'p1' }, [conversation])
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

  it('顶部通知条只列标题：点条目进任务详情，在任务内部作答', async () => {
    seedBase()
    kernel.setView('cards.open', undefined, [{ ...card, taskId: 't1' }])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    const bar = await screen.findByRole('region', { name: '待审批' })
    // 通知条只给标题与待选数：正文与选项都留在任务内部
    expect(within(bar).getByText('继续吗')).toBeInTheDocument()
    expect(within(bar).getByText('2 项待选')).toBeInTheDocument()
    expect(within(bar).queryByText('选一个')).toBeNull()
    // 条子里没有选项（选项在任务内部，且是「先选一项，再提交」的 radio）
    expect(within(bar).queryByRole('radio', { name: '继续' })).toBeNull()
    expect(within(bar).queryByRole('button', { name: '提交所选' })).toBeNull()

    await user.click(within(bar).getByRole('button', { name: /继续吗/ }))
    expect(await screen.findByRole('region', { name: '任务详情' })).toBeInTheDocument()
    expect(await screen.findByText('选一个')).toBeInTheDocument()

    // 选中 ≠ 提交：先点一行，再按「提交所选」
    await user.click(screen.getByRole('radio', { name: '继续' }))
    expect(kernel.dispatched).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '提交所选' }))
    await waitFor(() =>
      expectDispatched({ type: 'card.answer', cardId: 'card-1', optionIndex: 0, via: 'ui' }),
    )
  })

  it('聊天卡跨项目：点通知条先切到会话所属项目（默认目录）再选中会话', async () => {
    seedBase()
    // 卡片挂的会话属于默认目录，而当前上下文是项目 p1：点通知条必须连项目一起切
    const defaultConversation = {
      ...conversation,
      id: 'c-default',
      title: '默认目录会话',
      projectId: null,
    }
    kernel.setView('conversations.all', undefined, [conversation, defaultConversation])
    kernel.setView('conversations.byProject', { projectId: 'p1' }, [conversation])
    kernel.setView('conversations.unassigned', undefined, [defaultConversation])
    kernel.setView('cards.open', undefined, [
      { ...card, id: 'card-c', taskId: null, conversationId: 'c-default', title: '要继续吗' },
    ])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    expect(await screen.findByLabelText('所属项目')).toHaveTextContent('工作台')
    const bar = await screen.findByRole('region', { name: '待审批' })
    await user.click(within(bar).getByRole('button', { name: /要继续吗/ }))

    expect(await screen.findByRole('heading', { name: '默认目录会话' })).toBeInTheDocument()
    expect(screen.getByLabelText('所属项目')).toHaveTextContent('默认目录')
    expect(screen.getByRole('button', { name: '默认目录' })).toHaveAttribute('aria-current', 'page')
  })

  it('聊天卡：点通知条切到对应会话，在会话内作答', async () => {
    seedBase()
    kernel.setView('conversations.byProject', { projectId: 'p1' }, [
      conversation,
      { ...conversation, id: 'c2', title: '第二段对话' },
    ])
    kernel.setView('cards.open', undefined, [
      { ...card, id: 'card-c', taskId: null, conversationId: 'c2', title: '要继续吗' },
    ])
    const user = userEvent.setup()
    render(<AiWorkflowPage />)

    const bar = await screen.findByRole('region', { name: '待审批' })
    expect(within(bar).getByText('对话')).toBeInTheDocument()
    await user.click(within(bar).getByRole('button', { name: /要继续吗/ }))

    // 切换会话后卡片本体出现在会话里
    expect(await screen.findByRole('heading', { name: '第二段对话' })).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: '停止' }))
    await user.click(screen.getByRole('button', { name: '提交所选' }))
    await waitFor(() =>
      expectDispatched({ type: 'card.answer', cardId: 'card-c', optionIndex: 1, via: 'ui' }),
    )
  })

  /**
   * 落点（M27）：系统通知 / 通知条点进来之后，除了「进任务详情 / 会话」还要**定位到那张卡**。
   * 通知条只给标题，落点不给高亮的话人还得在任务里自己翻——那正是要修的半个问题。
   * 锚点与高亮由 `ApprovalCards` 打在卡片元素上（`data-card-id` / `data-focused`）。
   */
  describe('落点与高亮定位', () => {
    /** 卡上出现 `data-focused="true"`：`ApprovalCards` 按 `focusCardId` 找到锚点后打的标记 */
    async function expectFocused(cardId: string): Promise<void> {
      await waitFor(() => {
        const node = document.querySelector(`[data-card-id="${cardId}"]`)
        expect(node).not.toBeNull()
        expect(node).toHaveAttribute('data-focused', 'true')
      })
    }

    it('点顶部通知条条目：进任务详情，并高亮那一张卡', async () => {
      seedBase()
      kernel.setView('cards.open', undefined, [{ ...card, taskId: 't1' }])
      const user = userEvent.setup()
      render(<AiWorkflowPage />)

      const bar = await screen.findByRole('region', { name: '待审批' })
      await user.click(within(bar).getByRole('button', { name: /继续吗/ }))

      expect(await screen.findByRole('region', { name: '任务详情' })).toBeInTheDocument()
      await expectFocused('card-1')
    })

    it('系统通知落点（taskId + cardId）：进对应任务详情并定位卡片，落点消费后不重放', async () => {
      seedBase()
      kernel.setView('cards.open', undefined, [{ ...card, taskId: 't1' }])
      const user = userEvent.setup()
      render(<AiWorkflowPage />)
      // 先落到看板：落点必须自己把人送到任务详情，而不是等用户点
      await user.click(await screen.findByRole('button', { name: '任务' }))
      expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()

      act(() => pushOpenTarget({ appId: 'ai-workflow', taskId: 't1', cardId: 'card-1' }))

      expect(await screen.findByRole('region', { name: '任务详情' })).toBeInTheDocument()
      await expectFocused('card-1')

      // 落点是一次性的：返回看板后再来一批事实（必然重渲染），不该被拉回详情
      await user.click(screen.getByRole('button', { name: '返回' }))
      expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument()
      act(() => kernel.pushFacts(['task.updated']))
      expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument()
    })

    it('聊天落点（conversationId + cardId）：切到聊天栏目、选中会话并定位卡片', async () => {
      seedBase()
      // 跨项目会话：`openCard` 与新落点都靠 `conversations.all` 反查会话所属项目，切完项目再选中
      kernel.setView('conversations.all', undefined, [
        conversation,
        { ...conversation, id: 'c2', title: '第二段对话', projectId: 'p2' },
      ])
      kernel.setView('projects.all', undefined, [project, otherProject])
      kernel.setView('conversations.byProject', { projectId: 'p2' }, [
        { ...conversation, id: 'c2', title: '第二段对话', projectId: 'p2' },
      ])
      kernel.setView('cards.open', undefined, [
        { ...card, id: 'card-c', taskId: null, conversationId: 'c2', title: '要继续吗' },
      ])
      const user = userEvent.setup()
      render(<AiWorkflowPage />)
      // 先在任务栏，落点要自己切回聊天
      await user.click(await screen.findByRole('button', { name: '任务' }))
      expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()

      act(() => pushOpenTarget({ appId: 'ai-workflow', conversationId: 'c2', cardId: 'card-c' }))

      expect(await screen.findByRole('heading', { name: '第二段对话' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '聊天' })).toHaveAttribute('aria-current', 'page')
      // 项目跟着会话走（会话挂在 p2）
      expect(screen.getByRole('button', { name: '项目：另一个项目' })).toHaveAttribute(
        'aria-current',
        'page',
      )
      await expectFocused('card-c')
    })

    it('系统通知落点：左侧项目跟着任务所属项目切（task.byId 单次查询）', async () => {
      seedBase()
      // 任务属于 p2，而页面当前在 p1：只打开详情不切项目的话，看板与会话清单都还停在 p1
      kernel.setView('projects.all', undefined, [project, otherProject])
      kernel.setView('tasks.byProject', { projectId: 'p2' }, [{ ...task, projectId: 'p2' }])
      kernel.setView('task.byId', { taskId: 't1' }, { ...task, projectId: 'p2' })
      render(<AiWorkflowPage />)
      expect(await screen.findByRole('button', { name: '项目：工作台' })).toHaveAttribute(
        'aria-current',
        'page',
      )

      act(() => pushOpenTarget({ appId: 'ai-workflow', taskId: 't1' }))

      expect(await screen.findByRole('region', { name: '任务详情' })).toBeInTheDocument()
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '项目：另一个项目' })).toHaveAttribute(
          'aria-current',
          'page',
        ),
      )
    })

    it('系统通知落点：任务已被删（归属查询为空）时项目回落默认目录，详情照常打开', async () => {
      seedBase()
      // 任务行已经不在（别处删了）：落点打开详情会显示「任务不存在」，左侧不该停在旧项目
      kernel.setView('task.byId', { taskId: 't1' }, null)
      render(<AiWorkflowPage />)

      act(() => pushOpenTarget({ appId: 'ai-workflow', taskId: 't1' }))

      expect(await screen.findByRole('region', { name: '任务详情' })).toBeInTheDocument()
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '默认目录' })).toHaveAttribute(
          'aria-current',
          'page',
        ),
      )
    })

    it('连点两条任务通知：迟到的归属查询不覆盖后一条落点的项目', async () => {
      seedBase()
      kernel.setView('projects.all', undefined, [project, otherProject])
      kernel.setView('task.byId', { taskId: 't1' }, { ...task, projectId: 'p2' })
      kernel.setView('task.byId', { taskId: 't2' }, { ...task, id: 't2', projectId: 'p1' })

      // 让第一条落点的归属查询卡住：模拟「查询还在路上，人已经点了下一条通知」
      const realQuery = kernel.store.query.bind(kernel.store)
      let releaseFirst: (value: Task | null) => void = () => {}
      const spy = vi.spyOn(kernel.store, 'query').mockImplementation(((
        view: string,
        params?: unknown,
      ) => {
        if (view === 'task.byId' && (params as { taskId?: string } | undefined)?.taskId === 't1') {
          return new Promise((resolve) => {
            releaseFirst = resolve as (value: Task | null) => void
          })
        }
        return realQuery(view as never, params as never)
      }) as typeof kernel.store.query)

      try {
        render(<AiWorkflowPage />)
        act(() => pushOpenTarget({ appId: 'ai-workflow', taskId: 't1' }))
        act(() => pushOpenTarget({ appId: 'ai-workflow', taskId: 't2' }))

        // 后一条先落地：项目切到它所属的 p1
        await waitFor(() =>
          expect(screen.getByRole('button', { name: '项目：工作台' })).toHaveAttribute(
            'aria-current',
            'page',
          ),
        )

        // 迟到的第一条带着 p2 回来：seq 已经变了，这次结果必须被丢掉
        await act(async () => {
          releaseFirst({ ...task, projectId: 'p2' })
        })
        expect(screen.getByRole('button', { name: '项目：工作台' })).toHaveAttribute(
          'aria-current',
          'page',
        )
        expect(screen.getByRole('button', { name: '项目：另一个项目' })).not.toHaveAttribute(
          'aria-current',
          'page',
        )
      } finally {
        spy.mockRestore()
      }
    })

    it('落点会话不在本地清单里：仍切到聊天栏目，项目不动', async () => {
      seedBase()
      // 会话刚被别处删掉 / 清单还没取回来：找不到就只切栏目，别把项目也切走
      kernel.setView('conversations.all', undefined, [])
      render(<AiWorkflowPage />)

      act(() => pushOpenTarget({ appId: 'ai-workflow', conversationId: 'c-missing' }))

      await waitFor(() =>
        expect(screen.getByRole('button', { name: '聊天' })).toHaveAttribute(
          'aria-current',
          'page',
        ),
      )
      expect(screen.getByRole('button', { name: '项目：工作台' })).toHaveAttribute(
        'aria-current',
        'page',
      )
    })

    it('落点会话属于默认目录（projectId 为空）：项目回落到默认目录', async () => {
      seedBase()
      const orphan: Conversation = {
        ...conversation,
        id: 'c3',
        title: '默认目录里的对话',
        projectId: null,
      }
      kernel.setView('conversations.all', undefined, [orphan])
      kernel.setView('conversations.unassigned', undefined, [orphan])
      render(<AiWorkflowPage />)
      // 视图是异步取的：等会话清单就绪再点通知（真实点击发生在启动完成之后）
      await waitFor(() => expect(kernel.store.peek('conversations.all')).toEqual([orphan]))

      act(() => pushOpenTarget({ appId: 'ai-workflow', conversationId: 'c3' }))

      expect(await screen.findByRole('heading', { name: '默认目录里的对话' })).toBeInTheDocument()
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '默认目录' })).toHaveAttribute(
          'aria-current',
          'page',
        ),
      )
      expect(await screen.findByRole('heading', { name: '默认目录里的对话' })).toBeInTheDocument()
    })

    it('落点只有 appId（没有任务 / 会话）：只切回工作台视图', async () => {
      seedBase()
      const user = userEvent.setup()
      render(<AiWorkflowPage />)
      await openView(user, '设置')
      expect(await screen.findByRole('button', { name: '返回工作台' })).toBeInTheDocument()

      act(() => pushOpenTarget({ appId: 'ai-workflow' }))

      // 没有可定位的东西：能做的只有把人从设置带回工作台，页面不动
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: '设置' })).toBeInTheDocument(),
      )
      expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '返回工作台' })).not.toBeInTheDocument()
    })

    it('系统通知落点：任务归属查询失败也不崩，项目留在原处、不多弹错误条', async () => {
      seedBase()
      // 单次查询与详情页共用 `task.byId`：这条路径失败时详情页照实播报读错误（既有行为），
      // 但落点自己不能把「问项目归属失败」再挂一份到页面错误条上盖住内容
      kernel.failView('task.byId', { taskId: 't1' }, '归属查询失败')
      render(<AiWorkflowPage />)

      act(() => pushOpenTarget({ appId: 'ai-workflow', taskId: 't1', cardId: 'card-1' }))

      expect(await screen.findByRole('region', { name: '任务详情' })).toBeInTheDocument()
      // 只有详情页那一份：落点的 catch 吞掉查询失败，不往页面顶部加第二条
      expect(await screen.findAllByText('归属查询失败')).toHaveLength(1)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '项目：工作台' })).toHaveAttribute(
          'aria-current',
          'page',
        ),
      )
    })
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

  it('列内快速新建：标题 + 描述一起 dispatch task.create（带 stageId 与项目）', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(screen.getByRole('button', { name: '在「审核」阶段添加任务' }))
    await user.type(screen.getByLabelText('阶段「审核」的新任务标题'), '列内新任务')
    await user.type(screen.getByLabelText('阶段「审核」的新任务要求'), '把按钮改成绿色')
    await user.keyboard('{Control>}{Enter}{/Control}')

    await waitFor(() =>
      expectDispatched({
        type: 'task.create',
        input: {
          title: '列内新任务',
          description: '把按钮改成绿色',
          workflowId: 'w1',
          stageId: 's1',
          projectId: 'p1',
        },
      }),
    )
  })

  it('列内新建失败：列内与页面顶部各展示一份原因，输入保留', async () => {
    seedBase()
    dispatchWith(<C extends Command>(command: C): Promise<CommandDispatchResult<C>> =>
      command.type === 'task.create'
        ? Promise.reject(new Error('任务标题重复'))
        : Promise.resolve({ facts: [], value: null } as CommandDispatchResult<C>),
    )
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '在「审核」阶段添加任务' }))
    const input = screen.getByLabelText('阶段「审核」的新任务标题')
    await user.type(input, '重复任务{Enter}')

    expect(await screen.findAllByText('任务标题重复')).toHaveLength(2)
    expect(input).toHaveValue('重复任务')
  })

  it('删除线程后回到看板：线程页不残留「线程不存在」', async () => {
    seedBase()
    const threadedTask: Task = { ...task, threadId: 'th1' }
    kernel.setView('tasks.byProject', { projectId: 'p1' }, [threadedTask])
    kernel.setView(
      'thread.byId',
      { threadId: 'th1' },
      { thread, tasks: [threadedTask], sessions: {} },
    )
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '打开线程：任务A' }))
    await screen.findByRole('region', { name: '线程详情' })

    await user.click(screen.getByRole('button', { name: '删除线程' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '删除' }),
    )

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '线程详情' })).not.toBeInTheDocument(),
    )
    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
  })

  it('删除任务后回到看板：任务详情不残留「任务不存在」', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByLabelText('任务：任务A'))
    await screen.findByRole('region', { name: '任务详情' })

    await user.click(screen.getByRole('button', { name: '删除任务' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: '删除' }),
    )

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument(),
    )
    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
    expectDispatched({ type: 'task.remove', id: 't1' })
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
    await user.click(screen.getByRole('button', { name: '返回工作台' }))
    expect(await screen.findByText(/工作流「研发」/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '任务详情' })).not.toBeInTheDocument()
  })

  it('项目弹窗：编辑并保存 dispatch project.update，成功后关闭弹窗且侧栏跟随刷新', async () => {
    seedBase()
    dispatchWith(<C extends Command>(command: C): CommandDispatchResult<C> => {
      if (command.type === 'project.update') {
        kernel.setView('projects.all', undefined, [{ ...project, name: command.patch.name ?? '' }])
      }
      return { facts: [], value: null } as CommandDispatchResult<C>
    })
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '编辑项目 工作台' }))
    await user.clear(screen.getByLabelText('项目名称'))
    await user.type(screen.getByLabelText('项目名称'), '工作台v2')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() =>
      expectDispatched({
        type: 'project.update',
        id: 'p1',
        patch: expect.objectContaining({ name: '工作台v2' }),
      }),
    )
    // 成功即关弹窗（不再走 project.create 分支，也不会顺手切换选中项）
    await waitFor(() => expect(screen.queryByLabelText('项目名称')).not.toBeInTheDocument())
    expect(await screen.findByRole('button', { name: '项目：工作台v2' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('项目弹窗：新建返回空值时照常关闭弹窗，选中项不动', async () => {
    seedBase()
    // 默认 dispatch 返回 { value: null }：没有可用的新项目实体
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '+ 添加' }))
    await user.type(screen.getByLabelText('项目名称'), '无返回值')
    await user.type(screen.getByLabelText('文件夹路径'), 'D:\\Codes\\nowhere')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expectDispatched({ type: 'project.create' }))
    await waitFor(() => expect(screen.queryByLabelText('项目名称')).not.toBeInTheDocument())
    // 没有新 id 可选中：保持原有项目，不因为空值把选中项清掉
    expect(screen.getByRole('button', { name: '项目：工作台' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('项目弹窗：保存失败时文案同时挂到页面顶部错误条，弹窗保持可编辑', async () => {
    seedBase()
    dispatchWith(() => Promise.reject(new Error('项目改名失败')))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '编辑项目 工作台' }))
    await user.clear(screen.getByLabelText('项目名称'))
    await user.type(screen.getByLabelText('项目名称'), '改不动')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(async () => expect((await screen.findAllByText('项目改名失败')).length).toBe(2))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('项目名称')).toHaveValue('改不动')
  })

  it('项目弹窗：保存失败为非 Error 时按字符串展示（顶部与弹窗各一份）', async () => {
    seedBase()
    dispatchWith(() => Promise.reject('纯文本保存失败'))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '编辑项目 工作台' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(async () => expect((await screen.findAllByText('纯文本保存失败')).length).toBe(2))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('项目弹窗：删除项目成功后关闭弹窗，项目从侧栏消失', async () => {
    seedBase()
    dispatchWith(<C extends Command>(command: C): CommandDispatchResult<C> => {
      if (command.type === 'project.remove') {
        kernel.setView('projects.all', undefined, [])
      }
      return { facts: [], value: null } as CommandDispatchResult<C>
    })
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '编辑项目 工作台' }))
    await user.click(screen.getByRole('button', { name: '删除项目' }))

    await waitFor(() => expectDispatched({ type: 'project.remove', id: 'p1' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // 项目没了：回落默认目录（聊天与任务都还能用，不是空看板）
    expect(await screen.findByText('还没有项目，可先落到默认目录')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '默认目录' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '新建任务' })).toBeInTheDocument()
  })

  it('项目弹窗：删除失败为非 Error 时按字符串展示，弹窗不关', async () => {
    seedBase()
    dispatchWith(() => Promise.reject('纯文本删除失败'))
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '编辑项目 工作台' }))
    await user.click(screen.getByRole('button', { name: '删除项目' }))

    await waitFor(async () => expect((await screen.findAllByText('纯文本删除失败')).length).toBe(2))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // 弹窗开着时背景被 Radix 标成 aria-hidden，背景按钮不再是断言对象：
    // 这条用例断言的是「失败文案按字符串展示」且「弹窗不关」
    expect(within(screen.getByRole('dialog')).getByText('纯文本删除失败')).toBeInTheDocument()
  })

  it('项目弹窗：取消关闭弹窗且不发任何项目命令', async () => {
    seedBase()
    const user = userEvent.setup()
    render(<AiWorkflowPage />)
    await openTasks(user)

    await user.click(await screen.findByRole('button', { name: '+ 添加' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByLabelText('项目名称')).not.toBeInTheDocument()
    expect(kernel.dispatched.filter((command) => command.type.startsWith('project.'))).toHaveLength(
      0,
    )
  })
})

describe('cardLanding', () => {
  it('落点判定：任务卡优先、其次会话卡，都没有则没有落点', () => {
    expect(cardLanding({ ...card, taskId: 't1', conversationId: null })).toEqual({
      kind: 'task',
      taskId: 't1',
    })
    expect(cardLanding({ ...card, taskId: null, conversationId: 'c1' })).toEqual({
      kind: 'conversation',
      conversationId: 'c1',
    })
    // 既没有任务也没有会话：通知条那一行整行禁用，走不到落点
    expect(cardLanding({ ...card, taskId: null, conversationId: null })).toEqual({ kind: 'none' })
  })
})
