import type { ReactElement } from 'react'
import type { Task } from '../../../../../protocol/entities'
import { badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'

export interface TaskBriefProps {
  task: Task
}

/**
 * 任务说明（初始输入）：创建任务时给智能体的那段文字，单独成卡放在审批/通知之后、上下文之前。
 *
 * 为什么从「任务信息」里拿出来：它是这一页唯一一段长文本，和字段表挤在一起既没有边界也
 * 不好读；放在活动流前面，读起来就是「先看要求，再看过程」。只展示 `task.description`，
 * 不推导任何规则；后补的上下文仍在「上下文」里的反馈记录。
 */
export function TaskBrief({ task }: TaskBriefProps): ReactElement {
  return (
    <section aria-label="任务说明" className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
        任务说明
        <span className={badgeCls}>初始输入</span>
      </h3>
      <div className="rounded-xl border border-border bg-card px-4 py-3">
        <p
          className={cn(
            'text-sm break-words whitespace-pre-wrap',
            task.description === '' ? 'text-faint-foreground' : 'text-foreground',
          )}
        >
          {task.description === '' ? '没有描述' : task.description}
        </p>
      </div>
    </section>
  )
}
