import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  Agent,
  Run,
  Task,
  TaskInput,
  TaskMoveAction,
  WorkflowInput,
  WorkflowWithStages,
} from '../../../../shared/ai-workflow-api'
import { wfApi } from './api'
import { AgentManager } from './components/AgentManager'
import { KanbanBoard } from './components/KanbanBoard'
import { RunLog } from './components/RunLog'
import { RuntimeManager } from './components/RuntimeManager'
import { TaskDialog } from './components/TaskDialog'
import { WorkflowEditor } from './components/WorkflowEditor'
import { WorkflowSwitcher } from './components/WorkflowSwitcher'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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

  const loadTasksFor = async (id: string | undefined): Promise<void> => {
    if (!id) {
      setTasks([])
      return
    }
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
      let targetId = activeId
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
        await loadTasksFor(activeId)
        await loadRunsFor(selectedTaskId)
      } catch (e) {
        setError(errMsg(e))
      }
    })()
  }

  const createTask = async (input: TaskInput): Promise<void> => {
    try {
      await wfApi().tasks.create(input)
      await loadTasksFor(activeId)
      await loadRunsFor(selectedTaskId)
      setDialogOpen(false)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const active = workflows.find((w) => w.id === activeId)

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">AI 工作流</h1>
          <p className="mt-1 text-sm text-ink-dim">配置运行时与智能体，用看板推进多阶段工作流。</p>
        </div>
        <WorkflowSwitcher
          workflows={workflows}
          activeId={activeId}
          onSelect={setActiveId}
          onNew={() => setEditing(null)}
          onEdit={() => setEditing(active ?? null)}
        />
      </header>

      {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>}

      <details open className="rounded-2xl border border-line bg-white/[0.02] p-4">
        <summary className="cursor-pointer text-sm font-medium text-ink">运行时</summary>
        <div className="mt-3">
          <RuntimeManager />
        </div>
      </details>

      <details className="rounded-2xl border border-line bg-white/[0.02] p-4">
        <summary className="cursor-pointer text-sm font-medium text-ink">智能体</summary>
        <div className="mt-3">
          <AgentManager />
        </div>
      </details>

      {editing !== undefined ? (
        <WorkflowEditor
          workflow={editing}
          agents={agents}
          onSave={save}
          onCancel={() => setEditing(undefined)}
        />
      ) : active ? (
        <KanbanBoard
          workflow={active}
          tasks={tasks}
          onMove={move}
          onNewTask={() => setDialogOpen(true)}
        />
      ) : (
        <div className="grid flex-1 place-items-center rounded-2xl border border-line bg-white/[0.02] px-6 py-10 text-center text-sm text-ink-faint">
          尚无工作流。点击「新建工作流」开始。
        </div>
      )}

      {active && (
        <details className="rounded-2xl border border-line bg-white/[0.02] p-4">
          <summary className="cursor-pointer text-sm font-medium text-ink">运行记录</summary>
          <div className="mt-3 flex flex-col gap-2">
            <select
              aria-label="选择任务查看运行"
              className="rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5 text-sm text-ink outline-none focus:border-focus"
              value={selectedTaskId ?? ''}
              onChange={(e) => setSelectedTaskId(e.target.value || undefined)}
            >
              <option value="">（选择任务）</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <RunLog runs={runs} />
          </div>
        </details>
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
