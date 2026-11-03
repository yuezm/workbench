import type { ReactElement } from 'react'
import type { Task, TaskMoveAction, WorkflowStage } from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'

interface TaskCardProps {
  task: Task
  stage: WorkflowStage
  onMove: (taskId: string, action: TaskMoveAction) => void
}

export function TaskCard({ task, stage, onMove }: TaskCardProps): ReactElement {
  return (
    <article className="group flex flex-col gap-2 rounded-xl border border-line bg-white/[0.04] p-3 shadow-[0_1px_0_rgb(255_255_255/4%)_inset] transition-all duration-200 hover:border-line-strong hover:bg-white/[0.06]">
      <h3 className="text-sm leading-snug font-medium text-ink">{task.title}</h3>
      {task.description && (
        <p className="line-clamp-3 text-xs leading-relaxed text-ink-faint">{task.description}</p>
      )}
      <div className="mt-1 flex items-center gap-2">
        {stage.entryMode === 'user' && (
          <>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => onMove(task.id, 'approve')}
            >
              通过
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onMove(task.id, 'reject')}
            >
              打回
            </Button>
          </>
        )}
        {stage.entryMode === 'none' && (
          <Button type="button" variant="primary" size="sm" onClick={() => onMove(task.id, 'next')}>
            推进
          </Button>
        )}
        {stage.entryMode === 'agent' && (
          <span className="flex items-center gap-2 text-xs text-ink-faint">
            <span className="size-1.5 animate-pulse rounded-full bg-focus" aria-hidden="true" />
            执行中…
          </span>
        )}
      </div>
    </article>
  )
}
