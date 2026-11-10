import { useRef, useState, type ReactElement } from 'react'
import type { Project, TaskInput, WorkflowWithStages } from '../../../../../protocol/entities'
import { COMMAND_LIMITS } from '../../../../../protocol/validate'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { FormError } from '../../../components/ui/form-error'
import { Input } from '../../../components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { Textarea } from '../../../components/ui/textarea'

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

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 新建任务弹窗：可指定从哪个阶段开始（默认首阶段）。
 *
 * 校验与反馈（2026-11-08 修）：标题是内核的必填项，所以
 * 1. 标题字段带必填标记（红色星号 + 读屏「必填」）；
 * 2. 空标题点「创建」不再静默 return —— 就地给 `role="alert"` 的文案并把焦点移回标题框；
 * 3. 命令被内核拒绝时把文案留在弹窗里（父级只负责页面级提示），弹窗不关、输入不丢。
 */
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
  /** 标题字段级错误（必填） */
  const [titleError, setTitleError] = useState<string | null>(null)
  /** 表单级错误（命令被拒 / 宿主探测失败） */
  const [formError, setFormError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    const trimmed = title.trim()
    if (trimmed === '') {
      setTitleError('任务标题必填')
      titleRef.current?.focus()
      return
    }
    setTitleError(null)
    setFormError(null)
    setSaving(true)
    try {
      await onSave({
        title: trimmed,
        description: description.trim(),
        workflowId: workflow.id,
        stageId,
        projectId: project?.id ?? null,
      })
    } catch (e) {
      setFormError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      {/* 高度上限 + 内部滚动：长描述不把弹窗顶出视口（SPEC-ui §4「Dialog 的尺寸」） */}
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-3" noValidate onSubmit={submit}>
          <Field label="所属项目">
            {/* 只读行：项目在侧栏顶层选好了，弹窗里再放开选择只会让「建在哪个目录」变得含糊 */}
            <div
              aria-label="所属项目"
              className="flex flex-col gap-0.5 rounded-lg border border-border bg-accent px-3 py-2"
            >
              <span className="truncate text-sm text-foreground">
                {project?.name ?? '默认目录'}
              </span>
              <span className="truncate text-xs text-faint-foreground">
                {project?.path ?? (defaultPath === '' ? '未配置项目时的工作目录' : defaultPath)}
              </span>
            </div>
          </Field>
          <Field label="任务标题" required error={titleError}>
            <Input
              ref={titleRef}
              aria-label="任务标题"
              aria-invalid={titleError !== null}
              // 上限与协议一致（超长会被宿主直接拒），在输入阶段就挡住，别让用户白点一次
              maxLength={COMMAND_LIMITS.title}
              placeholder="起个名字"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                // 一改就撤掉错误：错误跟着输入走，不给用户留一条过期红字
                if (titleError !== null) setTitleError(null)
              }}
            />
          </Field>
          <Field label="任务描述">
            <Textarea
              aria-label="任务描述"
              className="max-h-48 min-h-24 resize-y"
              maxLength={COMMAND_LIMITS.description}
              placeholder="背景、验收标准"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label="起始阶段">
            <Select value={stageId} onValueChange={setStageId}>
              <SelectTrigger aria-label="起始阶段" className="w-full">
                <SelectValue placeholder="请选择" />
              </SelectTrigger>
              <SelectContent>
                {workflow.stages.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <p className="text-xs text-faint-foreground">「交给智能体」的阶段会立即执行。</p>

          <FormError message={formError} />

          <div className="mt-2 flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              取消
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={saving}
              className="disabled:opacity-40"
            >
              创建
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
