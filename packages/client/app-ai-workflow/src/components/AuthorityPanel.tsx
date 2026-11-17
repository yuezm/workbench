import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type {
  AcceptMode,
  AdmissionCell,
  AdmissionTable,
  Authority,
  SourcePolicy,
} from '@workbench/protocol/authority'
import { DEFAULT_ADMISSION_TABLE } from '@workbench/protocol/authority'
import type { AuthorityView } from '@workbench/protocol/views'
import { Button } from '@workbench/client-ui-primitives/button'
import { Input } from '@workbench/client-ui-primitives/input'
import { Textarea } from '@workbench/client-ui-primitives/textarea'
import { Field } from '@workbench/client-ui-kit/field'
import { Panel, badgeCls } from '@workbench/client-ui-kit/panel'
import { Segmented } from '@workbench/client-ui-kit/segmented'
import { cn } from '@workbench/client-ui-kit/cn'

/** 面板里的一行来源策略：两个名单在界面上是「一行一个」，保存时再拆成数组。 */
interface SourceDraft {
  id: string
  allowed: string
  bots: string
  receiveAll: boolean
  admission: AdmissionTable
}

type ModeDraft = AcceptMode | 'compat'

const MODE_OPTIONS: Array<{ value: ModeDraft; label: string }> = [
  { value: 'compat', label: '兼容' },
  { value: 'off', label: '关闭推断' },
  { value: 'observe', label: '只观察' },
  { value: 'auto', label: '自动接单' },
]

const MODE_HINT: Record<ModeDraft, string> = {
  compat: '不做准入判定：事件命中规则就建任务（当前默认行为）',
  off: '只有名单内、点名的人能发起工作；推断候选一律不接',
  observe: '推断候选交给研判，结论只记「本来会接」，不自动接单',
  auto: '推断候选在研判命中规则后自动接单',
}

const CELLS: Array<{ key: keyof AdmissionTable; label: string }> = [
  { key: 'listedAddressed', label: '名单内 · 点名' },
  { key: 'listedUnaddressed', label: '名单内 · 未点名' },
  { key: 'unlistedAddressed', label: '名单外 · 点名' },
  { key: 'unlistedUnaddressed', label: '名单外 · 未点名' },
  { key: 'botAddressed', label: '机器人' },
]

const CELL_OPTIONS: Array<{ value: AdmissionCell; label: string }> = [
  { value: 'explicit', label: '明确' },
  { value: 'inferred', label: '推断' },
  { value: 'ignore', label: '忽略' },
]

const splitNames = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')

const toDraft = (source: SourcePolicy): SourceDraft => ({
  id: source.id,
  allowed: source.allowed.join('\n'),
  bots: source.bots.join('\n'),
  receiveAll: source.receiveAll,
  admission: { ...source.admission },
})

const blankSource = (): SourceDraft => ({
  id: '',
  allowed: '',
  bots: '',
  receiveAll: false,
  admission: { ...DEFAULT_ADMISSION_TABLE },
})

const draftFrom = (view: AuthorityView | null): { mode: ModeDraft; sources: SourceDraft[] } => {
  if (view === null || view.mode === 'compat') return { mode: 'compat', sources: [] }
  return {
    mode: view.mode,
    sources: view.sources.map(toDraft),
  }
}

/**
 * 设置 → 规则 → 准入（A1）：谁可以让它干活、以什么强度、要不要先观察。
 *
 * 读 `authority.current`，写走 `rules.replace`（与规则同一条版本线）：
 * - `compat` 保存时发 `authority: null`（显式清除，回兼容模式）；
 * - 其余模式发整块 `Authority`，名单按「一行一个」拆开，空行忽略。
 *
 * 不在本地推导命中：`compat` 之外的判定全在内核（`scopes/admission`），这里只编辑配置。
 */
export interface AuthorityPanelProps {
  view: AuthorityView | null
  busy: boolean
  onSave: (authority: Authority | null) => Promise<void>
}

