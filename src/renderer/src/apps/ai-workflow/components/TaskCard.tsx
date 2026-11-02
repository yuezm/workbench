import type { ReactElement } from 'react'
import type { Task, TaskMoveAction, WorkflowStage } from '../../../../../shared/ai-workflow-api'

interface TaskCardProps {
  task: Task
  stage: WorkflowStage
  onMove: (taskId: string, action: TaskMoveAction) => void
}

export function TaskCard({ task, stage, onMove }: TaskCardProps): ReactElement {
  return (
    <article className="flex flex-col gap-2 rounded-xl border border-line bg-white/[0.03] p-2.5">
      <span className="text-sm font-medium text-ink">{task.title}</span>
      {task.description && <p className="text-xs text-ink-faint">{task.description}</p>}
      <div className="flex gap-2">
        {stage.entryMode === 'user' && (
          <>
            <button
              type="button"
              className="rounded-md bg-focus/15 px-2 py-0.5 text-xs text-focus"
              onClick={() => onMove(task.id, 'approve')}
            >
              通过
            </button>
            <button
              type="button"
              className="rounded-md border border-line px-2 py-0.5 text-xs text-ink-dim"
              onClick={() => onMove(task.id, 'reject')}
            >
              打回
            </button>
          </>
        )}
        {stage.entryMode === 'none' && (
          <button
            type="button"
            className="rounded-md bg-focus/15 px-2 py-0.5 text-xs text-focus"
            onClick={() => onMove(task.id, 'next')}
          >
            推进
          </button>
        )}
        {stage.entryMode === 'agent' && <span className="text-xs text-ink-faint">执行中…</span>}
      </div>
    </article>
  )
}
