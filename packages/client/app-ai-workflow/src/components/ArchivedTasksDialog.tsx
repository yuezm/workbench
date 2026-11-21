import type { ReactElement } from 'react'
import {
  taskPhaseOf,
  type Task,
  type TaskPhase,
  type WorkflowWithStages,
} from '@workbench/protocol/entities'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@workbench/client-ui-primitives/dialog'
import { TASK_PHASE_LABEL, taskPhaseMeta } from '../model/stage-kinds'

export interface ArchivedTasksDialogProps {
  workflow: WorkflowWithStages
  /** 本工作流已归档的任务（上层已按工作流过滤）；弹窗按最近更新排前 */
  tasks: Task[]
  /** 点一行进任务详情页；不传时行只读（禁用） */
  onOpenTask?: (task: Task) => void
  onClose: () => void
}

/**
 * 归档任务清单（看板「归档」区的「查看归档」打开）。
 *
 * 已归档 = `archivedAt` 非空、移出看板，**不等于完成**（M53）：清单里既有做完的、也有取消的、
 * 还有「不想跟了但没做完」的，所以每行的徽标按任务当前阶段的类别渲染（已完成 / 已取消 /
 * 进行中 / 未开始），不是一律「已完成」。点一行进任务详情页看上下文与历史运行，读完回退即回看板。
 * 阶段名从当前工作流的阶段表查，阶段被删时退化为「未知阶段」。
 */
export function ArchivedTasksDialog({
  workflow,
  tasks,
  onOpenTask,
  onClose,
}: ArchivedTasksDialogProps): ReactElement {
  const stageOf = (task: Task): WorkflowWithStages['stages'][number] | undefined =>
    workflow.stages.find((stage) => stage.id === task.currentStageId)
  const stageNameOf = (task: Task): string => stageOf(task)?.name ?? '未知阶段'
  const phaseOf = (task: Task): TaskPhase => taskPhaseOf(stageOf(task))
  const ordered = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

  return (
    <Dialog
      open
      // 受控：`open` 恒为 true，只有用户请求关闭（Esc / 右上角 ×）才会回调，直接关掉即可
      onOpenChange={() => onClose()}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>归档任务</DialogTitle>
          <DialogDescription>
            工作流「{workflow.name}」已归档 {tasks.length} 个任务
          </DialogDescription>
        </DialogHeader>

        {ordered.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-faint-foreground">
            还没有归档任务。
          </p>
        ) : (
          <ul
            aria-label="归档任务列表"
            className="flex max-h-[60vh] flex-col gap-1.5 overflow-auto"
          >
            {ordered.map((task) => {
              const phase = phaseOf(task)
              const meta = taskPhaseMeta(phase)
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    aria-label={`打开归档任务：${task.title}`}
                    disabled={onOpenTask === undefined}
                    onClick={() => {
                      onOpenTask?.(task)
                      onClose()
                    }}
                    className="flex w-full items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent disabled:cursor-default"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {task.title}
                    </span>
                    <span className="shrink-0 text-xs text-faint-foreground">
                      {stageNameOf(task)}
                    </span>
                    <span
                      className={[
                        'shrink-0 rounded-sm px-1.5 py-0.5 text-xs',
                        meta.chip,
                        meta.text,
                      ].join(' ')}
                      data-task-phase={phase}
                    >
                      {TASK_PHASE_LABEL[phase]}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
