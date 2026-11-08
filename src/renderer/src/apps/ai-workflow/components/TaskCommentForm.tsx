import { useRef, useState, type FormEvent, type ReactElement } from 'react'
import { TASK_COMMENT_LIMITS } from '../../../../../protocol/task-comment'
import { Button } from '../../../components/ui/button'
import { FormError } from '../../../components/ui/form-error'
import { fieldCls } from '../../../components/ui/input'
import { cn } from '../../../lib/cn'

const textareaCls = cn(fieldCls, 'min-h-20 resize-y py-2')

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
 * - 空反馈不靠「按钮灰着不响」表达：按钮可点，点了就地报「写点内容再发送」并把焦点
 *   移回输入框（静默禁用和静默 return 是同一个毛病，用户看不出为什么没反应）；
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [emptyError, setEmptyError] = useState(false)

  const submit = (event: FormEvent): void => {
    if (value.trim() === '') {
      event.preventDefault()
      setEmptyError(true)
      textareaRef.current?.focus()
      return
    }
    setEmptyError(false)
    onSubmit(event)
  }

  return (
    <form
      aria-label="添加反馈"
      className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-3"
      onSubmit={submit}
    >
      <textarea
        ref={textareaRef}
        aria-label="反馈内容"
        className={textareaCls}
        maxLength={TASK_COMMENT_LIMITS.text}
        placeholder="补充背景、指出问题、给验收意见…"
        value={value}
        disabled={busy}
        onChange={(e) => {
          onChange(e.target.value)
          setEmptyError(false)
        }}
      />

      <FormError message={emptyError ? '写点内容再发送：空反馈不会提交。' : null} />
      <FormError message={error} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label
          className={cn(
            'flex items-center gap-2 text-action',
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
        <Button type="submit" variant="primary" size="sm" disabled={busy}>
          {busy ? '发送中…' : '发送反馈'}
        </Button>
      </div>

      <p className="text-meta text-ink-dim">
        {canRerun
          ? '反馈会作为提示词的「反馈记录」资料段；勾选后若当前没有运行中的轮次，会立刻再跑一轮。'
          : '当前阶段不交给智能体：反馈只记上下文，任务下次进入智能体阶段时带上。'}
      </p>
    </form>
  )
}
