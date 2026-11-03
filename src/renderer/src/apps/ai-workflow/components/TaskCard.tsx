import type { ReactElement } from 'react'
import type { Task, WorkflowStage } from '../../../../../shared/ai-workflow-api'
import { cn } from '../../../lib/cn'

interface TaskCardProps {
  task: Task
  stage: WorkflowStage
  /** 正在被拖动：本卡片半透明，表示这是拖拽源 */
  dragging?: boolean
  onDragStart: (task: Task) => void
  onDragEnd: () => void
}

/** 卡片底部状态文案：按进入方式提示下一步怎么走 */
const HINTS: Record<WorkflowStage['entryMode'], string> = {
  none: '拖到其它阶段推进',
  user: '等待你处理',
  agent: '执行中…',
}

export function TaskCard({
  task,
  stage,
  dragging = false,
  onDragStart,
  onDragEnd,
}: TaskCardProps): ReactElement {
  // 执行中的卡片由 run 结果推进，不允许手动拖走
  const executing = stage.entryMode === 'agent'
  return (
    <article
      draggable={!executing}
      aria-label={`任务：${task.title}`}
      onDragStart={() => onDragStart(task)}
      onDragEnd={onDragEnd}
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-line bg-white/[0.04] p-3',
        'shadow-[0_1px_0_rgb(255_255_255/4%)_inset] transition-all duration-200',
        executing
          ? 'cursor-default'
          : 'cursor-grab hover:border-line-strong hover:bg-white/[0.06] active:cursor-grabbing',
        dragging && 'opacity-40',
      )}
    >
      <h3 className="text-sm leading-snug font-medium text-ink">{task.title}</h3>
      {task.description && (
        <p className="line-clamp-3 text-xs leading-relaxed text-ink-faint">{task.description}</p>
      )}
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-faint">
        {executing && (
          <span className="size-1.5 animate-pulse rounded-full bg-focus" aria-hidden="true" />
        )}
        {HINTS[stage.entryMode]}
      </div>
    </article>
  )
}
