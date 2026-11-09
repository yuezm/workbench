import { useEffect, useState, type ReactElement } from 'react'
import type { Card, Project, ProjectInput, TaskInput } from '../../../../protocol/entities'
import { FormError } from '../../components/ui/form-error'
import { Segmented } from '../../components/ui/segmented'
import { getKernelStore } from '../../shell/kernelStore'
import { useKernelViewState } from '../../shell/useKernelView'
import { ApprovalBar } from './components/ApprovalBar'
import { AgentManager } from './components/AgentManager'
import { ChatPanel } from './components/ChatPanel'
import { ConversationList } from './components/ConversationList'
import { KanbanBoard } from './components/KanbanBoard'
import { PluginsManager } from './components/PluginsManager'
import { ProjectDialog } from './components/ProjectDialog'
import { DEFAULT_PROJECT_ID, ProjectSwitcher } from './components/ProjectSwitcher'
import { RulesManager } from './components/RulesManager'
import { RuntimeManager } from './components/RuntimeManager'
import { SettingsNav, type SettingsSection } from './components/SettingsNav'
import { TaskDetailPage } from './components/TaskDetailPage'
import { TaskDialog } from './components/TaskDialog'
import { ThreadDetailPage } from './components/ThreadDetailPage'
import { WorkflowManager } from './components/WorkflowManager'
import { WorkflowSwitcher } from './components/WorkflowSwitcher'
import { WorkspaceNav, type WorkspaceSection } from './components/WorkspaceNav'
import { useChat } from './hooks/useChat'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 两个互斥视图：工作台与设置 */
type View = 'workspace' | 'settings'

/**
 * 任务栏的二级页面：栈式路由（看板 → 任务详情 → 线程详情 → 任务详情 …）。
 * 详情是页面不是弹窗：内容区整块让给详情，返回即出栈；栈空即看板。
 */
type TaskRoute = { kind: 'task'; taskId: string } | { kind: 'thread'; threadId: string }

/**
 * 卡片的落点：挂任务的卡进任务详情，聊天卡进对应会话；
 * 两者都没有则没有落点（通知条那一行会整行禁用，走不到那里）。
 */
export type CardLanding =
  | { kind: 'task'; taskId: string }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'none' }

/** 落点判定（纯函数）：任务卡优先，其次会话卡，都没有就没有落点 */
export function cardLanding(card: Card): CardLanding {
  if (card.taskId !== null) return { kind: 'task', taskId: card.taskId }
  if (card.conversationId !== null) {
    return { kind: 'conversation', conversationId: card.conversationId }
  }
  return { kind: 'none' }
}

/** 设置区页头：标题 + 一句话说明 */
function SectionHeader({ title, hint }: { title: string; hint: string }): ReactElement {
  return (
    <header className="mb-4 flex flex-col gap-0.5">
      <h2 className="text-page font-semibold text-ink">{title}</h2>
      <span className="text-meta text-ink-faint">{hint}</span>
    </header>
  )
}

/**
 * ai-workflow 工作台（M5 视图化）。
 *
 * - 读：全部走 `useKernelViewState`（项目 / 工作流 / 智能体 / 任务 / 运行记录 / 审批条 / 聊天），
 *   未就绪按空态处理；事实到达后视图自动重取，没有 reload 链与变更订阅。
 * - 写：全部走 `getKernelStore().dispatch`，失败沿用原有文案展示。
 * - 选中项（当前项目 / 当前工作流 / 任务栏的详情路由）仍是 UI 本地状态。
 *
 * M11：项目提到工作台顶层——聊天与任务都落在项目上，侧栏顶部常驻项目切换器；
 * 没有项目时落「默认目录」（宿主的 `~/.workbench` / `WORKBENCH_WORKDIR`，数据侧
 * `projectId = null`）。切换项目会同时换掉会话清单与看板，因此详情栈不跨项目保留。
 */
