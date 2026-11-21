import type { ReactElement } from 'react'
import type { Task, TaskPhase } from '@workbench/protocol/entities'
import { TASK_PHASE_LABEL } from '../model/stage-kinds'
import { cn } from '@workbench/client-ui-kit/cn'
import { formatLocalDateTime } from '@workbench/client-ui-kit/time'

const ORIGIN_LABEL: Record<Task['origin'], string> = {
  manual: '手工创建',
  rule: '规则创建',
  handoff: '跨工作流交接',
  spawn: 'Agent 派生',
}

/** 一个字段：标签 + 值（长 id 截断显示，完整值留在 title） */
function Meta({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn('truncate text-xs text-muted-foreground', mono && 'font-mono')}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}

export interface TaskInfoPanelProps {
  task: Task
  /** 当前阶段名（工作流数据缺失时为 undefined，展示「未知阶段」） */
  stageName: string | undefined
  /**
   * 阶段语义（M53）：完成与否只看阶段类别，「状态」这一行不再读归档字段——
   * 停在「已完成」列的任务当场显示「已完成」，归档与否是另一件事。
   */
  phase: TaskPhase
}

/**
 * 任务详情页上部的任务信息：字段表 + 标签。
 *
 * 只读任务行与阶段名，不推导任何业务规则；状态 / 来源的中文文案属于展示映射。
 * 任务说明（初始输入）不在这里：它单独成卡，见 `TaskBrief`。
 */
export function TaskInfoPanel({ task, stageName, phase }: TaskInfoPanelProps): ReactElement {
  return (
    <section aria-label="任务信息" className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-xl border border-border bg-card px-4 py-3 sm:grid-cols-3">
        <Meta label="阶段语义" value={TASK_PHASE_LABEL[phase]} />
        <Meta label="阶段" value={stageName ?? '未知阶段'} />
        <Meta label="来源" value={ORIGIN_LABEL[task.origin]} />
        <Meta label="线程" value={task.threadId ?? '未挂线程'} mono={task.threadId !== null} />
        {/* 时间字段内核存 ISO（UTC），展示一律换成本机时区（口径见 client-ui-kit/time） */}
        <Meta label="创建时间" value={formatLocalDateTime(task.createdAt)} mono />
        <Meta label="更新时间" value={formatLocalDateTime(task.updatedAt)} mono />
        <div className="col-span-2 flex min-w-0 flex-col gap-0.5 sm:col-span-3">
          <dt className="text-xs text-muted-foreground">任务 ID</dt>
          <dd className="truncate font-mono text-sm text-muted-foreground" title={task.id}>
            {task.id}
          </dd>
        </div>
      </dl>
      {task.labels.length > 0 && (
        <ul aria-label="标签" className="flex flex-wrap gap-1.5">
          {task.labels.map((label) => (
            <li
              key={label}
              className="rounded-sm bg-accent px-2 py-0.5 text-xs text-muted-foreground"
            >
              {label}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
