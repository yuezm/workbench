import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  Agent,
  Run,
  Task,
  TaskInput,
  WorkflowInput,
  WorkflowWithStages,
} from '../../../../shared/ai-workflow-api'
import { Dialog } from '../../components/ui/dialog'
import { panelCls } from '../../components/ui/panel'
import { Segmented } from '../../components/ui/segmented'
import { Select } from '../../components/ui/select'
import { cn } from '../../lib/cn'
import { wfApi } from './api'
import { AgentManager } from './components/AgentManager'
import { ChatPanel } from './components/ChatPanel'
import { ConversationList } from './components/ConversationList'
import { KanbanBoard } from './components/KanbanBoard'
import { RunLog } from './components/RunLog'
import { RuntimeManager } from './components/RuntimeManager'
import { SettingsNav, type SettingsSection } from './components/SettingsNav'
import { TaskDialog } from './components/TaskDialog'
import { WorkflowEditor } from './components/WorkflowEditor'
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

export function AiWorkflowPage(): ReactElement {
  const [workflows, setWorkflows] = useState<WorkflowWithStages[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<WorkflowWithStages | null | undefined>(undefined)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>()
  const [runs, setRuns] = useState<Run[]>([])
  const [view, setView] = useState<View>('workspace')
  /** 工作台侧栏栏目：聊天（主动对话）/ 任务（看板与运行记录） */
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>('chat')
  const [section, setSection] = useState<SettingsSection>('runtimes')
  /** 聊天状态机：侧栏（会话清单）与内容区（消息流）共用同一份 */
  const chat = useChat(agents)

  const loadRunsFor = async (taskId: string | undefined): Promise<void> => {
    if (!taskId) {
      setRuns([])
      return
    }
    try {
      setRuns(await wfApi().runs.listByTask(taskId))
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const loadTasksFor = async (id: string): Promise<void> => {
    try {
      setTasks(await wfApi().tasks.list(id))
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [w, a, t] = await Promise.all([
        wfApi().workflows.list(),
        wfApi().agents.list(),
        wfApi().tasks.list(activeId ?? ''),
      ])
      setWorkflows(w)
      setAgents(a)
      setTasks(t)
      setActiveId((prev) => (prev && w.some((x) => x.id === prev) ? prev : w[0]?.id))
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [activeId])

  // 用 ref 持有最新的 reload：onChanged 订阅只建立一次，但回调必须看到最新 activeId，
  // 否则外部变更（如 run 完成）会用初始的 undefined 去拉任务，把看板清空。
  const reloadRef = useRef(reload)
  useEffect(() => {
    reloadRef.current = reload
  }, [reload])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [w, a] = await Promise.all([wfApi().workflows.list(), wfApi().agents.list()])
        if (!alive) return
        setWorkflows(w)
        setAgents(a)
        setActiveId(w[0]?.id)
      } catch (e) {
        if (alive) setError(errMsg(e))
      }
    })()
    const off = wfApi().onChanged(() => void reloadRef.current())
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    let alive = true
    const run = async (): Promise<void> => {
      if (!activeId) {
        if (alive) setTasks([])
        return
      }
      try {
        const t = await wfApi().tasks.list(activeId)
        if (alive) setTasks(t)
      } catch (e) {
        if (alive) setError(errMsg(e))
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [activeId])

  useEffect(() => {
    let alive = true
    const run = async (): Promise<void> => {
      if (!selectedTaskId) {
        if (alive) setRuns([])
        return
      }
      try {
        const r = await wfApi().runs.listByTask(selectedTaskId)
        if (alive) setRuns(r)
      } catch (e) {
        if (alive) setError(errMsg(e))
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [selectedTaskId])

  const save = async (input: WorkflowInput): Promise<void> => {
    try {
      let targetId = editing ? editing.id : (activeId ?? '')
      if (editing) {
        await wfApi().workflows.update(editing.id, input)
      } else {
        const created = await wfApi().workflows.create(input)
        targetId = created.id
        setActiveId(created.id)
      }
      await reload()
      await loadTasksFor(targetId)
      await loadRunsFor(selectedTaskId)
      setEditing(undefined)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const moveToStage = (id: string, stageId: string): void => {
    void (async () => {
      try {
        await wfApi().tasks.moveToStage(id, stageId)
        await loadTasksFor(activeId ?? '')
        await loadRunsFor(selectedTaskId)
      } catch (e) {
        setError(errMsg(e))
      }
    })()
  }

  const completeTask = (id: string): void => {
    void (async () => {
      try {
        await wfApi().tasks.complete(id)
        await loadTasksFor(activeId ?? '')
        await loadRunsFor(selectedTaskId)
      } catch (e) {
        setError(errMsg(e))
      }
    })()
  }

  const createTask = async (input: TaskInput): Promise<void> => {
    try {
      await wfApi().tasks.create(input)
      await loadTasksFor(activeId ?? '')
      await loadRunsFor(selectedTaskId)
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
                  onSelect={setActiveId}
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
        {error && editing === undefined && (
          <p className="mx-4 mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
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
                <WorkflowManager
                  workflows={workflows}
                  activeId={activeId}
                  onSelect={setActiveId}
                  onEdit={(w) => setEditing(w)}
                  onNew={() => setEditing(null)}
                />
              </>
            )}
          </div>
        )}
      </main>

      {dialogOpen && active && (
        <TaskDialog workflow={active} onSave={createTask} onCancel={() => setDialogOpen(false)} />
      )}

      {editing !== undefined && (
        <Dialog onClose={() => setEditing(undefined)} className="max-w-3xl">
          {error && (
            <p className="mb-3 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}
          <WorkflowEditor
            workflow={editing}
            agents={agents}
            onSave={save}
            onCancel={() => setEditing(undefined)}
          />
        </Dialog>
      )}
    </div>
  )
}
