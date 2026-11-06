import type { FormEvent, ReactElement } from 'react'
import { TASK_COMMENT_LIMITS } from '../../../../../protocol/task-comment'
import { Button } from '../../../components/ui/button'
import { fieldCls } from '../../../components/ui/input'
import { cn } from '../../../lib/cn'

const textareaCls = cn(fieldCls, 'min-h-20 resize-y py-2 leading-relaxed')

export interface TaskCommentFormProps {
  value: string
  onChange: (value: string) => void
  /** 「同时让智能体接着做」的勾选值（只有 `canRerun` 时生效） */
  rerun: boolean
  onRerunChange: (value: boolean) => void
  /** 当前阶段是否交给智能体：不是的话勾选框禁用，反馈只作上下文 */
  canRerun: boolean
  busy: boolean
  /** 后端拒绝文案 */
  error: string | null
  onSubmit: (event: FormEvent) => void
}

/**
 * 任务反馈输入（任务详情页底部，像 issue 的评论框）：
 *
 * - 只收集文本与「是否接着跑」的意图，提交由上层 dispatch `task.comment`；
 * - 勾选框只在「交给智能体」的阶段可用：其它阶段反馈只进上下文，不排运行；
 * - 提交中禁用全部输入，错误 / 提示就地展示。
 */
export function TaskCommentForm({
  value,
  onChange,
  rerun,
  onRerunChange,
  canRerun,
  busy,
  error,
  onSubmit,
}: TaskCommentFormProps): ReactElement {
  return (
    <form
      aria-label="添加反馈"
      className="flex flex-col gap-2 rounded-xl border border-line bg-white/[0.02] p-3"
      onSubmit={onSubmit}
    >
      <textarea
        aria-label="反馈内容"
        className={textareaCls}
        maxLength={TASK_COMMENT_LIMITS.text}
        placeholder="补充背景、指出问题、给验收意见…"
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
      />

      {error !== null && (
        <p
          role="alert"
          className="rounded-lg border border-red-400/30 bg-red-400/10 px-2.5 py-1.5 text-xs text-red-300"
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label
          className={cn(
            'flex items-center gap-2 text-[11px]',
            canRerun ? 'text-ink-dim' : 'text-ink-faint',
          )}
        >
          <input
            type="checkbox"
            aria-label="同时让智能体接着做"
            className="size-3.5 accent-focus"
            checked={rerun && canRerun}
            disabled={!canRerun || busy}
            onChange={(e) => onRerunChange(e.target.checked)}
          />
          同时让智能体接着做
        </label>
        <Button type="submit" variant="primary" size="sm" disabled={busy || value.trim() === ''}>
          {busy ? '发送中…' : '发送反馈'}
        </Button>
      </div>

      <p className="text-[11px] leading-relaxed text-ink-faint">
        {canRerun
          ? '反馈会作为提示词的「反馈记录」资料段；勾选后若当前没有运行中的轮次，会立刻再跑一轮。'
          : '当前阶段不交给智能体：反馈只记上下文，任务下次进入智能体阶段时带上。'}
      </p>
    </form>
  )
}
