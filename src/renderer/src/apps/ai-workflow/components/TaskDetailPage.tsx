import { useState, type FormEvent, type ReactElement } from 'react'
import type { Task, WorkflowWithStages } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { badgeCls } from '../../../components/ui/panel'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'
import { DetailHeader } from './DetailHeader'
import { TaskActivity } from './TaskActivity'
import { TaskCommentForm } from './TaskCommentForm'
import { TaskInfoPanel } from './TaskInfoPanel'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface TaskDetailPageProps {
  taskId: string
  /** 工作流清单：阶段名与工作流名从这里查，缺数据时退化为未知 */
  workflows: WorkflowWithStages[]
  onBack: () => void
  /** 打开任务所属线程的详情页（任务没有 threadId 时不提供入口） */
  onOpenThread: (threadId: string) => void
  /** 打开子任务详情（M8；没有子任务时不渲染区块） */
  onOpenTask?: (taskId: string) => void
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
}: TaskDetailPageProps): ReactElement {
  const state = useKernelViewState('task.byId', { taskId })
  const runsState = useKernelViewState('runs.byTask', { taskId })
  const commentsState = useKernelViewState('comments.byTask', { taskId })
  const childrenState = useKernelViewState('tasks.byParent', { taskId })
  const task = state.data ?? null
  const runs = runsState.data ?? []
  const comments = commentsState.data ?? []
  const children: Task[] = childrenState.data ?? []
  const threadId = task?.threadId ?? null
  /** 反馈输入（提交成功后清空；失败保留待重试） */
  const [draft, setDraft] = useState('')
  const [rerun, setRerun] = useState(true)
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

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

  return (
    <section aria-label="任务详情" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DetailHeader
        title={task?.title ?? '任务详情'}
        hint={hint}
        onBack={onBack}
        actions={
          threadId === null ? undefined : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onOpenThread(threadId)}
            >
              打开线程
            </Button>
          )
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {state.error !== null ? (
          <p
            role="alert"
            className="rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300"
          >
            {state.error}
          </p>
        ) : state.data === undefined ? (
          <p className="text-xs text-ink-faint">正在读取任务…</p>
        ) : task === null ? (
          <p className="rounded-xl border border-dashed border-line px-3 py-2 text-xs text-ink-faint">
            任务不存在
          </p>
        ) : (
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <TaskInfoPanel task={task} stageName={stageName} />

            {children.length > 0 && (
              <section aria-label="子任务" className="flex flex-col gap-2">
                <h3 className="flex items-center gap-2 text-[13px] font-medium tracking-wide text-ink">
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
                        className="flex w-full items-center gap-2 rounded-xl border border-line bg-white/[0.02] px-3 py-2 text-left text-xs text-ink transition-colors hover:bg-white/[0.05] disabled:cursor-default"
                      >
                        <span className="min-w-0 flex-1 truncate">{child.title}</span>
                        <span className="shrink-0 text-[11px] text-ink-faint">
                          {stageNameOf(child)}
                        </span>
                        <span
                          className={
                            child.status === 'completed'
                              ? 'shrink-0 rounded-full bg-short/15 px-1.5 py-0.5 text-[10px] text-short'
                              : 'shrink-0 rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[10px] text-ink-dim'
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

            <section aria-label="上下文" className="flex flex-col gap-3">
              <h3 className="flex items-center gap-2 text-[13px] font-medium tracking-wide text-ink">
                上下文
                <span className={badgeCls}>运行 {runs.length}</span>
                <span className={badgeCls}>反馈 {comments.length}</span>
              </h3>
              {runsState.error !== null && (
                <p
                  role="alert"
                  className="rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300"
                >
                  {runsState.error}
                </p>
              )}
              {commentsState.error !== null && (
                <p
                  role="alert"
                  className="rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300"
                >
                  {commentsState.error}
                </p>
              )}
              <TaskActivity runs={runs} comments={comments} />
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
          </div>
        )}
      </div>
    </section>
  )
}
