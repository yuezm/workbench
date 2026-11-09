import type { ReactElement } from 'react'
import type { Task, WorkflowWithStages } from '../../../../../protocol/entities'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog'

export interface ArchivedTasksDialogProps {
  workflow: WorkflowWithStages
  /** 本工作流已完成的任务（上层已按工作流过滤）；弹窗按最近更新排前 */
  tasks: Task[]
  /** 点一行进任务详情页；不传时行只读（禁用） */
  onOpenTask?: (task: Task) => void
  onClose: () => void
}

/**
 * 归档任务清单（看板「归档」区的「查看归档」打开）。
 *
 * 已归档 = 任务 `completed` 并移出看板，不是消失：这里按 `updatedAt` 倒序列出来，
 * 点一行进任务详情页看上下文与历史运行，读完回退即回到看板。
 * 阶段名从当前工作流的阶段表查，阶段被删时退化为「未知阶段」。
 */
export function ArchivedTasksDialog({
  workflow,
  tasks,
  onOpenTask,
  onClose,
}: ArchivedTasksDialogProps): ReactElement {
  const stageNameOf = (task: Task): string =>
    workflow.stages.find((stage) => stage.id === task.currentStageId)?.name ?? '未知阶段'
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
            工作流「{workflow.name}」已完成 {tasks.length} 个任务
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
            {ordered.map((task) => (
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
                  <span className="shrink-0 rounded-sm bg-success/15 px-1.5 py-0.5 text-xs text-success">
                    已完成
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
