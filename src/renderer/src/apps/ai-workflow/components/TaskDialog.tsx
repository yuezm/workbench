import { useEffect, useState, type ReactElement } from 'react'
import type { TaskInput } from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'

interface TaskDialogProps {
  workflowId: string
  onSave: (input: TaskInput) => Promise<void>
  onCancel: () => void
}

const fieldCls =
  'w-full rounded-lg border border-line bg-black/25 px-3 text-sm text-ink placeholder:text-ink-faint outline-none transition-colors duration-200 hover:border-line-strong focus:border-focus/70 focus:bg-black/35'

const inputCls = `${fieldCls} h-9`

const textareaCls = `${fieldCls} min-h-24 resize-y py-2 leading-relaxed`

const labelCls = 'text-[11px] font-medium tracking-wide text-ink-faint'

/** 关闭图标 */
function CloseIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function TaskDialog({ workflowId, onSave, onCancel }: TaskDialogProps): ReactElement {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  // Esc 关闭弹窗
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    try {
      await onSave({ title, description, workflowId })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-6 backdrop-blur-sm">
      <form
        className="w-full max-w-md rounded-2xl border border-line bg-surface/95 p-5 shadow-[0_30px_80px_-30px_rgb(0_0_0/85%)]"
        onSubmit={submit}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-ink">新建任务</h2>
          <button
            type="button"
            aria-label="关闭"
            className="grid size-7 place-items-center rounded-lg text-ink-faint transition-colors duration-200 hover:bg-white/[0.06] hover:text-ink"
            onClick={onCancel}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>任务标题</span>
            <input
              aria-label="任务标题"
              className={inputCls}
              placeholder="给任务起个名字"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={labelCls}>任务描述</span>
            <textarea
              aria-label="任务描述"
              className={textareaCls}
              placeholder="补充背景、验收标准或上下文"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={saving}
            className="disabled:opacity-40"
          >
            创建任务
          </Button>
        </div>
      </form>
    </div>
  )
}
