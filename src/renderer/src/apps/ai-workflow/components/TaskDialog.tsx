import { useState, type ReactElement } from 'react'
import type { TaskInput } from '../../../../../shared/ai-workflow-api'

interface TaskDialogProps {
  workflowId: string
  onSave: (input: TaskInput) => Promise<void>
  onCancel: () => void
}

const inputCls =
  'rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5 text-sm text-ink outline-none focus:border-focus'

export function TaskDialog({ workflowId, onSave, onCancel }: TaskDialogProps): ReactElement {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

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
    <form
      className="flex flex-col gap-2 rounded-2xl border border-line bg-white/[0.03] p-4"
      onSubmit={submit}
    >
      <label className="flex flex-col gap-1 text-xs text-ink-dim">
        任务标题
        <input
          aria-label="任务标题"
          className={inputCls}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-dim">
        描述
        <textarea
          aria-label="任务描述"
          className={inputCls}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-focus/15 px-3 py-1.5 text-sm text-focus disabled:opacity-40"
        >
          创建任务
        </button>
        <button type="button" className="text-sm text-ink-faint hover:underline" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  )
}
