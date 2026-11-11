import { useState, type FormEvent, type ReactElement } from 'react'
import type { Task, WorkflowWithStages } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog'
import { FormError } from '../../../components/ui/form-error'
import { badgeCls } from '../../../components/ui/panel'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'
import { ApprovalCards } from './ApprovalCards'
import { DetailHeader } from './DetailHeader'
import { TaskActivity } from './TaskActivity'
import { TaskBrief } from './TaskBrief'
import { TaskCommentForm } from './TaskCommentForm'
import { TaskInfoPanel } from './TaskInfoPanel'
import { ReviewPanel } from './ReviewPanel'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 「重新执行」按钮文案里的阶段名：阶段名缺失（脏投影）时退化「当前阶段」。
 *
 * 产品路径上该按钮只在阶段存在且 `entryMode === 'agent'` 时渲染，所以 `name` 缺失只能来自
 * 脏投影；抽成模块级导出函数后，两种输入都能直接单测（与 `WorkflowEditor` 的
 * `moveStageInList` 同口径），产品路径的判定一字不改。
 */
export function rerunStageLabel(stageName: string | null | undefined): string {
  return stageName ?? '当前阶段'
}

export interface TaskDetailPageProps {
  taskId: string
  /** 工作流清单：阶段名与工作流名从这里查，缺数据时退化为未知 */
  workflows: WorkflowWithStages[]
  onBack: () => void
  /** 打开任务所属线程的详情页（任务没有 threadId 时不提供入口） */
  onOpenThread: (threadId: string) => void
  /** 打开子任务详情（M8；没有子任务时不渲染区块） */
  onOpenTask?: (taskId: string) => void
  /** 任务被删除后调用：任务行已经不存在，留在详情页只会显示「任务不存在」 */
  onRemoved?: () => void
  /** 要定位并高亮的卡片（点顶部通知条 / 系统通知进来时给）；卡片处理完自然消失 */
  focusCardId?: string | null
}

/**
 * 任务详情页（看板上单击任务卡进入）：任务信息 + 上下文活动流（运行与反馈混排）。
 *
 * 读 `task.byId` / `runs.byTask` / `comments.byTask` 三个视图，事实到达后自动刷新；
 * 返回由上层路由栈处理。像 issue 一样：智能体的每轮运行是回复，底部的反馈框用来补上下文，
 * 勾选「同时让智能体接着做」时由内核判断是否立刻再排一轮（`task.comment`）。
 */
