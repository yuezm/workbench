import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type {
  Agent,
  Run,
  Task,
  TaskInput,
  TaskMoveAction,
  WorkflowInput,
  WorkflowWithStages,
} from '../../../../shared/ai-workflow-api'
import { Panel, panelCls } from '../../components/ui/panel'
import { Segmented } from '../../components/ui/segmented'
import { Select } from '../../components/ui/select'
import { cn } from '../../lib/cn'
import { wfApi } from './api'
import { AgentManager } from './components/AgentManager'
import { KanbanBoard } from './components/KanbanBoard'
import { RunLog } from './components/RunLog'
import { RuntimeManager } from './components/RuntimeManager'
import { TaskDialog } from './components/TaskDialog'
import { WorkflowEditor } from './components/WorkflowEditor'
import { WorkflowManager } from './components/WorkflowManager'
import { WorkflowSwitcher } from './components/WorkflowSwitcher'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type View = 'board' | 'settings'

function SectionIcon({ path }: { path: string }): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  )
}

function SettingsSection({
  title,
  hint,
  icon,
  children,
}: {
  title: string
  hint: string
  icon: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <Panel className="animate-rise p-5">
      <header className="mb-4 flex items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-focus/15 text-focus">
          {icon}
        </span>
        <span className="flex flex-col leading-tight">
          <h2 className="text-[13px] font-medium tracking-wide text-ink">{title}</h2>
          <span className="text-[11px] text-ink-faint">{hint}</span>
        </span>
      </header>
      {children}
    </Panel>
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
  const [view, setView] = useState<View>('board')

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

  const move = (id: string, action: TaskMoveAction): void => {
    void (async () => {
      try {
        await wfApi().tasks.move(id, action)
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
    <div className="flex h-full flex-col">
      {/* 顶栏：标题 + 工作流切换 + 视图切换 */}
      <header className="flex shrink-0 items-center gap-4 border-b border-line bg-white/[0.02] px-6 py-3 backdrop-blur-xl">
        <h1 className="text-[15px] font-semibold tracking-wide text-ink">AI 工作流</h1>
        {view === 'board' && (
          <WorkflowSwitcher workflows={workflows} activeId={activeId} onSelect={setActiveId} />
        )}
        <div className="ml-auto">
          <Segmented
            value={view}
            onChange={setView}
            ariaLabel="视图切换"
            options={[
              { value: 'board', label: '工作台' },
              { value: 'settings', label: '设置' },
            ]}
          />
        </div>
      </header>

      {error && (
        <p className="mx-6 mt-4 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>
      )}

      {view === 'board' ? (
        <div className="flex min-h-0 flex-1 gap-4 p-6">
          <section className="flex min-w-0 flex-1 flex-col gap-3">
            {active ? (
              <KanbanBoard
                workflow={active}
                tasks={tasks}
                onMove={move}
                onNewTask={() => setDialogOpen(true)}
              />
            ) : (
              <div className="grid flex-1 place-items-center rounded-2xl border border-dashed border-line px-6 py-10 text-center text-sm text-ink-faint">
                尚无工作流。到「设置」里新建一条，再回来推进任务。
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
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
          <SettingsSection
            title="运行时"
            hint="本机执行的 CLI，智能体绑定到运行时"
            icon={<SectionIcon path="M4 5h16v4H4zM6 9v10h12V9M10 13h4" />}
          >
            <RuntimeManager />
          </SettingsSection>

          <SettingsSection
            title="智能体"
            hint="运行时 + 能力（System Prompt）"
            icon={
              <SectionIcon path="M12 3a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4 4 4 0 0 1-4-4V7a4 4 0 0 1 4-4ZM5 21a7 7 0 0 1 14 0z" />
            }
          >
            <AgentManager />
          </SettingsSection>

          <SettingsSection
            title="工作流"
            hint="阶段序列与流转规则"
            icon={<SectionIcon path="M4 6h6v5H4zM14 6h6v5h-6zM4 13h16v5H4z" />}
          >
            <WorkflowManager
              workflows={workflows}
              activeId={activeId}
              onSelect={setActiveId}
              onEdit={(w) => setEditing(w)}
              onNew={() => setEditing(null)}
            />
            {editing !== undefined && (
              <div className="mt-4">
                <WorkflowEditor
                  workflow={editing}
                  agents={agents}
                  onSave={save}
                  onCancel={() => setEditing(undefined)}
                />
              </div>
            )}
          </SettingsSection>
        </div>
      )}

      {dialogOpen && activeId && (
        <TaskDialog
          workflowId={activeId}
          onSave={createTask}
          onCancel={() => setDialogOpen(false)}
        />
      )}
    </div>
  )
}
