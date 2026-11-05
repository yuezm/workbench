import { useState, type ReactElement } from 'react'
import type { TaskInput } from '../../../../protocol/entities'
import { panelCls } from '../../components/ui/panel'
import { Segmented } from '../../components/ui/segmented'
import { Select } from '../../components/ui/select'
import { cn } from '../../lib/cn'
import { getKernelStore } from '../../shell/kernelStore'
import { useKernelView, useKernelViewState } from '../../shell/useKernelView'
import { ApprovalBar } from './components/ApprovalBar'
import { AgentManager } from './components/AgentManager'
import { ChatPanel } from './components/ChatPanel'
import { ConversationList } from './components/ConversationList'
import { KanbanBoard } from './components/KanbanBoard'
import { RunLog } from './components/RunLog'
import { RulesManager } from './components/RulesManager'
import { RuntimeManager } from './components/RuntimeManager'
import { SettingsNav, type SettingsSection } from './components/SettingsNav'
import { TaskDialog } from './components/TaskDialog'
import { WorkflowManager } from './components/WorkflowManager'
import { WorkflowSwitcher } from './components/WorkflowSwitcher'
import { WorkspaceNav, type WorkspaceSection } from './components/WorkspaceNav'
import { useChat } from './hooks/useChat'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 两个互斥视图：工作台与设置 */
type View = 'workspace' | 'settings'

/** 设置区页头：标题 + 一句话说明 */
function SectionHeader({ title, hint }: { title: string; hint: string }): ReactElement {
  return (
    <header className="mb-4 flex flex-col gap-0.5">
      <h2 className="text-[15px] font-semibold tracking-wide text-ink">{title}</h2>
      <span className="text-xs text-ink-faint">{hint}</span>
    </header>
  )
}

/**
 * ai-workflow 工作台（M5 视图化）。
 *
 * - 读：全部走 `useKernelView`（工作流 / 智能体 / 任务 / 运行记录 / 审批条 / 聊天），
 *   未就绪按空态处理；事实到达后视图自动重取，没有 reload 链与变更订阅。
 * - 写：全部走 `getKernelStore().dispatch`，失败沿用原有文案展示。
 * - 选中项（当前工作流 / 运行记录的任务）仍是 UI 本地状态。
 */
