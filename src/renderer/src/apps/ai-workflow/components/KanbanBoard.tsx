import type { ReactElement } from 'react'
import type {
  Task,
  TaskMoveAction,
  WorkflowWithStages,
} from '../../../../../shared/ai-workflow-api'
import { TaskCard } from './TaskCard'

interface KanbanBoardProps {
  workflow: WorkflowWithStages
  tasks: Task[]
  onMove: (taskId: string, action: TaskMoveAction) => void
  onNewTask: () => void
}

export function KanbanBoard({
  workflow,
  tasks,
  onMove,
  onNewTask,
}: KanbanBoardProps): ReactElement {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-ink">工作流「{workflow.name}」</h2>
        <button
          type="button"
          className="rounded-lg bg-focus/15 px-3 py-1.5 text-sm text-focus"
          onClick={onNewTask}
        >
          新建任务
        </button>
      </div>
      <div className="flex gap-3 overflow-x-auto">
        {workflow.stages.map((stage) => {
          const cards = tasks.filter((t) => t.status === 'active' && t.currentStageId === stage.id)
          return (
            <div
              key={stage.id}
              className="flex w-60 shrink-0 flex-col gap-2 rounded-2xl border border-line bg-white/[0.02] p-2"
            >
              <div className="flex items-center justify-between px-1 text-xs text-ink-dim">
                <span>{stage.name}</span>
                <span>{cards.length}</span>
              </div>
              {cards.length === 0 ? (
                <p className="px-1 py-3 text-center text-xs text-ink-faint">空</p>
              ) : (
                cards.map((task) => (
                  <TaskCard key={task.id} task={task} stage={stage} onMove={onMove} />
                ))
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