export function AuthorityPanel({ view, busy, onSave }: AuthorityPanelProps): ReactElement {
  const initial = useMemo(() => draftFrom(view), [view])
  const [mode, setMode] = useState<ModeDraft>(initial.mode)
  const [sources, setSources] = useState<SourceDraft[]>(initial.sources)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 视图被整批替换（含别处保存）后，草稿跟着新配置走，避免拿旧草稿覆盖
  useEffect(() => {
    setMode(initial.mode)
    setSources(initial.sources)
    setError(null)
  }, [initial])

  const configured = view !== null && view.mode !== 'compat'
  const dirty = mode !== initial.mode || JSON.stringify(sources) !== JSON.stringify(initial.sources)

  const patch = (index: number, next: Partial<SourceDraft>): void => {
    setSources((current) =>
      current.map((source, at) => (at === index ? { ...source, ...next } : source)),
    )
  }

  const addSource = (): void => {
    setSources((current) => [...current, blankSource()])
  }

  const removeSource = (index: number): void => {
    setSources((current) => current.filter((_, at) => at !== index))
  }

  const save = (): void => {
    setError(null)
    if (mode !== 'compat') {
      const ids = sources.map((source) => source.id.trim())
      if (ids.some((id) => id === '')) {
        setError('每条来源策略都要填来源 id（例如 github / feishu / webhook）')
        return
      }
      if (new Set(ids).size !== ids.length) {
        setError('来源 id 不能重复')
        return
      }
      if (view === null) {
        setError('准入配置还没读到，稍后再试')
        return
      }
    }
    const authority: Authority | null =
      mode === 'compat'
        ? null
        : {
            mode,
            sources: sources.map((source) => ({
              id: source.id.trim(),
              allowed: splitNames(source.allowed),
              bots: splitNames(source.bots),
              receiveAll: source.receiveAll,
              admission: { ...source.admission },
            })),
            // 研判智能体与攒批参数暂不在界面里编辑（A3 落地时接上）
            assessorAgentId: view?.assessorAgentId ?? null,
            assessBatch: view?.assessBatch ?? 8,
            assessWindowMs: view?.assessWindowMs ?? 5000,
          }
    setSaving(true)
    void (async () => {
      try {
        await onSave(authority)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setSaving(false)
      }
    })()
  }

  const disabled = busy || saving

  return (
    <Panel className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">准入</h3>
          <span className={cn(badgeCls)}>{configured ? modeLabel(view?.mode) : '兼容'}</span>
          {view !== null && (
            <span className="text-xs text-faint-foreground">策略 v{view.policyVersion}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={addSource}
          >
            添加来源
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={disabled || !dirty}
            onClick={save}
          >
            {saving ? '保存中…' : '保存准入'}
          </Button>
        </div>
      </div>

      <Segmented
        value={mode}
        onChange={(value) => setMode(value)}
        options={MODE_OPTIONS}
        ariaLabel="接受模式"
      />
      <p className="text-xs text-faint-foreground">{MODE_HINT[mode]}</p>
      {mode === 'compat' && configured && (
        <p className="text-xs text-warning">保存后清除准入配置，回到「命中即建任务」</p>
      )}

      {mode !== 'compat' && sources.length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-faint-foreground">
          还没有来源策略：没列出来的来源会被拒绝（not-listed）。
        </p>
      )}

      {mode !== 'compat' &&
        sources.map((source, index) => (
          <div key={index} className="flex flex-col gap-3 rounded-lg border border-border p-3">
            <div className="flex items-end gap-2">
              <Field label="来源 id" required hint="与事件里的 source 相等，例如 github">
                <Input
                  value={source.id}
                  aria-label={`来源 ${index + 1} 的 id`}
                  onChange={(event) => patch(index, { id: event.target.value })}
                />
              </Field>
              <Button
                type="button"
                variant="quiet-destructive"
                size="sm"
                aria-label={`删除来源 ${index + 1}`}
                disabled={disabled}
                onClick={() => removeSource(index)}
              >
                删除
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="允许的人" hint="一行一个来源内 id；留空表示不额外允许任何人">
                <Textarea
                  value={source.allowed}
                  aria-label={`来源 ${index + 1} 的允许名单`}
                  rows={3}
                  onChange={(event) => patch(index, { allowed: event.target.value })}
                />
              </Field>
              <Field label="允许的机器人" hint="一行一个；只有它们能产生推断候选">
                <Textarea
                  value={source.bots}
                  aria-label={`来源 ${index + 1} 的机器人名单`}
                  rows={3}
                  onChange={(event) => patch(index, { bots: event.target.value })}
                />
              </Field>
            </div>

            <label className="flex items-center gap-2 text-xs text-faint-foreground">
              <input
                type="checkbox"
                className="size-4 accent-[var(--ring)]"
                aria-label={`来源 ${index + 1} 接收未点名消息`}
                checked={source.receiveAll}
                disabled={disabled}
                onChange={(event) => patch(index, { receiveAll: event.target.checked })}
              />
              <span>接收未点名消息（不勾选时未点名一律拒绝）</span>
            </label>

            <div className="flex flex-col gap-2">
              {CELLS.map((cell) => (
                <div key={cell.key} className="flex items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">{cell.label}</span>
                  <Segmented
                    value={source.admission[cell.key]}
                    onChange={(value) =>
                      patch(index, {
                        admission: { ...source.admission, [cell.key]: value },
                      })
                    }
                    options={CELL_OPTIONS}
                    ariaLabel={`来源 ${index + 1} 的「${cell.label}」准入格`}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </Panel>
  )
}

const modeLabel = (mode: AuthorityView['mode'] | undefined): string => {
  switch (mode) {
    case 'off':
      return '关闭推断'
    case 'observe':
      return '只观察'
    case 'auto':
      return '自动接单'
    default:
      return '兼容'
  }
}