export function TaskDetailPage({
  taskId,
  workflows,
  onBack,
  onOpenThread,
  onOpenTask,
  onRemoved,
  focusCardId,
}: TaskDetailPageProps): ReactElement {
  const state = useKernelViewState('task.byId', { taskId })
  const runsState = useKernelViewState('runs.byTask', { taskId })
  const commentsState = useKernelViewState('comments.byTask', { taskId })
  const childrenState = useKernelViewState('tasks.byParent', { taskId })
  /** M14：该任务的评审报告（按 rev 升序；没有评审时为空） */
  const reviewsState = useKernelViewState('reviews.byTask', { taskId })
  const task = state.data ?? null
  const runs = runsState.data ?? []
  const comments = commentsState.data ?? []
  const children: Task[] = childrenState.data ?? []
  const reviews = reviewsState.data ?? []
  /** 本任务的 open 卡：正文与选项就在页面里，顶部通知条只负责把人送过来 */
  const cardsState = useKernelViewState('cards.open')
  const openCards = cardsState.data ?? []
  const cards = openCards.filter((card) => card.taskId === taskId)
  /** 执行中（存在 queued/running/waiting run）：由内核给，UI 只读 */
  const executingState = useKernelViewState('tasks.executing')
  const executing = (executingState.data ?? []).includes(taskId)
  const threadId = task?.threadId ?? null
  /** 反馈输入（提交成功后清空；失败保留待重试） */
  const [draft, setDraft] = useState('')
  const [rerun, setRerun] = useState(true)
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  /** 顶部结束动作（重新执行 / 停止执行 / 完成任务 / 删除任务）的进行中与失败文案 */
  const [action, setAction] = useState<'rerun' | 'stop' | 'complete' | 'remove' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** 删除确认弹窗：删除连带执行记录（可能连带线程），先问一次 */
  const [confirmRemove, setConfirmRemove] = useState(false)

  const workflow = task === null ? undefined : workflows.find((w) => w.id === task.workflowId)
  const stage =
    task === null ? undefined : workflow?.stages.find((item) => item.id === task.currentStageId)
  const stageName = stage?.name
  const stageNameOf = (child: Task): string =>
    workflow?.stages.find((item) => item.id === child.currentStageId)?.name ?? '未知阶段'
  const hint =
    task === null ? '读取任务中' : `${workflow?.name ?? '未知工作流'} · ${stageName ?? '未知阶段'}`
  /** 勾选「接着做」只在「交给智能体」的阶段有意义（是否真跑仍由内核判定） */
  const canRerun = task !== null && task.status === 'active' && stage?.entryMode === 'agent'
  /**
   * 重新执行当前阶段：失败收口后（关机 / CLI 崩了）能原地再排一轮，不用把卡片拖走再拖回。
   * 内核判任务在 agent 阶段、无活跃 run、智能体与运行时齐备；UI 另加一条：该任务已经跑过
   * 至少一轮（`runs.byTask` 非空）——没跑过的任务没有「这一轮」可重跑。
   */
  const canRerunStage = canRerun && !executing && runs.length > 0

  const rerunStage = (): void => {
    setAction('rerun')
    setActionError(null)
    void getKernelStore()
      .dispatch({ type: 'task.rerun', commandId: '', id: taskId })
      .catch((e: unknown) => setActionError(errMsg(e)))
      .finally(() => setAction(null))
  }

  const post = async (text: string, withRerun: boolean): Promise<boolean> => {
    setPosting(true)
    setPostError(null)
    try {
      await getKernelStore().dispatch({
        type: 'task.comment',
        commandId: '',
        taskId,
        text,
        rerun: withRerun,
      })
      return true
    } catch (e) {
      setPostError(errMsg(e))
      return false
    } finally {
      setPosting(false)
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void post(draft.trim(), rerun && canRerun).then((ok) => {
      if (ok) setDraft('')
    })
  }

  /**
   * 停止执行：把本任务的活跃 run 逐条请求取消（`task.stop`），任务本身保持进行中。
   * 取消是异步收尾（宿主按取消时序落终态），按钮在 `tasks.executing` 更新前先自行置忙。
   */
  const stopInteraction = (): void => {
    setAction('stop')
    setActionError(null)
    void getKernelStore()
      .dispatch({ type: 'task.stop', commandId: '', id: taskId })
      .catch((e: unknown) => setActionError(errMsg(e)))
      .finally(() => setAction(null))
  }

  /**
   * 提升为文档（M14）：把某个版本的评审报告写进任务所属项目的 `docs/reviews/`。
   * 归属校验在内核、落盘在宿主；成功后把路径回显给用户（是否提交由人决定）。
   */
  const exportReview = async (reportId: string): Promise<string> => {
    const result = await getKernelStore().dispatch({
      type: 'review.export',
      commandId: '',
      taskId,
      reportId,
    })
    return result.value?.path ?? ''
  }

  /** 完成任务：终态动作；执行中会被内核拒绝，所以按钮先禁用（title 说明原因）。 */
  const finishTask = (): void => {
    setAction('complete')
    setActionError(null)
    void getKernelStore()
      .dispatch({ type: 'task.complete', commandId: '', id: taskId })
      .catch((e: unknown) => setActionError(errMsg(e)))
      .finally(() => setAction(null))
  }

  /**
   * 删除任务：任务行与它的执行记录（运行、反馈、评审报告、落盘归档）一起消失。
   * 线程里没有别的任务时内核连线程一起删（宿主清该线程的落盘归档），所以删除成功后
   * 一律出栈——留在详情页只会看到「任务不存在」，它所属的线程页可能也不在了。
   */
  const deleteTask = (): void => {
    setAction('remove')
    setActionError(null)
    void getKernelStore()
      .dispatch({ type: 'task.remove', commandId: '', id: taskId })
      .then(() => {
        setConfirmRemove(false)
        onRemoved?.()
      })
      .catch((e: unknown) => {
        // 失败时把弹窗收起，原因贴在页面顶部（弹窗里塞错误容易被当成按钮没反应）
        setConfirmRemove(false)
        setActionError(errMsg(e))
      })
      .finally(() => setAction(null))
  }

  return (
    <section aria-label="任务详情" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DetailHeader
        title={task?.title ?? '任务详情'}
        hint={hint}
        onBack={onBack}
        actions={
          <div className="flex shrink-0 items-center gap-1.5">
            {threadId !== null && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onOpenThread(threadId)}
              >
                打开线程
              </Button>
            )}
            {canRerunStage && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={action !== null}
                title={`重新执行「${rerunStageLabel(stageName)}」这一轮（失败后原地重排）`}
                onClick={rerunStage}
              >
                {action === 'rerun' ? '正在重排…' : '重新执行'}
              </Button>
            )}
            {task !== null && task.status === 'active' && executing && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="text-warning"
                disabled={action !== null}
                onClick={stopInteraction}
              >
                {action === 'stop' ? '正在停止…' : '停止执行'}
              </Button>
            )}
            {task !== null && task.status === 'active' && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={executing || action !== null}
                title={executing ? '执行中：先停止执行' : undefined}
                onClick={finishTask}
              >
                {action === 'complete' ? '正在完成…' : '完成任务'}
              </Button>
            )}
            {task !== null && task.status === 'completed' && (
              <span className="text-xs text-faint-foreground">已完成</span>
            )}
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {state.error !== null ? (
          <FormError message={state.error} className="rounded-xl" />
        ) : state.data === undefined ? (
          <p className="text-xs text-faint-foreground">正在读取任务…</p>
        ) : task === null ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-faint-foreground">
            任务不存在
          </p>
        ) : (
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <FormError message={actionError} />
            <TaskInfoPanel task={task} stageName={stageName} />

            {/* 待审批：智能体在这一任务上等你回答（正文与选项都在这里，提交后即续接） */}
            {/* 卡片视图读失败时卡片会「凭空少一块」，run 却停在 waiting：把原因就地写出来 */}
            <FormError message={cardsState.error} />
            <ApprovalCards cards={cards} focusCardId={focusCardId} />

            {/* 任务说明（初始输入）：审批之后、上下文之前，先看要求再看过程 */}
            <TaskBrief task={task} />

            {/* 子任务读失败同理：空列表和「读不到」是两件事 */}
            <FormError message={childrenState.error} />
            {children.length > 0 && (
              <section aria-label="子任务" className="flex flex-col gap-2">
                <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
                  子任务
                  <span className={badgeCls}>
                    {children.filter((child) => child.status === 'completed').length}/
                    {children.length}
                  </span>
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {children.map((child) => (
                    <li key={child.id}>
                      <button
                        type="button"
                        disabled={onOpenTask === undefined}
                        onClick={() => onOpenTask?.(child.id)}
                        className="flex w-full items-center gap-2 rounded-xl border border-border bg-accent px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-default"
                      >
                        <span className="min-w-0 flex-1 truncate">{child.title}</span>
                        <span className="shrink-0 text-xs text-faint-foreground">
                          {stageNameOf(child)}
                        </span>
                        <span
                          className={
                            child.status === 'completed'
                              ? 'shrink-0 rounded-sm bg-success/15 px-1.5 py-0.5 text-xs text-success'
                              : 'shrink-0 rounded-sm bg-accent px-1.5 py-0.5 text-xs text-muted-foreground'
                          }
                        >
                          {child.status === 'completed' ? '已完成' : '进行中'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* 评审结论（M14）：判定、证据与待改清单；正文在 artifacts，进仓库要人点一下 */}
            <FormError message={reviewsState.error} />
            <ReviewPanel reports={reviews} onExport={exportReview} />

            <section aria-label="上下文" className="flex flex-col gap-3">
              <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
                上下文
                <span className={badgeCls}>运行 {runs.length}</span>
                <span className={badgeCls}>反馈 {comments.length}</span>
              </h3>
              {runsState.error !== null && (
                <FormError message={runsState.error} className="rounded-xl" />
              )}
              {commentsState.error !== null && (
                <FormError message={commentsState.error} className="rounded-xl" />
              )}
              <TaskActivity runs={runs} comments={comments} stages={workflow?.stages ?? []} />
              <TaskCommentForm
                value={draft}
                onChange={setDraft}
                rerun={rerun}
                onRerunChange={setRerun}
                canRerun={canRerun}
                busy={posting}
                error={postError}
                onSubmit={submit}
              />
            </section>

            {/* 页面级终态动作统一在内容区底部（与线程详情同位置）：左说明、右按钮 */}
            <div
              role="group"
              aria-label="页面动作"
              className="flex items-center justify-between gap-3 border-t border-border pt-3"
            >
              <p className="text-xs text-faint-foreground">
                删除会连同运行记录、反馈与落盘归档一起清掉；线程里没有别的任务时线程也一并删除。
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={action !== null}
                  onClick={() => setConfirmRemove(true)}
                >
                  删除任务
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 删除是终态动作：连带执行记录，可能连带线程，先问一次再动手 */}
      {task !== null && confirmRemove && (
        <Dialog open onOpenChange={() => setConfirmRemove(false)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>删除任务</DialogTitle>
              <DialogDescription>
                任务「{task.title}」与它的执行记录（运行记录、反馈、落盘归档）会一起删除，
                不能撤销。线程里没有别的任务时，线程也会一并删除。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={action !== null}
                onClick={() => setConfirmRemove(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={action !== null}
                onClick={deleteTask}
              >
                {action === 'remove' ? '正在删除…' : '删除'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
