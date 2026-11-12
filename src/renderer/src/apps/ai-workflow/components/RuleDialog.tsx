import { useState, type ReactElement } from 'react'
import type { Project, WorkflowWithStages } from '../../../../../protocol/entities'
import {
  RULE_LIMITS,
  type AutomationRule,
  type RuleCronWhen,
  type RuleEventWhen,
  type RuleMerge,
  type RuleOnExisting,
  type RuleTarget,
  type RuleThreadKeyFrom,
  type RuleTitleFrom,
} from '../../../../../protocol/rules'
import { Button } from '../../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { FormError } from '../../../components/ui/form-error'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'
import { Textarea } from '../../../components/ui/textarea'
import { stageIdAfterWorkflowChange } from '../model/stage-draft'

export interface RuleDialogProps {
  /** 打开时的草稿：新建由模板/空白规则生成，编辑传现有规则（id 原样保留） */
  initial: AutomationRule
  /** true = 新建（标题与预填来自草稿本身） */
  isNew: boolean
  /** 目标工作流候选；为空时禁用保存并提示先建工作流 */
  workflows: WorkflowWithStages[]
  /** 任务落点项目候选（M10，可空 = 默认目录）：规则建的任务按它定运行工作目录 */
  projects: Project[]
  /** 保存成功由父级关闭弹窗；失败抛错，文案就地展示 */
  onSubmit: (rule: AutomationRule) => Promise<void>
  onCancel: () => void
}

/** 逗号分隔文本 → 去空白后的数组（labels / types 共用） */
const splitList = (text: string): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')

/** 前端形状校验能定位的字段 */
type RuleField = 'name' | 'workflow' | 'cron' | 'parallel'

/** 字段 → 控件的 aria-label：下拉没转发 ref，统一按 aria-label 聚焦 */
const FIELD_CONTROL: Record<RuleField, string> = {
  name: '规则名称',
  workflow: '规则目标工作流',
  cron: 'cron 表达式',
  parallel: '并行数',
}

function focusControl(form: HTMLFormElement, label: string): void {
  form.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.focus()
}

function RuleIcon({ className }: { className?: string }): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M13 3 5 13h5l-1 8 8-11h-5z" />
    </svg>
  )
}

/**
 * 规则表单弹窗：条件（事件 / cron）、目标工作流与阶段、任务标题来源与标签、
 * 追加提示词、并行/合并/线程字段、启用开关。
 *
 * 前端做四类形状校验（空名 / 未选工作流 / cron 非 5 段 / 并行数越界）：错误挂在对应
 * 字段上（`role="alert"`）并把焦点移过去；其余语义（工作流存在、cron 合法性、字段上限）
 * 交给内核 reject，文案原样展示在弹窗底部，弹窗不关、输入不丢。
 */
