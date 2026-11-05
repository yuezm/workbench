import type { ReactElement } from 'react'
import type { Task, WorkflowStage } from '../../../../../protocol/entities'
import { cn } from '../../../lib/cn'

interface TaskCardProps {
  task: Task
  stage: WorkflowStage
  /** 是否存在 queued/running 的 run：执行中的卡片由 run 结果推进，不可拖拽 */
  executing: boolean
  /** 正在被拖动：本卡片半透明，表示这是拖拽源 */
  dragging?: boolean
  onDragStart: (task: Task) => void
  onDragEnd: () => void
  /** 父任务标题（父任务也在当前看板里时由上层按任务列表查得，不另发视图查询） */
  parentTitle?: string
  /** 打开线程面板：不传或任务没有 threadId 时不渲染线程入口 */
  onOpenThread?: (task: Task) => void
}

/** 卡片底部状态文案：按进入方式提示下一步怎么走 */
const HINTS: Record<WorkflowStage['entryMode'], string> = {
  none: '拖到其它阶段推进',
  user: '等待你处理',
  agent: '上次执行未完成，可拖走重试',
}

/**
 * 看板任务卡（M6.5 增加任务树线索与线程入口）：
 *
 * - `parentTaskId` 非空 = 派生任务，显示「子任务」徽标（父任务在看板里时带上标题）；
 * - `threadId` 非空 = 挂在线程上，提供打开线程面板的按钮，回调由上层传；
 * - 卡片本身只读任务行 + 阶段，不推导线程 / 派活规则。
 */
export function TaskCard({
  task,
  stage,
  executing,
  dragging = false,
  onDragStart,
  onDragEnd,
  parentTitle,
  onOpenThread,
}: TaskCardProps): ReactElement {
  const isSubtask = task.parentTaskId !== null

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
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
        {isSubtask && (
          <span
            className="rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[10px] text-ink-faint"
            title={task.parentTaskId ?? undefined}
          >
            {parentTitle === undefined || parentTitle === '' ? '子任务' : `子任务 · ${parentTitle}`}
          </span>
        )}
        {executing && (
          <span className="size-1.5 animate-pulse rounded-full bg-focus" aria-hidden="true" />
        )}
        {executing ? '执行中…' : HINTS[stage.entryMode]}
        {task.threadId !== null && onOpenThread !== undefined && (
          <button
            type="button"
            aria-label={`打开线程：${task.title}`}
            onClick={() => onOpenThread(task)}
            className={cn(
              'ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-focus',
              'transition-colors duration-200 hover:bg-white/[0.06] hover:text-ink',
              'focus-visible:ring-2 focus-visible:ring-focus/60 focus-visible:outline-none',
            )}
          >
            线程
          </button>
        )}
      </div>
    </article>
  )
}
