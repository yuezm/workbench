import { useState, type DragEvent, type ReactElement } from 'react'
import type { Task, WorkflowWithStages } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/cn'
import { useKernelView } from '../../../shell/useKernelView'
import { ArchivedTasksDialog } from './ArchivedTasksDialog'
import { TaskCard } from './TaskCard'

interface KanbanBoardProps {
  workflow: WorkflowWithStages
  /** 项目下全部任务（M10 的 `tasks.byProject`）：组件内部按 `workflowId` 过滤成本工作流的 */
  tasks: Task[]
  /** 卡片拖到某个阶段列 */
  onMoveToStage: (taskId: string, stageId: string) => void
  /** 卡片拖到「归档」区（完成任务并移出看板） */
  onCompleteTask: (taskId: string) => void
  onNewTask: () => void
  /** 单击任务卡进入任务详情页（页面跳转，回调由上层路由处理） */
  onOpenTask?: (task: Task) => void
  /** 打开卡片所属线程的详情页（任务有 threadId 时才渲染入口） */
  onOpenThread?: (threadId: string) => void
}

/** 列头圆点按列序循环取四色点缀 */
const DOT_COLORS = ['bg-primary', 'bg-success', 'bg-info', 'bg-primary'] as const

/** 「归档」落点：不是阶段（不叫「已完成」，免得和同名阶段混淆），用哨兵值参与高亮判断 */
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
  /** 归档任务清单弹窗：归档只是移出看板，任务本身还要能翻回去看 */
  const [archivedOpen, setArchivedOpen] = useState(false)

  /**
   * 传进来的是 `tasks.byProject`（项目下全部任务，可能混着别的工作流）：
   * 看板只认当前工作流的任务，列、已完成数、子任务统计、父任务标题都按这份算，
   * 否则别的卡片会被算进本工作流的阶段列。
   */
  const boardTasks = tasks.filter((t) => t.workflowId === workflow.id)

  const activeTasks = boardTasks.filter((t) => t.status === 'active')
  const doneTasks = boardTasks.filter((t) => t.status === 'completed')
  const completedCount = doneTasks.length

  // 「执行中」由内核判定（queued/running/waiting 的任务 id 集合），看板不自己现算
  const executingIds = new Set(useKernelView('tasks.executing') ?? [])
  /**
   * 拖拽途中任务变成「执行中」（run 开跑、视图刷新）时不再给落点：
   * 内核会以「执行中的阶段不能拖动 / 不能完成」拒绝，让用户拖成功一次再吃错误条没有意义。
   */
  const draggingExecuting = dragging !== null && executingIds.has(dragging.id)
  // 任务树线索只按当前看板的任务列表查父任务标题，不另发视图查询
  const titleById = new Map(boardTasks.map((task) => [task.id, task.title]))
  // 子任务进度（M8）：同工作流的子任务也在 tasks 里，直接按 parentTaskId 汇总
  const childStats = new Map<string, { done: number; total: number }>()
  for (const task of boardTasks) {
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
    // 执行中的任务不接落点：既不高亮，也不 preventDefault（不 preventDefault 就不会 drop）
    if (dragging === null || draggingExecuting) return
    event.preventDefault()
    setOverTarget(target)
  }

  const dropOnStage = (stageId: string, event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    const task = dragging
    stopDrag()
    if (!task || executingIds.has(task.id) || task.currentStageId === stageId) return
    onMoveToStage(task.id, stageId)
  }

  const dropOnDone = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    const task = dragging
    stopDrag()
    // 执行中的任务归档必被内核拒绝（task.complete）：落点侧再兜一层
    if (task && !executingIds.has(task.id)) onCompleteTask(task.id)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-medium text-foreground">
          <span className="text-brand">
            <BoardIcon />
          </span>
          工作流「{workflow.name}」
          <span className="text-xs font-normal text-faint-foreground">拖拽换阶段</span>
        </h2>
        {/* 任务可以建在当前项目，也可以落在默认目录（M11）：入口始终可用 */}
        <Button type="button" variant="default" size="sm" onClick={onNewTask}>
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
                  'flex min-w-[150px] flex-1 flex-col gap-2.5 rounded-xl border p-2.5',
                  'animate-rise transition-colors duration-150',
                  isOver
                    ? 'border-ring/60 bg-primary/[0.07]'
                    : 'border-border bg-card hover:border-input',
                )}
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <div className="flex items-center justify-between px-1.5 pt-0.5 pb-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${DOT_COLORS[index % DOT_COLORS.length]}`}
                      aria-hidden="true"
                    />
                    <span className="text-base font-medium text-foreground">{stage.name}</span>
                  </div>
                  <span className="rounded-sm bg-accent px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
                    {cards.length}
                  </span>
                </div>
                {cards.length === 0 ? (
                  <p className="grid place-items-center py-4 text-sm text-faint-foreground">
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
                <div className="mt-auto h-px w-full bg-accent" aria-hidden="true" />
              </div>
            )
          })}
        </div>

        {/* 终端落点：固定在右侧不随阶段列滚动，拖到这里 = 任务走完、归档出看板 */}
        <div
          role="group"
          aria-label="归档区"
          onDragOver={(e) => allowDrop(DONE_TARGET, e)}
          onDragLeave={() => setOverTarget(null)}
          onDrop={dropOnDone}
          className={cn(
            'flex w-28 shrink-0 flex-col gap-2.5 self-stretch rounded-xl border border-dashed p-2',
            'transition-colors duration-150',
            overTarget === DONE_TARGET
              ? 'border-success/60 bg-success/[0.07]'
              : 'border-border/70 bg-transparent',
          )}
        >
          <div className="flex items-center justify-between px-1.5 pt-0.5 pb-1">
            <span className="text-base font-medium text-muted-foreground">归档</span>
            <span className="rounded-sm bg-accent px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
              {completedCount}
            </span>
          </div>
          {/* 先把规则写出来：执行中的任务拖进来必被内核拒绝，别让用户点了才吃错误条 */}
          <p className="px-1.5 text-xs text-faint-foreground">执行中的任务不能归档</p>
          <p className="grid flex-1 place-items-center rounded-xl px-2 py-4 text-center text-sm text-faint-foreground">
            拖到这里归档
          </p>
          {/* 归档不是删除：给一条回看入口，能翻出已完成的任务点进详情 */}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="w-full"
            aria-label="查看归档任务"
            title={completedCount === 0 ? '还没有归档任务' : '查看已完成的任务'}
            disabled={completedCount === 0}
            onClick={() => setArchivedOpen(true)}
          >
            查看归档
          </Button>
        </div>
      </div>

      {archivedOpen && (
        <ArchivedTasksDialog
          workflow={workflow}
          tasks={doneTasks}
          onOpenTask={onOpenTask}
          onClose={() => setArchivedOpen(false)}
        />
      )}
    </section>
  )
}
