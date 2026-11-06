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
import { Dialog } from '../../../components/ui/dialog'
import { Field } from '../../../components/ui/field'
import { Input, fieldCls } from '../../../components/ui/input'
import { Select } from '../../../components/ui/select'
import { cn } from '../../../lib/cn'

export interface RuleDialogProps {
  /** 打开时的草稿：新建由模板/空白规则生成，编辑传现有规则（id 原样保留） */
  initial: AutomationRule
  /** true = 新建（标题与预填来自草稿本身） */
  isNew: boolean
  /** 目标工作流候选；为空时禁用保存并提示先建工作流 */
  workflows: WorkflowWithStages[]
  /** 任务落点项目候选（M10，可空 = 未归属）：规则建的任务按它定运行工作目录 */
  projects: Project[]
  /** 保存成功由父级关闭弹窗；失败抛错，文案就地展示 */
  onSubmit: (rule: AutomationRule) => Promise<void>
  onCancel: () => void
}

const textareaCls = cn(fieldCls, 'min-h-20 resize-y py-2 leading-relaxed')

/** 逗号分隔文本 → 去空白后的数组（labels / types 共用） */
const splitList = (text: string): string[] =>
  text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')

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
 * 前端只做三处形状提示（空名 / 未选工作流 / cron 非 5 段），其余语义（工作流存在、
 * cron 合法性、字段上限）交给内核 reject，文案原样展示。
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
   * 项目可空（M10）：老规则没有该字段，空值 = 未归属，提交时不写这个字段。
   * 新建规则默认带上第一个项目——否则新规则会批量产出「未归属」任务（没有工作目录）；
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
  const [error, setError] = useState<string | null>(null)

  const workflow = workflows.find((item) => item.id === workflowId)
  const stageOptions = [
    { value: '', label: '首阶段' },
    ...(workflow?.stages ?? []).map((stage) => ({ value: stage.id, label: stage.name })),
  ]
  const noWorkflow = workflows.length === 0

  /** 换工作流时清掉不属于新工作流的阶段，避免提交悬空 id */
  const changeWorkflow = (nextId: string): void => {
    setWorkflowId(nextId)
    const next = workflows.find((item) => item.id === nextId)
    if (!next?.stages.some((stage) => stage.id === stageId)) setStageId('')
  }

  /** 形状校验（三处）：空名 / 未选工作流 / cron 非 5 段；其余交给内核 */
  const checkFront = (): string | null => {
    if (name.trim() === '') return '规则名称不能为空'
    if (workflowId === '') return '请选择目标工作流'
    if (kind === 'cron' && cron.trim().split(/\s+/).filter(Boolean).length !== 5) {
      return 'cron 需 5 段'
    }
    return null
  }

  const submit = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    const frontError = checkFront()
    if (frontError !== null) {
      setError(frontError)
      return
    }

    const parallelText = parallel.trim()
    const parallelValue = parallelText === '' ? undefined : Number(parallelText)
    if (
      parallelValue !== undefined &&
      (!Number.isInteger(parallelValue) ||
        parallelValue < 1 ||
        parallelValue > RULE_LIMITS.parallel)
    ) {
      setError(`并行数需为 1–${RULE_LIMITS.parallel} 的整数`)
      return
    }

    const when: RuleEventWhen | RuleCronWhen =
      kind === 'cron' ? { cron: cron.trim() } : { source: source.trim(), types: splitList(types) }

    const target: RuleTarget = { workflowId }
    if (stageId !== '') target.stageId = stageId
    // 空值不写：老规则继续「未归属」，否则每次保存都等于给老规则钉一个空项目
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
    <Dialog onClose={onCancel} className="max-w-2xl">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        <div className="flex items-center gap-2">
          <RuleIcon className="text-focus-soft" />
          <div className="flex flex-col">
            <h3 className="text-[13px] font-medium tracking-wide text-ink">
              {isNew ? '新建规则' : '编辑规则'}
            </h3>
            <p className="text-xs text-ink-faint">命中后建任务，派活由阶段决定</p>
          </div>
        </div>

        {noWorkflow && (
          <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-faint">
            先建工作流：规则需要目标工作流。
          </p>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <Field label="规则名称" className="w-56">
            <Input
              aria-label="规则名称"
              maxLength={RULE_LIMITS.name}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="触发方式">
            <Select
              ariaLabel="规则触发方式"
              value={kind}
              onChange={(value) => setKind(value as 'event' | 'cron')}
              options={[
                { value: 'event', label: '事件' },
                { value: 'cron', label: '定时' },
              ]}
            />
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
          <div className="flex flex-col gap-1.5">
            <Field label="cron">
              <Input
                aria-label="cron 表达式"
                className="font-mono"
                maxLength={RULE_LIMITS.cron}
                placeholder="0 9 * * *"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
              />
            </Field>
            <span className="text-[11px] text-ink-faint">分 时 日 月 周</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="目标工作流">
            <Select
              ariaLabel="规则目标工作流"
              value={workflowId}
              onChange={changeWorkflow}
              options={[
                { value: '', label: '选择工作流' },
                ...workflows.map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
          </Field>
          <Field label="起始阶段">
            <Select
              ariaLabel="规则起始阶段"
              value={stageId}
              onChange={setStageId}
              disabled={workflow === undefined}
              options={stageOptions}
            />
          </Field>
          <Field label="项目（可选）">
            <Select
              ariaLabel="规则目标项目"
              value={projectId}
              onChange={setProjectId}
              options={[
                { value: '', label: '未归属' },
                ...projects.map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
          </Field>
          {kind === 'event' && (
            <Field label="标题取自">
              <Select
                ariaLabel="任务标题取字"
                value={titleFrom}
                onChange={(value) => setTitleFrom(value as RuleTitleFrom)}
                options={[
                  { value: 'subject', label: 'subject' },
                  { value: 'summary', label: 'summary' },
                ]}
              />
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
          <textarea
            aria-label="规则提示词"
            className={textareaCls}
            maxLength={RULE_LIMITS.prompt}
            placeholder="追加到本轮提示词"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Field label="并行数">
            <Input
              aria-label="并行数"
              type="number"
              placeholder="默认 1"
              value={parallel}
              onChange={(e) => setParallel(e.target.value)}
            />
          </Field>
          <Field label="合并策略">
            <Select
              ariaLabel="合并策略"
              value={merge}
              onChange={(value) => setMerge(value as RuleMerge | '')}
              options={[
                { value: '', label: '默认' },
                { value: 'subject', label: '按 subject' },
                { value: 'none', label: '不合并' },
              ]}
            />
          </Field>
          <Field label="归并键">
            <Select
              ariaLabel="线程归并键"
              value={keyFrom}
              onChange={(value) => setKeyFrom(value as RuleThreadKeyFrom)}
              options={[
                { value: 'subject', label: 'subject' },
                { value: 'externalRef', label: 'externalRef' },
              ]}
            />
          </Field>
          <Field label="已有任务时">
            <Select
              ariaLabel="线程已有任务时"
              value={onExisting}
              onChange={(value) => setOnExisting(value as RuleOnExisting)}
              options={[
                { value: 'reuse-task', label: '复用任务' },
                { value: 'new-task', label: '新建任务' },
              ]}
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-dim">
          <input
            type="checkbox"
            aria-label="启用规则"
            className="size-4 accent-[var(--color-focus)]"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>启用</span>
        </label>

        {error && (
          <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={saving || noWorkflow}>
            保存
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
