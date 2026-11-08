import { useState, type ReactElement } from 'react'
import type { WorkflowWithStages } from '../../../../../protocol/entities'
import type { AutomationRule } from '../../../../../protocol/rules'
import { Button } from '../../../components/ui/button'
import { FormError } from '../../../components/ui/form-error'
import { badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelView, useKernelViewState } from '../../../shell/useKernelView'
import { RuleDialog } from './RuleDialog'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 空态：引用稳定，未就绪时不每次渲染都新建数组 */
const EMPTY_RULES: AutomationRule[] = []

/** 规则 id 由 renderer 生成（内核只校验唯一）；无 WebCrypto 时退化为时间戳 + 计数。 */
let fallbackRuleId = 0
function newRuleId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  fallbackRuleId += 1
  return `rule-${Date.now()}-${fallbackRuleId}`
}

/** 空白新建：名称/条件/目标都由用户在弹窗里填 */
function blankRule(): AutomationRule {
  return {
    id: newRuleId(),
    name: '',
    when: { source: '', types: [] },
    to: { workflowId: '' },
    enabled: true,
  }
}

/**
 * 两个开箱模板：只预填 name / when / prompt，目标工作流留给用户在弹窗里选
 * （工作流必需但本机配置不同，模板不替用户做主）。
 */