export function RuleDialog({
  initial,
  isNew,
  workflows,
  projects,
  onSubmit,
  onCancel,
}: RuleDialogProps): ReactElement {
  const initialCron = 'cron' in initial.when
  const initialEvent = 'cron' in initial.when ? null : initial.when
  const [name, setName] = useState(initial.name)
  const [kind, setKind] = useState<'event' | 'cron'>(initialCron ? 'cron' : 'event')
  const [source, setSource] = useState(initialEvent?.source ?? '')
  const [types, setTypes] = useState(initialEvent?.types.join(', ') ?? '')
  const [cron, setCron] = useState('cron' in initial.when ? initial.when.cron : '')
  const [workflowId, setWorkflowId] = useState(initial.to.workflowId)
  const [stageId, setStageId] = useState(initial.to.stageId ?? '')
  /**
   * 项目可空（M10）：老规则没有该字段，空值 = 默认目录（M11 口径），提交时不写这个字段。
   * 新建规则默认带上第一个项目——否则新规则会批量产出落默认目录的任务（没有项目工作目录）；
   * 编辑老规则保持原样，不替用户改写归属。
   */
  const [projectId, setProjectId] = useState(
    initial.to.projectId ?? (isNew ? (projects[0]?.id ?? '') : ''),
  )
  const [titleFrom, setTitleFrom] = useState<RuleTitleFrom>(initial.to.task?.titleFrom ?? 'subject')
  const [labels, setLabels] = useState((initial.to.task?.labels ?? []).join(', '))
  const [prompt, setPrompt] = useState(initial.prompt ?? '')
  const [parallel, setParallel] = useState(
    initial.parallel === undefined ? '' : String(initial.parallel),
  )
  const [merge, setMerge] = useState<RuleMerge | ''>(initial.merge ?? '')
  const [keyFrom, setKeyFrom] = useState<RuleThreadKeyFrom>(initial.to.thread?.keyFrom ?? 'subject')
  const [onExisting, setOnExisting] = useState<RuleOnExisting>(
    initial.to.thread?.onExisting ?? 'reuse-task',
  )
  const [enabled, setEnabled] = useState(initial.enabled)
  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RuleField, string>>>({})
  const [error, setError] = useState<string | null>(null)

  const workflow = workflows.find((item) => item.id === workflowId)
  const stageOptions = [
    { value: '', label: '首阶段' },
    ...(workflow?.stages ?? []).map((stage) => ({ value: stage.id, label: stage.name })),
  ]
  const noWorkflow = workflows.length === 0

  /** 按钮禁用必须伴随可见原因（点不动又不说为什么，等于静默失败） */
  const disabledHint = noWorkflow ? '没有可选工作流：先到「工作流」新建一个再回来。' : null

  /** 清掉某个字段的错误：用户一改就不再挂着旧红字 */
  const clearError = (field: RuleField): void => {
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }))
  }

  /** 换工作流时清掉不属于新工作流的阶段，避免提交悬空 id */
  const changeWorkflow = (nextId: string): void => {
    setWorkflowId(nextId)
    clearError('workflow')
    const next = workflows.find((item) => item.id === nextId)
    setStageId(stageIdAfterWorkflowChange(next?.stages, stageId))
  }

  /** 形状校验：返回第一个出错的字段与文案（错误要挂在字段上，不丢到底部一句） */
  const validate = (): { field: RuleField; message: string } | null => {
    if (name.trim() === '') return { field: 'name', message: '规则名称不能为空' }
    if (workflowId === '') return { field: 'workflow', message: '请选择目标工作流' }
    if (kind === 'cron' && cron.trim().split(/\s+/).filter(Boolean).length !== 5) {
      return { field: 'cron', message: 'cron 需 5 段' }
    }
    const parallelText = parallel.trim()
    if (parallelText !== '') {
      const value = Number(parallelText)
      // 非法值给文案，不静默回落成默认 1：用户以为填了 0 就是 0
      if (!Number.isInteger(value) || value < 1 || value > RULE_LIMITS.parallel) {
        return { field: 'parallel', message: `并行数需为 1–${RULE_LIMITS.parallel} 的整数` }
      }
    }
    return null
  }

  const submit = async (ev: React.FormEvent<HTMLFormElement>): Promise<void> => {
    ev.preventDefault()
    setError(null)

    const problem = validate()
    if (problem !== null) {
      setFieldErrors({ [problem.field]: problem.message })
      focusControl(ev.currentTarget, FIELD_CONTROL[problem.field])
      return
    }
    setFieldErrors({})

    const parallelText = parallel.trim()
    const parallelValue = parallelText === '' ? undefined : Number(parallelText)

    const when: RuleEventWhen | RuleCronWhen =
      kind === 'cron' ? { cron: cron.trim() } : { source: source.trim(), types: splitList(types) }

    const target: RuleTarget = { workflowId }
    if (stageId !== '') target.stageId = stageId
    // 空值不写：老规则继续落默认目录，否则每次保存都等于给老规则钉一个空项目
    if (projectId !== '') target.projectId = projectId
    const task: NonNullable<RuleTarget['task']> = {}
    if (kind === 'event' || initial.to.task?.titleFrom !== undefined) task.titleFrom = titleFrom
    const labelList = splitList(labels)
    if (labelList.length > 0) task.labels = labelList
    if (task.titleFrom !== undefined || task.labels !== undefined) target.task = task
    target.thread = { keyFrom, onExisting }

    const rule: AutomationRule = { id: initial.id, name: name.trim(), when, to: target, enabled }
    if (prompt.trim() !== '') rule.prompt = prompt.trim()
    if (parallelValue !== undefined) rule.parallel = parallelValue
    if (merge !== '') rule.merge = merge

    setSaving(true)
    setError(null)
    try {
      await onSubmit(rule)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RuleIcon className="text-brand" />
            {isNew ? '新建规则' : '编辑规则'}
          </DialogTitle>
          <DialogDescription>命中后建任务，派活由阶段决定</DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {noWorkflow && (
            <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-faint-foreground">
              先建工作流：规则需要目标工作流。
            </p>
          )}

          {/*
            这一行用 `items-start`，不用 `items-end`：`Field` 是 flex-col 整块，名称字段
            多一行 hint（+ 可能的错误行），触发方式没有；底对齐会把「触发方式」整块压到
            与 hint 底边齐平，标签和下拉都低一行——肉眼就是两列没对齐。
          */}
          <div className="flex flex-wrap items-start gap-3">
            <Field
              label="规则名称"
              required
              hint={`最多 ${RULE_LIMITS.name} 字，保存时去掉首尾空格`}
              error={fieldErrors.name ?? null}
              className="w-56"
            >
              <Input
                aria-label="规则名称"
                maxLength={RULE_LIMITS.name}
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  clearError('name')
                }}
              />
            </Field>
            <Field label="触发方式" className="w-40">
              <Select
                value={kind}
                onValueChange={(value) => {
                  setKind(value as 'event' | 'cron')
                  clearError('cron')
                }}
              >
                <SelectTrigger aria-label="规则触发方式" className="w-full">
                  <SelectValue placeholder="请选择" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="event">事件</SelectItem>
                  <SelectItem value="cron">定时</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {kind === 'event' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="事件来源">
                <Input
                  aria-label="规则事件来源"
                  maxLength={RULE_LIMITS.source}
                  placeholder="github / app:pomodoro / *"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              </Field>
              <Field label="事件类型">
                <Input
                  aria-label="规则事件类型"
                  placeholder="issues.opened, issues.closed"
                  value={types}
                  onChange={(e) => setTypes(e.target.value)}
                />
              </Field>
            </div>
          ) : (
            <Field label="cron" required hint="分 时 日 月 周" error={fieldErrors.cron ?? null}>
              <Input
                aria-label="cron 表达式"
                className="font-mono"
                maxLength={RULE_LIMITS.cron}
                placeholder="0 9 * * *"
                value={cron}
                onChange={(e) => {
                  setCron(e.target.value)
                  clearError('cron')
                }}
              />
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="目标工作流" required error={fieldErrors.workflow ?? null}>
              {/* 空值项（未选）显示 placeholder：placeholder 文案 = 该空值项的标签 */}
              <Select value={workflowId} onValueChange={changeWorkflow}>
                <SelectTrigger aria-label="规则目标工作流" className="w-full">
                  <SelectValue placeholder="选择工作流" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">选择工作流</SelectItem>
                  {workflows.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="起始阶段">
              <Select value={stageId} onValueChange={setStageId} disabled={workflow === undefined}>
                <SelectTrigger aria-label="规则起始阶段" className="w-full">
                  <SelectValue placeholder="首阶段" />
                </SelectTrigger>
                <SelectContent>
                  {stageOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="项目（可选）">
              {/* M11：空值 = 不指定项目 → 任务落默认目录（与聊天同口径） */}
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger aria-label="规则目标项目" className="w-full">
                  <SelectValue placeholder="默认目录" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">默认目录</SelectItem>
                  {projects.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {kind === 'event' && (
              <Field label="标题取自">
                <Select
                  value={titleFrom}
                  onValueChange={(value) => setTitleFrom(value as RuleTitleFrom)}
                >
                  <SelectTrigger aria-label="任务标题取字" className="w-full">
                    <SelectValue placeholder="请选择" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="subject">subject</SelectItem>
                    <SelectItem value="summary">summary</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field label="标签">
              <Input
                aria-label="任务标签"
                placeholder="bug, p1"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
              />
            </Field>
          </div>

          <Field label="追加提示词">
            <Textarea
              aria-label="规则提示词"
              className="min-h-20 resize-y"
              maxLength={RULE_LIMITS.prompt}
              placeholder="追加到本轮提示词"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Field
              label="并行数"
              hint={`留空 = 1，最大 ${RULE_LIMITS.parallel}`}
              error={fieldErrors.parallel ?? null}
            >
              <Input
                aria-label="并行数"
                type="number"
                placeholder="默认 1"
                value={parallel}
                onChange={(e) => {
                  setParallel(e.target.value)
                  clearError('parallel')
                }}
              />
            </Field>
            <Field label="合并策略">
              <Select value={merge} onValueChange={(value) => setMerge(value as RuleMerge | '')}>
                <SelectTrigger aria-label="合并策略" className="w-full">
                  <SelectValue placeholder="默认" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">默认</SelectItem>
                  <SelectItem value="subject">按 subject</SelectItem>
                  <SelectItem value="none">不合并</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="归并键">
              <Select
                value={keyFrom}
                onValueChange={(value) => setKeyFrom(value as RuleThreadKeyFrom)}
              >
                <SelectTrigger aria-label="线程归并键" className="w-full">
                  <SelectValue placeholder="请选择" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subject">subject</SelectItem>
                  <SelectItem value="externalRef">externalRef</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="已有任务时">
              <Select
                value={onExisting}
                onValueChange={(value) => setOnExisting(value as RuleOnExisting)}
              >
                <SelectTrigger aria-label="线程已有任务时" className="w-full">
                  <SelectValue placeholder="请选择" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reuse-task">复用任务</SelectItem>
                  <SelectItem value="new-task">新建任务</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Label className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
            <input
              type="checkbox"
              aria-label="启用规则"
              className="size-4 accent-[var(--ring)]"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>启用</span>
          </Label>

          <FormError message={error} onDismiss={() => setError(null)} />

          <div className="flex flex-col gap-2">
            {disabledHint !== null && (
              <p className="text-xs text-faint-foreground">{disabledHint}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
                取消
              </Button>
              <Button type="submit" variant="default" size="sm" disabled={saving || noWorkflow}>
                保存
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
