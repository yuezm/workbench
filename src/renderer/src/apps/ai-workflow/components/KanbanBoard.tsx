import { useState, type DragEvent, type ReactElement } from 'react'
import type { Task, WorkflowWithStages } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/cn'
import { useKernelView } from '../../../shell/useKernelView'
import { TaskCard } from './TaskCard'

interface KanbanBoardProps {
  workflow: WorkflowWithStages
  tasks: Task[]
  /** 卡片拖到某个阶段列 */
  onMoveToStage: (taskId: string, stageId: string) => void
  /** 卡片拖到「已完成」区 */
  onCompleteTask: (taskId: string) => void
  onNewTask: () => void
  /** 单击任务卡进入任务详情页（页面跳转，回调由上层路由处理） */
  onOpenTask?: (task: Task) => void
  /** 打开卡片所属线程的详情页（任务有 threadId 时才渲染入口） */
  onOpenThread?: (threadId: string) => void
}

/** 列头圆点按列序循环取四色点缀 */
const DOT_COLORS = ['bg-focus', 'bg-short', 'bg-long', 'bg-focus-deep'] as const

/** 「已完成」落点：不是阶段，用哨兵值参与高亮判断 */
const DONE_TARGET = '__done__'

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
  onMoveToStage,
  onCompleteTask,
  onNewTask,
  onOpenTask,
  onOpenThread,
}: KanbanBoardProps): ReactElement {
  /** 当前被拖动的任务（同一看板内拖拽，状态足够，不依赖 dataTransfer） */
  const [dragging, setDragging] = useState<Task | null>(null)
  const [overTarget, setOverTarget] = useState<string | null>(null)

  const activeTasks = tasks.filter((t) => t.status === 'active')
  const completedCount = tasks.filter((t) => t.status === 'completed').length

  // 「执行中」由内核判定（queued/running/waiting 的任务 id 集合），看板不自己现算
  const executingIds = new Set(useKernelView('tasks.executing') ?? [])
  // 任务树线索只按当前看板的任务列表查父任务标题，不另发视图查询
  const titleById = new Map(tasks.map((task) => [task.id, task.title]))
  // 子任务进度（M8）：同工作流的子任务也在 tasks 里，直接按 parentTaskId 汇总
  const childStats = new Map<string, { done: number; total: number }>()
  for (const task of tasks) {
    if (task.parentTaskId === null) continue
    const stats = childStats.get(task.parentTaskId) ?? { done: 0, total: 0 }
    stats.total += 1
    if (task.status === 'completed') stats.done += 1
    childStats.set(task.parentTaskId, stats)
  }

  const stopDrag = (): void => {
    setDragging(null)
    setOverTarget(null)
  }

  const allowDrop = (target: string, event: DragEvent<HTMLElement>): void => {
    if (!dragging) return
    event.preventDefault()
    setOverTarget(target)
  }

  const dropOnStage = (stageId: string, event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    const task = dragging
    stopDrag()
    if (!task || task.currentStageId === stageId) return
    onMoveToStage(task.id, stageId)
  }

  const dropOnDone = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    const task = dragging
    stopDrag()
    if (task) onCompleteTask(task.id)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[13px] font-medium tracking-wide text-ink">
          <span className="text-focus">
            <BoardIcon />
          </span>
          工作流「{workflow.name}」
          <span className="text-[11px] font-normal text-ink-faint">拖拽换阶段</span>
        </h2>
        <Button type="button" variant="primary" size="sm" onClick={onNewTask}>
          新建任务
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-w-0 flex-1 gap-3 overflow-x-auto pb-2">
          {workflow.stages.map((stage, index) => {
            const cards = activeTasks.filter((t) => t.currentStageId === stage.id)
            const isOver = overTarget === stage.id
            return (
              <div
                key={stage.id}
                role="group"
                aria-label={`阶段：${stage.name}`}
                onDragOver={(e) => allowDrop(stage.id, e)}
                onDragLeave={() => setOverTarget(null)}
                onDrop={(e) => dropOnStage(stage.id, e)}
                className={cn(
                  'flex min-w-[150px] flex-1 flex-col gap-2.5 rounded-2xl border p-2.5',
                  'animate-rise transition-colors duration-150',
                  isOver
                    ? 'border-focus/60 bg-focus/[0.07]'
                    : 'border-line bg-white/[0.02] hover:border-line-strong',
                )}
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
                  <p className="grid place-items-center py-4 text-xs text-ink-faint">
                    {dragging ? '拖到这里' : '空'}
                  </p>
                ) : (
                  cards.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      stage={stage}
                      executing={executingIds.has(task.id)}
                      dragging={dragging?.id === task.id}
                      parentTitle={
                        task.parentTaskId === null ? undefined : titleById.get(task.parentTaskId)
                      }
                      childProgress={childStats.get(task.id)}
                      onOpenTask={onOpenTask}
                      onOpenThread={onOpenThread}
                      onDragStart={setDragging}
                      onDragEnd={stopDrag}
                    />
                  ))
                )}
                <div className="mt-auto h-px w-full bg-white/[0.05]" aria-hidden="true" />
              </div>
            )
          })}
        </div>

        {/* 终端落点：固定在右侧不随阶段列滚动，拖到这里 = 任务走完、移出看板 */}
        <div
          role="group"
          aria-label="已完成区"
          onDragOver={(e) => allowDrop(DONE_TARGET, e)}
          onDragLeave={() => setOverTarget(null)}
          onDrop={dropOnDone}
          className={cn(
            'flex w-28 shrink-0 flex-col gap-2.5 self-stretch rounded-2xl border border-dashed p-2',
            'transition-colors duration-150',
            overTarget === DONE_TARGET
              ? 'border-short/60 bg-short/[0.07]'
              : 'border-line bg-white/[0.01]',
          )}
        >
          <div className="flex items-center justify-between px-1.5 pt-0.5 pb-1">
            <span className="text-[13px] font-medium tracking-wide text-ink-dim">已完成</span>
            <span className="rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[11px] text-ink-dim tabular-nums">
              {completedCount}
            </span>
          </div>
          <p className="grid flex-1 place-items-center rounded-xl px-2 py-4 text-center text-[11px] leading-relaxed text-ink-faint">
            拖到这里完成
          </p>
        </div>
      </div>
    </section>
  )
}