const TEMPLATES: Record<'issue' | 'daily', () => AutomationRule> = {
  issue: () => ({
    id: newRuleId(),
    name: 'Issue 进研发',
    when: { source: 'github', types: ['issues.opened'] },
    to: { workflowId: '', task: { titleFrom: 'subject' } },
    enabled: true,
  }),
  daily: () => ({
    id: newRuleId(),
    name: '每日早报',
    when: { cron: '0 9 * * *' },
    to: { workflowId: '' },
    prompt: '汇总昨日进展并给出今日计划',
    enabled: true,
  }),
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

/** 条件摘要：不解释 cron 语义（解析只在内核），只原样展示表达式 */
function conditionLabel(rule: AutomationRule): string {
  return 'cron' in rule.when
    ? `定时 · ${rule.when.cron}`
    : `事件 · ${rule.when.source} · ${rule.when.types.join(', ')}`
}

/**
 * 设置区「规则」页：读 `rules.all`，写一律 `rules.replace` 整批替换。
 *
 * 列表 / 新建 / 编辑 / 删除 / 启停 / 立即运行；保存与启停都基于当前视图做全量
 * 替换（不乐观更新），事实到达后由失效表自动重取。写操作串行：进行中禁用行内
 * 动作，避免两次整批替换互相覆盖。
 */
export function RulesManager(): ReactElement {
  const rulesState = useKernelViewState('rules.all')
  const workflows = useKernelView('workflows.all') ?? []
  /** 项目的候选只用于规则任务的落点（M10）：项目存在与否由内核在触发时再校验 */
  const projects = useKernelView('projects.all') ?? []
  const rules = rulesState.data?.rules ?? EMPTY_RULES
  const version = rulesState.data?.version ?? 0
  const [actionError, setActionError] = useState<string | null>(null)
  const [editing, setEditing] = useState<AutomationRule | null>(null)
  const [isNew, setIsNew] = useState(false)
  /** 整批替换进行中：禁行内动作，防止用旧视图覆盖别人的改动 */
  const [busy, setBusy] = useState(false)
  /** 正在立即运行的规则 id（行内按钮文案） */
  const [runningId, setRunningId] = useState<string | null>(null)

  const error = actionError ?? rulesState.error
  const noWorkflows = workflows.length === 0

  const workflowOf = (id: string): WorkflowWithStages | undefined =>
    workflows.find((item) => item.id === id)

  const targetLabel = (rule: AutomationRule): string => {
    const workflow = workflowOf(rule.to.workflowId)
    if (workflow === undefined) return rule.to.workflowId
    const stage = workflow.stages.find((item) => item.id === rule.to.stageId)
    return stage === undefined ? workflow.name : `${workflow.name} / ${stage.name}`
  }

  const dispatchRules = async (next: AutomationRule[]): Promise<void> => {
    await getKernelStore().dispatch({ type: 'rules.replace', commandId: '', rules: next })
  }

  /** 整批替换：成功后等 `rules.replaced` 失效重取，不在这里改本地列表 */
  const write = (next: AutomationRule[]): void => {
    setBusy(true)
    setActionError(null)
    void (async () => {
      try {
        await dispatchRules(next)
      } catch (e) {
        setActionError(errMsg(e))
      } finally {
        setBusy(false)
      }
    })()
  }

  const toggle = (rule: AutomationRule): void => {
    write(rules.map((item) => (item.id === rule.id ? { ...item, enabled: !item.enabled } : item)))
  }

  const remove = (rule: AutomationRule): void => {
    write(rules.filter((item) => item.id !== rule.id))
  }

  const run = (rule: AutomationRule): void => {
    setRunningId(rule.id)
    setActionError(null)
    void (async () => {
      try {
        await getKernelStore().dispatch({ type: 'rule.trigger', commandId: '', ruleId: rule.id })
      } catch (e) {
        setActionError(errMsg(e))
      } finally {
        setRunningId(null)
      }
    })()
  }

  const open = (rule: AutomationRule, created: boolean): void => {
    setActionError(null)
    setIsNew(created)
    setEditing(rule)
  }

  /** 保存：新建追加、编辑按 id 原位替换，整批发一次 rules.replace */
  const save = async (rule: AutomationRule): Promise<void> => {
    const exists = rules.some((item) => item.id === rule.id)
    const next = exists
      ? rules.map((item) => (item.id === rule.id ? rule : item))
      : [...rules, rule]
    await dispatchRules(next)
    setEditing(null)
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 写命令失败可关掉；读视图失败是持续状态，不给关闭入口 */}
      <FormError
        message={error}
        onDismiss={actionError === null ? undefined : () => setActionError(null)}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-meta text-ink-faint">命中后建任务</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={noWorkflows || busy}
            title={noWorkflows ? '先建工作流' : undefined}
            onClick={() => open(TEMPLATES.issue(), true)}
          >
            Issue 进研发
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={noWorkflows || busy}
            title={noWorkflows ? '先建工作流' : undefined}
            onClick={() => open(TEMPLATES.daily(), true)}
          >
            每日早报
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => open(blankRule(), true)}
          >
            新建规则
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(badgeCls)}>共 {rules.length} 条</span>
        <span className="text-meta text-ink-faint">v{version}</span>
        {noWorkflows && <span className="text-body text-warn">先建工作流</span>}
        {/* 整批写入进行中：整排按钮都会变灰，这里说清原因 */}
        {busy && <span className="text-meta text-ink-faint">正在写入规则…</span>}
      </div>

      {rules.length === 0 ? (
        <p className="grid place-items-center rounded-xl border border-dashed border-line py-6 text-body text-ink-faint">
          暂无规则
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {rules.map((rule) => {
            const running = runningId === rule.id
            return (
              <li
                key={rule.id}
                className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]"
              >
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-white/[0.06] text-ink-dim">
                  <RuleIcon />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-action font-medium text-ink">{rule.name}</span>
                    {!rule.enabled && (
                      <span className="rounded-sm bg-white/[0.06] px-1.5 py-0.5 text-badge text-ink-faint">
                        已停用
                      </span>
                    )}
                  </span>
                  <span className="truncate text-meta text-ink-faint">{conditionLabel(rule)}</span>
                  <span className="truncate text-meta text-ink-faint">
                    → {targetLabel(rule)}
                    {rule.prompt ? ' · 含提示词' : ''}
                  </span>
                </span>

                <div className="flex shrink-0 items-center gap-1">
                  <label className="mr-1 flex items-center gap-1.5 text-meta text-ink-faint">
                    <input
                      type="checkbox"
                      aria-label={`启用规则 ${rule.name}`}
                      className="size-4 accent-[var(--color-focus)]"
                      checked={rule.enabled}
                      disabled={busy}
                      onChange={() => toggle(rule)}
                    />
                    <span>启用</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`立即运行 ${rule.name}`}
                    disabled={busy || runningId !== null || !rule.enabled}
                    onClick={() => run(rule)}
                  >
                    {running ? '运行中…' : '立即运行'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`编辑规则 ${rule.name}`}
                    disabled={busy}
                    onClick={() => open(rule, false)}
                  >
                    编辑
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-danger hover:bg-danger/10 hover:text-danger"
                    aria-label={`删除规则 ${rule.name}`}
                    disabled={busy}
                    onClick={() => remove(rule)}
                  >
                    删除
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {editing !== null && (
        <RuleDialog
          initial={editing}
          isNew={isNew}
          workflows={workflows}
          projects={projects}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}
