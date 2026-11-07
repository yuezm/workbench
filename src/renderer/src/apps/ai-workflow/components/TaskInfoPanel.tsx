import type { ReactElement } from 'react'
import type { Task } from '../../../../../protocol/entities'
import { cn } from '../../../lib/cn'

const STATUS_LABEL: Record<Task['status'], string> = {
  active: '进行中',
  completed: '已完成',
}

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
      <dt className="text-[11px] tracking-wide text-ink-dim">{label}</dt>
      <dd className={cn('truncate text-[11px] text-ink-dim', mono && 'font-mono')} title={value}>
        {value}
      </dd>
    </div>
  )
}

export interface TaskInfoPanelProps {
  task: Task
  /** 当前阶段名（工作流数据缺失时为 undefined，展示「未知阶段」） */
  stageName: string | undefined
}

/**
 * 任务详情页上部的任务信息：描述 + 字段表 + 标签。
 *
 * 只读任务行与阶段名，不推导任何业务规则；状态 / 来源的中文文案属于展示映射。
 */
export function TaskInfoPanel({ task, stageName }: TaskInfoPanelProps): ReactElement {
  return (
    <section aria-label="任务信息" className="flex flex-col gap-3">
      <p
        className={cn(
          'text-xs leading-relaxed whitespace-pre-wrap',
          task.description === '' ? 'text-ink-faint' : 'text-ink-dim',
        )}
      >
        {task.description === '' ? '没有描述' : task.description}
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-xl border border-line bg-surface px-4 py-3 sm:grid-cols-3">
        <Meta label="状态" value={STATUS_LABEL[task.status]} />
        <Meta label="阶段" value={stageName ?? '未知阶段'} />
        <Meta label="来源" value={ORIGIN_LABEL[task.origin]} />
        <Meta label="线程" value={task.threadId ?? '未挂线程'} mono={task.threadId !== null} />
        <Meta label="创建时间" value={task.createdAt} mono />
        <Meta label="更新时间" value={task.updatedAt} mono />
        <div className="col-span-2 flex min-w-0 flex-col gap-0.5 sm:col-span-3">
          <dt className="text-[11px] tracking-wide text-ink-dim">任务 ID</dt>
          <dd className="truncate font-mono text-[11px] text-ink-dim" title={task.id}>
            {task.id}
          </dd>
        </div>
      </dl>
      {task.labels.length > 0 && (
        <ul aria-label="标签" className="flex flex-wrap gap-1.5">
          {task.labels.map((label) => (
            <li
              key={label}
              className="rounded-sm bg-white/[0.07] px-2 py-0.5 text-[10px] text-ink-dim"
            >
              {label}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
