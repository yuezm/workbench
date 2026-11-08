import { useState, type ReactElement } from 'react'
import type { Project, TaskInput, WorkflowWithStages } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Dialog } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { Input, fieldCls } from '../../../components/ui/input'
import { Select } from '../../../components/ui/select'
import { cn } from '../../../lib/cn'

interface TaskDialogProps {
  workflow: WorkflowWithStages
  /**
   * 当前项目（M11）：`undefined` = 默认目录（类别与聊天同口径，`projectId` 传 null）。
   * 弹窗只读展示「建在哪个目录」，选择由侧栏顶层的项目切换器负责。
   */
  project?: Project
  /** 默认目录的绝对路径（宿主视图）；未知时为空串 */
  defaultPath: string
  onSave: (input: TaskInput) => Promise<void>
  onCancel: () => void
}

const textareaCls = cn(fieldCls, 'min-h-24 resize-y py-2')

/** 新建任务弹窗：可指定从哪个阶段开始（默认首阶段） */
export function TaskDialog({
  workflow,
  project,
  defaultPath,
  onSave,
  onCancel,
}: TaskDialogProps): ReactElement {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [stageId, setStageId] = useState(workflow.stages[0]?.id ?? '')
  const [saving, setSaving] = useState(false)

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    try {
      await onSave({
        title,
        description,
        workflowId: workflow.id,
        stageId,
        projectId: project?.id ?? null,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="新建任务" onClose={onCancel}>
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field label="所属项目">
          {/* 只读行：项目在侧栏顶层选好了，弹窗里再放开选择只会让「建在哪个目录」变得含糊 */}
          <div
            aria-label="所属项目"
            className="flex flex-col gap-0.5 rounded-lg border border-line bg-white/[0.04] px-3 py-2"
          >
            <span className="truncate text-body text-ink">{project?.name ?? '默认目录'}</span>
            <span className="truncate text-meta text-ink-faint">
              {project?.path ?? (defaultPath === '' ? '未配置项目时的工作目录' : defaultPath)}
            </span>
          </div>
        </Field>
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
        <p className="text-meta text-ink-faint">「交给智能体」的阶段会立即执行。</p>

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
