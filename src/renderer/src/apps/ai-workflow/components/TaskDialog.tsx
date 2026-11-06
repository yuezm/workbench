import { useState, type ReactElement } from 'react'
import type { TaskInput, WorkflowWithStages } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Dialog } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { Input, fieldCls } from '../../../components/ui/input'
import { Select } from '../../../components/ui/select'
import { cn } from '../../../lib/cn'

interface TaskDialogProps {
  workflow: WorkflowWithStages
  onSave: (input: TaskInput) => Promise<void>
  onCancel: () => void
}

const textareaCls = cn(fieldCls, 'min-h-24 resize-y py-2 leading-relaxed')

/** 新建任务弹窗：可指定从哪个阶段开始（默认首阶段） */
export function TaskDialog({ workflow, onSave, onCancel }: TaskDialogProps): ReactElement {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [stageId, setStageId] = useState(workflow.stages[0]?.id ?? '')
  const [saving, setSaving] = useState(false)

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    try {
      await onSave({ title, description, workflowId: workflow.id, stageId })
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
            placeholder="起个名字"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="任务描述">
          <textarea
            aria-label="任务描述"
            className={textareaCls}
            placeholder="背景、验收标准"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="起始阶段">
          <Select
            ariaLabel="起始阶段"
            value={stageId}
            onChange={setStageId}
            options={workflow.stages.map((s) => ({ value: s.id, label: s.name }))}
          />
        </Field>
        <p className="text-[11px] leading-relaxed text-ink-faint">
          「交给智能体」的阶段会立即执行。
        </p>

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
            创建
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
