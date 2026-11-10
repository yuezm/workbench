import {
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import {
  stageKindOf,
  type Task,
  type WorkflowStage,
  type WorkflowWithStages,
} from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { FormError } from '../../../components/ui/form-error'
import { Input } from '../../../components/ui/input'
import { Textarea } from '../../../components/ui/textarea'
import { cn } from '../../../lib/cn'
import { useKernelView } from '../../../shell/useKernelView'
import { STAGE_KIND_META } from '../model/stage-kinds'
import { ArchivedTasksDialog } from './ArchivedTasksDialog'
import { TaskCard } from './TaskCard'

/** 任务标题 / 描述上限（与协议 `COMMAND_LIMITS` 同口径） */
const TASK_TITLE_MAX = 200
const TASK_DESCRIPTION_MAX = 2000

interface KanbanBoardProps {
  workflow: WorkflowWithStages
  /** 项目下全部任务（M10 的 `tasks.byProject`）：组件内部按 `workflowId` 过滤成本工作流的 */
  tasks: Task[]
  /** 卡片拖到某个阶段列 */
  onMoveToStage: (taskId: string, stageId: string) => void
  /** 卡片拖到「归档」区（完成任务并移出看板） */
  onCompleteTask: (taskId: string) => void
  /** 顶部「新建任务」：打开完整表单（可选起始阶段 / 描述） */
  onNewTask: () => void
  /**
   * 列内快速新建：以该阶段为起始阶段建任务（标题 + 可选的描述 / 要求）。
   * 返回 Promise，失败由列内就地展示（上层只管发命令）。
   */
  onQuickCreateTask?: (stageId: string, title: string, description: string) => Promise<void>
  /** 单击任务卡进入任务详情页（页面跳转，回调由上层路由处理） */
  onOpenTask?: (task: Task) => void
  /** 打开卡片所属线程的详情页（任务有 threadId 时才渲染入口） */
  onOpenThread?: (threadId: string) => void
}

/** 「归档」落点：不是阶段（不叫「已完成」，免得和同名阶段混淆），用哨兵值参与高亮判断 */
const DONE_TARGET = '__done__'

/**
 * 列内快速新建（Trello 式）：收起时是列底一条虚线按钮，点开后就地敲标题与要求。
 *
 * 标题是必填项，**要求 / 上下文（描述）可选但强烈建议**——`agent` 阶段的列建完
 * 立刻就会派给智能体，只有标题它没有可执行的内容。
 *
 * 键盘：标题里 Enter 创建；描述里 Enter 换行、Ctrl/⌘+Enter 创建；Esc 取消。
 * 创建成功清空但保持展开（连着建几张不用重复点开），失败文案贴在本列内。
 * 样式沿用卡片的圆角与列宽，视觉上属于这一列而不是浮在上面的对话框。
 */
function QuickAddTask({
  stageName,
  entryMode,
  onAdd,
}: {
  stageName: string
  entryMode: WorkflowStage['entryMode']
  onAdd: (title: string, description: string) => Promise<void>
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 收起表单（提交中收起会让人以为没建成：输入框与取消按钮在 busy 时都禁用，Esc 也进不到这里） */
  const close = (): void => {
    setOpen(false)
    setTitle('')
    setDescription('')
    setError(null)
  }

  const submit = (): void => {
    const value = title.trim()
    if (value === '') {
      setError('任务标题必填')
      return
    }
    setBusy(true)
    void (async () => {
      try {
        await onAdd(value, description.trim())
        setTitle('')
        setDescription('')
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    })()
  }

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    submit()
  }

  /** 文本域里的键盘约定：Ctrl/⌘+Enter 创建、Esc 收起（Enter 留给换行） */
  const onTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      submit()
    }
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`在「${stageName}」阶段添加任务`}
        className="w-full justify-start border border-dashed border-border/70 text-faint-foreground hover:border-input hover:bg-accent hover:text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        + 新建任务
      </Button>
    )
  }

  return (
    <form
      aria-label={`在「${stageName}」阶段添加任务`}
      className="flex flex-col gap-2 rounded-xl border border-border bg-muted p-2"
      onSubmit={onSubmit}
    >
      <Input
        // 展开即聚焦：从「+ 新建任务」点进来的下一步就是打字
        autoFocus
        aria-label={`阶段「${stageName}」的新任务标题`}
        maxLength={TASK_TITLE_MAX}
        placeholder="任务标题，回车创建"
        value={title}
        disabled={busy}
        onChange={(e) => {
          setError(null)
          setTitle(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          // 只收本输入框的 Esc：别让上层当成「返回上一级」
          e.stopPropagation()
          close()
        }}
      />
      <Textarea
        aria-label={`阶段「${stageName}」的新任务要求`}
        className="min-h-16 resize-y"
        maxLength={TASK_DESCRIPTION_MAX}
        placeholder="要它做什么 / 验收标准（可留空，Ctrl+Enter 创建）"
        value={description}
        disabled={busy}
        onChange={(e) => {
          setError(null)
          setDescription(e.target.value)
        }}
        onKeyDown={onTextareaKeyDown}
      />
      {/* agent 阶段建完立刻派活：先说清楚，别让人以为还能慢慢补 */}
      {entryMode === 'agent' && (
        <p className="text-xs text-faint-foreground">这一列会立即交给智能体执行，写清要求。</p>
      )}
      <FormError message={error} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="xs" disabled={busy}>
          添加
        </Button>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={close}>
          取消
        </Button>
        <span className="ml-auto text-xs text-faint-foreground">Esc 取消</span>
      </div>
    </form>
  )
}

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
  onQuickCreateTask,
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
      {/* 阶段列固定宽度、横向滚动；归档单独一条压在下面 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto pb-2">
          {workflow.stages.map((stage, index) => {
            const cards = activeTasks.filter((t) => t.currentStageId === stage.id)
            const isOver = overTarget === stage.id
            // M18：列头圆点按阶段**类别**取色（未开始 / 进行中 / 已完成 / 已关闭），
            // 不再按列序循环四色——颜色要说明状态，不是装饰
            const kindMeta = STAGE_KIND_META[stageKindOf(stage)]
            return (
              <div
                key={stage.id}
                role="group"
                aria-label={`阶段：${stage.name}`}
                onDragOver={(e) => allowDrop(stage.id, e)}
                onDragLeave={() => setOverTarget(null)}
                onDrop={(e) => dropOnStage(stage.id, e)}
                className={cn(
                  // 固定列宽（不随列数拉伸）：列再多就横向滚动，卡片宽度稳定、扫读节奏一致
                  'flex w-64 shrink-0 flex-col gap-2.5 rounded-xl border p-2.5',
                  'animate-rise transition-colors duration-150',
                  isOver
                    ? 'border-ring/60 bg-primary/[0.07]'
                    : 'border-border bg-card hover:border-input',
                )}
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <div className="flex items-center justify-between px-1.5 pt-0.5 pb-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn('size-1.5 shrink-0 rounded-full', kindMeta.dot)}
                      aria-hidden="true"
                    />
                    {/* 列头只留阶段名：状态由圆点颜色表达，不再挂类别文案
                        （「待办」旁边不写「未开始」——名字已经够读） */}
                    <span className="truncate text-base font-medium text-foreground">
                      {stage.name}
                    </span>
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
                <div className="h-px w-full bg-accent" aria-hidden="true" />
                {onQuickCreateTask !== undefined && (
                  <QuickAddTask
                    stageName={stage.name}
                    entryMode={stage.entryMode}
                    onAdd={(title, description) => onQuickCreateTask(stage.id, title, description)}
                  />
                )}
              </div>
            )
          })}
        </div>

        {/* 终端落点：看板最下面一条横排（不挤占阶段列宽度），拖到这里 = 任务走完、归档出看板 */}
        <div
          role="group"
          aria-label="归档区"
          onDragOver={(e) => allowDrop(DONE_TARGET, e)}
          onDragLeave={() => setOverTarget(null)}
          onDrop={dropOnDone}
          className={cn(
            'flex w-full shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-dashed px-3 py-2',
            'transition-colors duration-150',
            overTarget === DONE_TARGET
              ? 'border-success/60 bg-success/[0.07]'
              : 'border-border/70 bg-transparent',
          )}
        >
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-base font-medium text-muted-foreground">归档</span>
            <span className="rounded-sm bg-accent px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
              {completedCount}
            </span>
          </div>
          {/* 落点提示占中间，先把规则写出来：执行中的任务拖进来必被内核拒绝 */}
          <p className="flex min-w-40 flex-1 flex-wrap items-center justify-center gap-x-2 rounded-lg px-3 py-1.5 text-sm text-faint-foreground">
            <span>{dragging ? '松手归档' : '拖到这里归档'}</span>
            <span aria-hidden="true">·</span>
            <span>执行中的任务不能归档</span>
          </p>
          {/* 归档不是删除：给一条回看入口，能翻出已完成的任务点进详情 */}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0"
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