export function AiWorkflowPage(): ReactElement {
  const workflowsState = useKernelViewState('workflows.all')
  const workflows = workflowsState.data ?? []
  /**
   * 页面依赖的清单一律走 `useKernelViewState`（而不是只看 `.data` 的 `useKernelView`）：
   * 读失败时 `.data` 只是 `undefined`，界面会退化成「还没有项目 / 尚无工作流」这类空态，
   * 骗用户去重建一遍。错误必须进页面级错误条，见下面的 `readError`。
   */
  const agentsState = useKernelViewState('agents.all')
  const agents = agentsState.data ?? []
  /** 项目（M10）：聊天与任务共用的顶层上下文 */
  const projectsState = useKernelViewState('projects.all')
  const projects = projectsState.data ?? []
  /** 默认目录任务（`projectId = null`）：老数据、老规则建的任务与「默认目录」下的新任务 */
  const unassignedState = useKernelViewState('tasks.unassigned')
  const unassigned = unassignedState.data ?? []
  /** 默认目录的绝对路径（宿主视图）：切换器与新建任务弹窗都要交代「落在哪个文件夹」 */
  const defaultPathState = useKernelViewState('runtimes.default-workdir')
  const defaultPath = defaultPathState.data ?? ''
  /**
   * 选中的目标：项目 id / `DEFAULT_PROJECT_ID` / undefined（还没选）。
   * 失效（被删 / 还没选）时回落：第一个项目，其次是默认目录，回落值都由视图派生。
   */
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>()
  /** 选了「默认目录」= 没有项目文件夹，任务与聊天都按 `projectId = null` 落库 */
  const defaultSelected = selectedProjectId === DEFAULT_PROJECT_ID
  const activeProject = defaultSelected
    ? undefined
    : (projects.find((project) => project.id === selectedProjectId) ?? projects[0])
  /** 头部与弹窗里交代当前落点 */
  const activeProjectName = activeProject?.name ?? '默认目录'
  /** 用户选中的工作流：失效（被删/清空）时回落到首个，首个由视图数据派生，不需要 effect */
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const activeId =
    selectedId !== undefined && workflows.some((w) => w.id === selectedId)
      ? selectedId
      : workflows[0]?.id
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  /** 项目弹窗：`null` = 关闭，`{}` = 新建，`{ project }` = 编辑 */
  const [projectDialog, setProjectDialog] = useState<{ project?: Project } | null>(null)
  /** 任务栏的详情路由栈：栈顶是当前页面，`[]` = 看板 */
  const [trail, setTrail] = useState<TaskRoute[]>([])
  const [view, setView] = useState<View>('workspace')
  /** 工作台侧栏栏目：聊天（主动对话）/ 任务（看板与任务详情） */
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>('chat')
  const [section, setSection] = useState<SettingsSection>('runtimes')
  /**
   * 聊天状态机：侧栏（会话清单）与内容区（消息流）共用同一份。
   * 项目是聊天的顶层上下文（M11）：`null` = 默认目录，会话清单按它取。
   */
  const chat = useChat(agents, activeProject?.id ?? null)

  /**
   * 任务视图按项目取（M10）：`tasks.byProject` 是项目下全部工作流的任务，
   * 看板自己再按工作流过滤。默认目录不订阅项目视图（那批任务走 `tasks.unassigned`）。
   */
  const tasksState = useKernelViewState(
    'tasks.byProject',
    activeProject ? { projectId: activeProject.id } : null,
  )
  const tasks = activeProject === undefined ? unassigned : (tasksState.data ?? [])
  /** 全部 open 卡：顶部通知条只列标题，卡片本体在任务详情 / 会话里处理 */
  const cardsState = useKernelViewState('cards.open')
  const openCards = cardsState.data ?? []
  /**
   * 全部会话（跨项目）：卡片只带 `conversationId`，点通知条时靠它找到会话所属项目，
   * 否则切到聊天栏目后会落到当前项目的清单里、看不到那张卡。
   */
  const conversationsState = useKernelViewState('conversations.all')
  const allConversations = conversationsState.data ?? []
  /**
   * 写命令失败优先；否则展示读视图的错误（视图查询失败时 store 会给出文案）。
   *
   * 用 `find` 而不是一长串 `??`：链条里少写一个视图就少一处静默失败，而这里每个视图都登记在册。
   */
  const readError =
    [
      workflowsState.error,
      tasksState.error,
      cardsState.error,
      agentsState.error,
      projectsState.error,
      unassignedState.error,
      defaultPathState.error,
      conversationsState.error,
    ].find((message) => message !== null) ?? null
  const shownError = error ?? readError

  const route = trail.length > 0 ? trail[trail.length - 1] : undefined

  const openTask = (taskId: string): void => {
    setTrail((current) => [...current, { kind: 'task', taskId }])
  }

  const openThread = (threadId: string): void => {
    setTrail((current) => [...current, { kind: 'thread', threadId }])
  }

  /**
   * 点顶部通知条：把人送到卡片所在的地方去处理。
   * 任务卡进任务详情（正文与选项在页面里）；聊天卡切到聊天栏目、把项目切到会话所属项目，
   * 再选中那个会话。没有落点（卡既没任务也没会话）时通知条整行禁用，走不到这里。
   */
  const openCard = (card: Card): void => {
    setView('workspace')
    // 落点判定在纯函数里（cardLanding）：没有落点的卡通知条整行禁用，走不到这里
    const landing = cardLanding(card)
    switch (landing.kind) {
      case 'task':
        setWorkspaceSection('tasks')
        setTrail([{ kind: 'task', taskId: landing.taskId }])
        break
      case 'conversation': {
        // 会话清单按项目取（M11）：跨项目的卡要先换项目，否则选中项会被过滤掉
        const target = allConversations.find((item) => item.id === landing.conversationId)
        if (target !== undefined) {
          setSelectedProjectId(target.projectId ?? DEFAULT_PROJECT_ID)
          setTrail([])
        }
        setWorkspaceSection('chat')
        chat.selectConversation(landing.conversationId)
        break
      }
    }
  }

  const back = (): void => {
    setTrail((current) => current.slice(0, -1))
  }

  /** 切换栏目 / 视图都回到看板：详情栈不跨栏目保留，避免回来时停在别人家的页面 */
  const changeWorkspaceSection = (next: WorkspaceSection): void => {
    if (next !== 'tasks') setTrail([])
    setWorkspaceSection(next)
  }

  const changeView = (next: View): void => {
    if (next !== 'workspace') setTrail([])
    setView(next)
  }

  /** 换项目 = 换一批任务与会话：详情栈不跨项目保留（同切换栏目的理由） */
  const selectProject = (id: string): void => {
    setSelectedProjectId(id)
    setTrail([])
  }

  /** Esc 返回上一级：只在详情页生效，新建任务弹窗自己处理 Esc */
  useEffect(() => {
    if (route === undefined || dialogOpen) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setTrail((current) => current.slice(0, -1))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [route, dialogOpen])

  const moveToStage = (id: string, stageId: string): void => {
    void (async () => {
      try {
        await getKernelStore().dispatch({ type: 'task.move', commandId: '', id, stageId })
        setError(null)
      } catch (e) {
        setError(errMsg(e))
      }
    })()
  }

  const completeTask = (id: string): void => {
    void (async () => {
      try {
        await getKernelStore().dispatch({ type: 'task.complete', commandId: '', id })
        setError(null)
      } catch (e) {
        setError(errMsg(e))
      }
    })()
  }

  /**
   * 新建任务：失败时既要挂页面顶部错误条，也要把错误抛回弹窗（`TaskDialog` 就地展示）。
   * 只 `setError` 不抛的话，弹窗里看不到任何原因，用户只会觉得「点了没反应」。
   */
  const createTask = async (input: TaskInput): Promise<void> => {
    try {
      await getKernelStore().dispatch({ type: 'task.create', commandId: '', input })
      setError(null)
      setDialogOpen(false)
    } catch (e) {
      setError(errMsg(e))
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /**
   * 保存项目（新建 / 更新）：失败时把文案挂到页面顶部错误条，并向上抛给弹窗就地展示，
   * 弹窗保持可编辑（用户不用重填名字和路径）。
   * 新建成功后直接用返回值选中它——新项目下还没有任务，回落规则会把它排到最后。
   */
  const saveProject = async (input: ProjectInput, id?: string): Promise<void> => {
    try {
      if (id === undefined) {
        const result = await getKernelStore().dispatch({
          type: 'project.create',
          commandId: '',
          input,
        })
        if (result.value !== null) setSelectedProjectId(result.value.id)
      } else {
        await getKernelStore().dispatch({ type: 'project.update', commandId: '', id, patch: input })
      }
      setError(null)
      setProjectDialog(null)
    } catch (e) {
      setError(errMsg(e))
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /** 删除项目：项目下有执行中的任务时内核拒绝，文案同样走页面顶部错误条 */
  const removeProject = async (id: string): Promise<void> => {
    try {
      await getKernelStore().dispatch({ type: 'project.remove', commandId: '', id })
      setError(null)
      setProjectDialog(null)
    } catch (e) {
      setError(errMsg(e))
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  const active = workflows.find((w) => w.id === activeId)

  return (
    // 两栏：单列侧栏（w-64）+ 内容区，吃满 shell 顶部栏以下的高度
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface/60">
        {/* 应用标识：顶部栏只显示 app 标签，进到 app 内用次级标题交代当前所在 */}
        <h2 className="shrink-0 px-4 pt-3.5 pb-1 text-title font-medium text-ink">AI 工作流</h2>
        {view === 'workspace' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
            {/* 项目在最顶层：聊天与任务都落在项目上，切栏目不换项目 */}
            <ProjectSwitcher
              projects={projects}
              activeId={activeProject?.id ?? DEFAULT_PROJECT_ID}
              defaultPath={defaultPath}
              onSelect={selectProject}
              onCreate={() => setProjectDialog({})}
              onEdit={(project) => setProjectDialog({ project })}
            />
            <WorkspaceNav value={workspaceSection} onChange={changeWorkspaceSection}>
              {workspaceSection === 'chat' ? (
                <ConversationList
                  agents={agents}
                  agentId={chat.agentId}
                  onAgentChange={chat.setAgentId}
                  conversations={chat.conversations}
                  archived={chat.archivedConversations}
                  activeId={chat.activeId}
                  onSelect={chat.selectConversation}
                  onCreate={() => void chat.createConversation()}
                  onRemove={(id) => void chat.removeConversation(id)}
                  onArchive={(id, archived) => void chat.archiveConversation(id, archived)}
                  creating={chat.creating}
                />
              ) : (
                // 工作流在项目下面：先定「在哪个文件夹干活」，再定「按哪套流程」
                <WorkflowSwitcher
                  workflows={workflows}
                  activeId={activeId}
                  onSelect={setSelectedId}
                />
              )}
            </WorkspaceNav>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <SettingsNav value={section} onChange={setSection} />
          </div>
        )}

        <div className="border-t border-line p-3">
          <Segmented
            value={view}
            onChange={changeView}
            ariaLabel="视图切换"
            options={[
              { value: 'workspace', label: '工作台' },
              { value: 'settings', label: '设置' },
            ]}
          />
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* 顶部通知条：只列 open 卡标题，点击进任务详情 / 会话处理 */}
        <ApprovalBar cards={openCards} onOpen={openCard} />

        {/* 页面级错误条：写命令失败可关掉；读视图错误说明数据没取到，不给关 */}
        <FormError
          message={shownError}
          className="mx-4 mt-3"
          onDismiss={error === null ? undefined : () => setError(null)}
        />

        {view === 'workspace' && workspaceSection === 'chat' && (
          <ChatPanel
            agents={agents}
            conversation={chat.active}
            projectName={activeProjectName}
            messages={chat.messages}
            cards={openCards.filter(
              (card) => chat.activeId !== null && card.conversationId === chat.activeId,
            )}
            streaming={chat.streaming}
            sending={chat.sending}
            error={chat.error}
            onSend={chat.sendMessage}
            onCancel={() => void chat.cancelRun()}
          />
        )}

        {view === 'workspace' &&
          workspaceSection === 'tasks' &&
          (route === undefined ? (
            <div className="flex min-h-0 flex-1 p-6">
              <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                {active ? (
                  // 任务可以建在当前项目，也可以落在默认目录：新建入口始终在
                  <KanbanBoard
                    workflow={active}
                    tasks={tasks}
                    onMoveToStage={moveToStage}
                    onCompleteTask={completeTask}
                    onNewTask={() => setDialogOpen(true)}
                    onOpenTask={(task) => openTask(task.id)}
                    onOpenThread={openThread}
                  />
                ) : (
                  <div className="grid flex-1 place-items-center rounded-xl border border-dashed border-line px-6 py-10 text-center text-body text-ink-faint">
                    尚无工作流，到「设置 → 工作流」新建。
                  </div>
                )}
              </section>
            </div>
          ) : route.kind === 'task' ? (
            <TaskDetailPage
              taskId={route.taskId}
              workflows={workflows}
              onBack={back}
              onOpenThread={openThread}
              onOpenTask={openTask}
            />
          ) : (
            <ThreadDetailPage threadId={route.threadId} onBack={back} onOpenTask={openTask} />
          ))}

        {view === 'settings' && (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
            {section === 'runtimes' && (
              <>
                <SectionHeader title="运行时" hint="本机 CLI" />
                <RuntimeManager />
              </>
            )}

            {section === 'agents' && (
              <>
                <SectionHeader title="智能体" hint="运行时 + 提示词" />
                <AgentManager />
              </>
            )}

            {section === 'workflows' && (
              <>
                <SectionHeader title="工作流" hint="阶段与流转" />
                <WorkflowManager />
              </>
            )}

            {section === 'rules' && (
              <>
                <SectionHeader title="规则" hint="条件自动建任务" />
                <RulesManager />
              </>
            )}

            {section === 'plugins' && (
              <>
                <SectionHeader title="插件" hint="外部能力与授权" />
                <PluginsManager />
              </>
            )}
          </div>
        )}
      </main>

      {dialogOpen && active && (
        <TaskDialog
          workflow={active}
          // 默认目录不传 project：弹窗只读展示落点路径
          project={activeProject}
          defaultPath={defaultPath}
          onSave={createTask}
          onCancel={() => setDialogOpen(false)}
        />
      )}

      {projectDialog !== null && (
        <ProjectDialog
          project={projectDialog.project}
          onSave={saveProject}
          // 新建的项目没有可删的东西：只有编辑态给「删除项目」
          onRemove={projectDialog.project === undefined ? undefined : removeProject}
          onCancel={() => setProjectDialog(null)}
        />
      )}
    </div>
  )
}
