import { useState, type ReactElement } from 'react'
import type { TaskInput } from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { Dialog } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { Input, fieldCls } from '../../../components/ui/input'
import { cn } from '../../../lib/cn'

interface TaskDialogProps {
  workflowId: string
  onSave: (input: TaskInput) => Promise<void>
  onCancel: () => void
}

const textareaCls = cn(fieldCls, 'min-h-24 resize-y py-2 leading-relaxed')

/** 新建任务弹窗 */
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
    <Dialog title="新建任务" onClose={onCancel}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="任务标题">
          <Input
            aria-label="任务标题"
            placeholder="给任务起个名字"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="任务描述">
          <textarea
            aria-label="任务描述"
            className={textareaCls}
            placeholder="补充背景、验收标准或上下文"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <div className="mt-2 flex items-center justify-end gap-2">
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
    </Dialog>
  )
}
