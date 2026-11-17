import { useRef, useState, type ReactElement } from 'react'
import type { Project, TaskInput, WorkflowWithStages } from '@workbench/protocol/entities'
import { COMMAND_LIMITS } from '@workbench/protocol/validate'
import { Button } from '@workbench/client-ui-primitives/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@workbench/client-ui-primitives/dialog'
import { Field } from '@workbench/client-ui-kit/field'
import { FormError } from '@workbench/client-ui-kit/form-error'
import { Input } from '@workbench/client-ui-primitives/input'
import { Segmented } from '@workbench/client-ui-kit/segmented'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workbench/client-ui-primitives/select'
import { Textarea } from '@workbench/client-ui-primitives/textarea'
import {
  BRIEF_MODES,
  BRIEF_TOTAL_LIMIT,
  briefFields,
  briefLength,
  briefModeLabel,
  briefOverflow,
  missingRecommended,
  serializeBrief,
  suggestBriefMode,
  type BriefMode,
} from '../model/task-brief'

interface TaskDialogProps {
  /**
   * 全部工作流（不只是看板当前那一条）：任务像 issue，投给哪条流程由人在这里指定。
   * 调用处保证非空——没有工作流时看板整块不渲染，入口也点不出来。
   */
  workflows: readonly WorkflowWithStages[]
  /** 默认选中的工作流：看板当前停在哪条流程上，就用它当默认值 */
  defaultWorkflowId: string
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
 * 新建任务弹窗：指定投给哪条工作流、从哪个阶段开始（默认当前看板的工作流 + 首阶段）。
 *
 * 工作流可选（M41）：弹窗不再是「当前看板的附属动作」，任务可以在建的时候直接投到
 * 别的工作流——只换 `TaskInput.workflowId`，协议与内核不变：`workflowId` / `currentStageId`
 * 仍是任务的必填归属，不存在「没有工作流」的任务。
 *
 * 描述可按字段填（M43，见 `model/task-brief.ts`）：默认仍是自由文本，切到「需求」/「BUG」
 * 后按字段录入，提交时**序列化成带 `###` 段头的正文**写进同一个 `description`——协议不动、
 * 详情页照 Markdown 渲染，不把文本 parse 回字段（那就有两套真相源）。
 *
 * 选中值的存法：**只存用户点过的那个**，失效就在渲染期派生回落（`workflow` / `stage`），
 * 不用 effect 同步 state——否则切工作流会多一轮渲染，还会在切回来的路上把旧阶段写回去。
 *
 * 校验与反馈（2026-11-08 修，2026-11 仍适用）：标题是内核的必填项，所以
 * 1. 标题字段带必填标记（红色星号 + 读屏「必填」）；
 * 2. 空标题点「创建」不再静默 return —— 就地给 `role="alert"` 的文案并把焦点移回标题框；
 * 3. 命令被内核拒绝时把文案留在弹窗里（父级只负责页面级提示），弹窗不关、输入不丢。
 */
export function TaskDialog({
  workflows,
  defaultWorkflowId,
  project,
  defaultPath,
  onSave,
  onCancel,
}: TaskDialogProps): ReactElement {
  const [title, setTitle] = useState('')
  /** 自由文本模式下的正文（老路径，切到字段组时保留，不丢用户已经写的东西） */
  const [description, setDescription] = useState('')
  /** 字段组模式下的各字段值，按 `BriefField.key` 存 */
  const [briefValues, setBriefValues] = useState<Record<string, string>>({})
  /** 默认自由文本：字段化是可选能力，不在用户没要求时改变填写方式 */
  const [briefMode, setBriefMode] = useState<BriefMode>('free')
  const [workflowId, setWorkflowId] = useState(defaultWorkflowId)
  /** 用户选过的起始阶段；不属于当前工作流时回落到该工作流首阶段 */
  const [chosenStageId, setChosenStageId] = useState('')
  const [saving, setSaving] = useState(false)
  /** 标题字段级错误（必填） */
  const [titleError, setTitleError] = useState<string | null>(null)
  /** 表单级错误（命令被拒 / 宿主探测失败 / 描述超长 / 没有可用阶段） */
  const [formError, setFormError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  const workflow = workflows.find((candidate) => candidate.id === workflowId) ?? workflows[0]
  const stage =
    workflow?.stages.find((candidate) => candidate.id === chosenStageId) ?? workflow?.stages[0]

  /** 描述正文：自由文本原样，字段组序列化成带段头的文本 */
  const body = briefMode === 'free' ? description.trim() : serializeBrief(briefMode, briefValues)
  const overflow = briefOverflow(body)
  const missing = missingRecommended(briefMode, briefValues)
  /** 名字像缺陷类的流程给一句「切过去按字段填」的建议；猜不出就不打扰 */
  const suggestion = suggestBriefMode({
    workflowName: workflow?.name ?? '',
    stageName: stage?.name ?? '',
  })

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    const trimmed = title.trim()
    if (trimmed === '') {
      setTitleError('任务标题必填')
      titleRef.current?.focus()
      return
    }
    // 类型收口用的分支，正常走不到：调用处只在有工作流时渲染本弹窗
    if (workflow === undefined || stage === undefined) {
      setFormError('这条工作流还没有可用的阶段，先到「设置 → 工作流」补一个')
      return
    }
    // 超长会被宿主整条拒绝，别让用户填完才被打回
    if (overflow > 0) {
      setFormError(`任务描述超出上限 ${overflow} 字（含字段段头，上限 ${BRIEF_TOTAL_LIMIT} 字）`)
      return
    }
    setTitleError(null)
    setFormError(null)
    setSaving(true)
    try {
      await onSave({
        title: trimmed,
        description: body,
        workflowId: workflow.id,
        stageId: stage.id,
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
      onOpenChange={() => {
        // Radix 受控弹窗无 Trigger：dismiss 只会发 false，故直接收口
        onCancel()
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
          {/* 描述：填写方式与正文分开两行，先选方式再进去填 */}
          <div className="flex items-center justify-between gap-2">
            <span aria-hidden="true" className="text-xs font-medium text-muted-foreground">
              任务描述
            </span>
            <Segmented
              value={briefMode}
              onChange={setBriefMode}
              options={[...BRIEF_MODES]}
              ariaLabel="描述填写方式"
            />
          </div>
          {briefMode === 'free' ? (
            <Field label="描述正文">
              <Textarea
                aria-label="任务描述"
                className="max-h-48 min-h-24 resize-y"
                maxLength={COMMAND_LIMITS.description}
                placeholder="背景、验收标准"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          ) : (
            <div className="flex flex-col gap-3">
              {briefFields(briefMode).map((field) => (
                <Field key={field.key} label={field.label} hint={field.hint}>
                  <Textarea
                    aria-label={field.label}
                    className="max-h-32 min-h-14 resize-y"
                    maxLength={field.maxLength}
                    value={briefValues[field.key] ?? ''}
                    onChange={(e) =>
                      setBriefValues((current) => ({ ...current, [field.key]: e.target.value }))
                    }
                  />
                </Field>
              ))}
              {/* 建议项只提醒、不阻断：逼人填「影响面」只会换来一句「无」 */}
              {missing.length > 0 && (
                <p className="text-xs text-faint-foreground">建议补上：{missing.join('、')}</p>
              )}
            </div>
          )}
          {suggestion !== null && briefMode === 'free' && (
            <p className="text-xs text-faint-foreground">
              可切「{briefModeLabel(suggestion)}」按字段填
            </p>
          )}
          {overflow > 0 && (
            <p className="text-xs text-destructive">
              描述已用 {briefLength(body)} / {BRIEF_TOTAL_LIMIT} 字，超出 {overflow} 字
            </p>
          )}
          {/* 投递目标放最后：先把任务写清楚（标题 + 描述），再决定投给哪条流程、从哪一步起 */}
          <Field label="所属工作流">
            <Select value={workflow?.id ?? ''} onValueChange={setWorkflowId}>
              <SelectTrigger aria-label="所属工作流" className="w-full">
                <SelectValue placeholder="请选择" />
              </SelectTrigger>
              <SelectContent>
                {workflows.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="起始阶段">
            <Select
              value={stage?.id ?? ''}
              onValueChange={setChosenStageId}
              // 换工作流后阶段列表整批换掉：这里不重置 chosenStageId，由上面的派生回落兜住
            >
              <SelectTrigger aria-label="起始阶段" className="w-full">
                <SelectValue placeholder="请选择" />
              </SelectTrigger>
              <SelectContent>
                {(workflow?.stages ?? []).map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <FormError message={formError} />

          <div className="mt-2 flex items-center justify-end gap-2">
            <Button type="button" variant="quiet" size="sm" onClick={onCancel}>
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
