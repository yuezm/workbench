import type { ReactElement } from 'react'
import type {
  Task,
  TaskMoveAction,
  WorkflowWithStages,
} from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { TaskCard } from './TaskCard'

interface KanbanBoardProps {
  workflow: WorkflowWithStages
  tasks: Task[]
  onMove: (taskId: string, action: TaskMoveAction) => void
  onNewTask: () => void
}

/** 列头圆点按列序循环取四色点缀 */
const DOT_COLORS = ['bg-focus', 'bg-short', 'bg-long', 'bg-focus-deep'] as const

/** 看板图标：三列分栏 */
function BoardIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden="true"
    >
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="10" y="4" width="5" height="10" rx="1.5" />
      <rect x="17" y="4" width="4" height="13" rx="1.5" />
    </svg>
  )
}

export function KanbanBoard({
  workflow,
  tasks,
  onMove,
  onNewTask,
}: KanbanBoardProps): ReactElement {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[13px] font-medium tracking-wide text-ink">
          <span className="text-focus">
            <BoardIcon />
          </span>
          工作流「{workflow.name}」
        </h2>
        <Button type="button" variant="primary" size="sm" onClick={onNewTask}>
          新建任务
        </Button>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {workflow.stages.map((stage, index) => {
          const cards = tasks.filter((t) => t.status === 'active' && t.currentStageId === stage.id)
          return (
            <div
              key={stage.id}
              className="flex w-64 shrink-0 animate-rise flex-col gap-2.5 rounded-2xl border border-line bg-white/[0.02] p-2.5"
              style={{ animationDelay: `${index * 60}ms` }}
            >
              <div className="flex items-center justify-between px-1.5 pt-0.5 pb-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${DOT_COLORS[index % DOT_COLORS.length]}`}
                    aria-hidden="true"
                  />
                  <span className="text-[13px] font-medium tracking-wide text-ink">
                    {stage.name}
                  </span>
                </div>
                <span className="rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[11px] text-ink-dim tabular-nums">
                  {cards.length}
                </span>
              </div>
              {cards.length === 0 ? (
                <p className="grid place-items-center py-4 text-xs text-ink-faint">空</p>
              ) : (
                cards.map((task) => (
                  <TaskCard key={task.id} task={task} stage={stage} onMove={onMove} />
                ))
              )}
              <div className="mt-auto h-px w-full bg-white/[0.05]" aria-hidden="true" />
            </div>
          )
        })}
      </div>
    </section>
  )
}