export function AiWorkflowPage(): ReactElement {
  const workflowsState = useKernelViewState('workflows.all')
  const workflows = workflowsState.data ?? []
  const agents = useKernelView('agents.all') ?? []
  /** 用户选中的工作流：失效（被删/清空）时回落到首个，首个由视图数据派生，不需要 effect */
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const activeId =
    selectedId !== undefined && workflows.some((w) => w.id === selectedId)
      ? selectedId
      : workflows[0]?.id
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>()
  const [view, setView] = useState<View>('workspace')
  /** 工作台侧栏栏目：聊天（主动对话）/ 任务（看板与运行记录） */
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>('chat')
  const [section, setSection] = useState<SettingsSection>('runtimes')
  /** 聊天状态机：侧栏（会话清单）与内容区（消息流）共用同一份 */
  const chat = useChat(agents)

  const tasksState = useKernelViewState(
    'tasks.byWorkflow',
    activeId ? { workflowId: activeId } : null,
  )
  const tasks = tasksState.data ?? []
  const runsState = useKernelViewState(
    'runs.byTask',
    selectedTaskId ? { taskId: selectedTaskId } : null,
  )
  const runs = runsState.data ?? []
  /** 写命令失败优先；否则展示读视图的错误（视图查询失败时 store 会给出文案） */
  const shownError = error ?? workflowsState.error ?? tasksState.error ?? runsState.error

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

  const createTask = async (input: TaskInput): Promise<void> => {
    try {
      await getKernelStore().dispatch({ type: 'task.create', commandId: '', input })
      setError(null)
      setDialogOpen(false)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const active = workflows.find((w) => w.id === activeId)

  return (
    // 两栏：单列侧栏（w-64）+ 内容区，吃满 shell 顶部栏以下的高度
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-white/[0.02]">
        {/* 应用标识：顶部栏只显示 app 标签，进到 app 内用次级标题交代当前所在 */}
        <h2 className="shrink-0 px-4 pt-3.5 pb-1 text-[13px] font-semibold tracking-wide text-ink">
          AI 工作流
        </h2>
        {view === 'workspace' ? (
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <WorkspaceNav value={workspaceSection} onChange={setWorkspaceSection}>
              {workspaceSection === 'chat' ? (
                <ConversationList
                  agents={agents}
                  agentId={chat.agentId}
                  onAgentChange={chat.setAgentId}
                  conversations={chat.conversations}
                  activeId={chat.activeId}
                  onSelect={chat.selectConversation}
                  onCreate={() => void chat.createConversation()}
                  onRemove={(id) => void chat.removeConversation(id)}
                  creating={chat.creating}
                />
              ) : (
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
            onChange={setView}
            ariaLabel="视图切换"
            options={[
              { value: 'workspace', label: '工作台' },
              { value: 'settings', label: '设置' },
            ]}
          />
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* 顶部待审批条：有 open 卡才渲染；回答走 card.answer 命令 */}
        <ApprovalBar />

        {shownError && (
          <p className="mx-4 mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {shownError}
          </p>
        )}

        {view === 'workspace' && workspaceSection === 'chat' && (
          <ChatPanel
            agents={agents}
            conversation={chat.active}
            messages={chat.messages}
            streaming={chat.streaming}
            sending={chat.sending}
            error={chat.error}
            onSend={chat.sendMessage}
            onCancel={() => void chat.cancelRun()}
          />
        )}

        {view === 'workspace' && workspaceSection === 'tasks' && (
          <div className="flex min-h-0 flex-1 gap-4 p-6">
            <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              {active ? (
                <KanbanBoard
                  workflow={active}
                  tasks={tasks}
                  onMoveToStage={moveToStage}
                  onCompleteTask={completeTask}
                  onNewTask={() => setDialogOpen(true)}
                />
              ) : (
                <div className="grid flex-1 place-items-center rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-ink-faint">
                  尚无工作流。到「设置」里的「工作流配置」新建一条，再回来建任务并拖拽推进。
                </div>
              )}
            </section>

            <aside
              className={cn(
                panelCls,
                'flex w-80 shrink-0 flex-col gap-3 overflow-hidden bg-white/[0.02] p-4',
              )}
            >
              <h2 className="text-[13px] font-medium tracking-wide text-ink">运行记录</h2>
              <Select
                ariaLabel="选择任务查看运行"
                value={selectedTaskId ?? ''}
                onChange={(v) => setSelectedTaskId(v || undefined)}
                options={[
                  { value: '', label: '（选择任务）' },
                  ...tasks.map((t) => ({ value: t.id, label: t.title })),
                ]}
              />
              <div className="min-h-0 flex-1 overflow-auto pr-1">
                <RunLog runs={runs} />
              </div>
            </aside>
          </div>
        )}

        {view === 'settings' && (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
            {section === 'runtimes' && (
              <>
                <SectionHeader title="运行时" hint="本机执行的 CLI，智能体绑定到运行时" />
                <RuntimeManager />
              </>
            )}

            {section === 'agents' && (
              <>
                <SectionHeader title="智能体" hint="运行时 + 能力（System Prompt）" />
                <AgentManager />
              </>
            )}

            {section === 'workflows' && (
              <>
                <SectionHeader title="工作流" hint="阶段序列与流转规则" />
                <WorkflowManager />
              </>
            )}

            {section === 'rules' && (
              <>
                <SectionHeader title="规则" hint="事件或定时条件自动建任务" />
                <RulesManager />
              </>
            )}
          </div>
        )}
      </main>

      {dialogOpen && active && (
        <TaskDialog workflow={active} onSave={createTask} onCancel={() => setDialogOpen(false)} />
      )}
    </div>
  )
}
