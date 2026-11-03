import { useState, type ReactElement } from 'react'
import type {
  Agent,
  EntryMode,
  StageInput,
  WorkflowInput,
  WorkflowWithStages,
} from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/cn'

interface WorkflowEditorProps {
  workflow: WorkflowWithStages | null
  agents: Agent[]
  onSave: (input: WorkflowInput) => Promise<void>
  onCancel: () => void
}

const panelCls =
  'rounded-2xl border border-line bg-white/[0.03] backdrop-blur-xl shadow-[0_1px_0_rgb(255_255_255/5%)_inset,0_20px_50px_-30px_rgb(0_0_0/70%)]'
const inputCls =
  'h-9 w-full rounded-lg border border-line bg-black/25 px-3 text-sm text-ink placeholder:text-ink-faint outline-none transition-colors duration-200 hover:border-line-strong focus:border-focus/70 focus:bg-black/35'
const labelCls = 'text-[11px] font-medium tracking-wide text-ink-faint'

function indexOfId(workflow: WorkflowWithStages, id: string | null): number {
  if (!id) return -1
  return workflow.stages.findIndex((s) => s.id === id)
}

function toDraft(workflow: WorkflowWithStages | null): WorkflowInput {
  if (!workflow) {
    return {
      name: '',
      description: '',
      stages: [{ name: '待办', entryMode: 'none', onCompleteIndex: null, onRejectIndex: null }],
    }
  }
  return {
    name: workflow.name,
    description: workflow.description,
    stages: workflow.stages.map((s) => {
      const oc = indexOfId(workflow, s.onCompleteStageId)
      const rj = indexOfId(workflow, s.onRejectStageId)
      return {
        name: s.name,
        entryMode: s.entryMode,
        agentId: s.agentId,
        onCompleteIndex: oc >= 0 ? oc : null,
        onRejectIndex: rj >= 0 ? rj : null,
      }
    }),
  }
}

function WorkflowIcon({ className }: { className?: string }): ReactElement {
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
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M6 8.2v7.6" />
      <path d="M8.2 6h3.3a3.9 3.9 0 0 1 4.3 3.9" />
    </svg>
  )
}

export function WorkflowEditor({
  workflow,
  agents,
  onSave,
  onCancel,
}: WorkflowEditorProps): ReactElement {
  const [draft, setDraft] = useState<WorkflowInput>(() => toDraft(workflow))
  const [saving, setSaving] = useState(false)

  const patchStage = (i: number, patch: Partial<StageInput>): void =>
    setDraft((d) => ({ ...d, stages: d.stages.map((s, k) => (k === i ? { ...s, ...patch } : s)) }))

  const addStage = (): void =>
    setDraft((d) => ({
      ...d,
      stages: [
        ...d.stages,
        {
          name: `阶段${d.stages.length + 1}`,
          entryMode: 'none',
          onCompleteIndex: null,
          onRejectIndex: null,
        },
      ],
    }))

  const removeStage = (i: number): void =>
    setDraft((d) => ({ ...d, stages: d.stages.filter((_, k) => k !== i) }))

  const save = async (ev: React.FormEvent): Promise<void> => {
    ev.preventDefault()
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  const targetOptions = draft.stages.map((s, i) => ({ i, name: s.name || `阶段${i + 1}` }))

  return (
    <form className={cn(panelCls, 'flex animate-rise flex-col gap-5 p-5')} onSubmit={save}>
      <div className="flex items-center gap-2">
        <WorkflowIcon className="text-focus" />
        <div className="flex flex-col">
          <h3 className="text-[13px] font-medium tracking-wide text-ink">工作流定义</h3>
          <p className="text-xs text-ink-faint">配置阶段流转与智能体分工</p>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex w-56 flex-col gap-1.5">
          <span className={labelCls}>工作流名称</span>
          <input
            aria-label="工作流名称"
            className={inputCls}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className={labelCls}>描述</span>
          <input
            aria-label="工作流描述"
            className={inputCls}
            value={draft.description ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </label>
      </div>

      <div className="flex flex-col gap-3">
        {draft.stages.map((s, i) => (
          <div key={i} className="rounded-xl border border-line bg-white/[0.02] p-3">
            <div className="flex items-end gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-focus/15 text-[11px] font-medium text-focus">
                {i + 1}
              </span>
              <label className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className={labelCls}>阶段名</span>
                <input
                  aria-label={`阶段${i + 1}名称`}
                  className={inputCls}
                  value={s.name}
                  onChange={(e) => patchStage(i, { name: e.target.value })}
                />
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300"
                onClick={() => removeStage(i)}
              >
                删除阶段
              </Button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1.5">
                <span className={labelCls}>进入时</span>
                <select
                  aria-label={`阶段${i + 1}进入方式`}
                  className={inputCls}
                  value={s.entryMode}
                  onChange={(e) => patchStage(i, { entryMode: e.target.value as EntryMode })}
                >
                  <option value="none">不交接</option>
                  <option value="agent">交给智能体</option>
                  <option value="user">交给用户</option>
                </select>
              </label>
              {s.entryMode === 'agent' && (
                <label className="flex flex-col gap-1.5">
                  <span className={labelCls}>智能体</span>
                  <select
                    aria-label={`阶段${i + 1}智能体`}
                    className={inputCls}
                    value={s.agentId ?? ''}
                    onChange={(e) => patchStage(i, { agentId: e.target.value || null })}
                  >
                    <option value="">（选择）</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1.5">
                <span className={labelCls}>完成后进入</span>
                <select
                  aria-label={`阶段${i + 1}完成后进入`}
                  className={inputCls}
                  value={s.onCompleteIndex ?? ''}
                  onChange={(e) =>
                    patchStage(i, {
                      onCompleteIndex: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                >
                  <option value="">下一阶段/结束</option>
                  {targetOptions.map((t) => (
                    <option key={t.i} value={t.i}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={labelCls}>打回退回到</span>
                <select
                  aria-label={`阶段${i + 1}打回退回到`}
                  className={inputCls}
                  value={s.onRejectIndex ?? ''}
                  onChange={(e) =>
                    patchStage(i, {
                      onRejectIndex: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                >
                  <option value="">上一阶段/原地</option>
                  {targetOptions.map((t) => (
                    <option key={t.i} value={t.i}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button type="button" variant="secondary" size="sm" onClick={addStage}>
          添加阶段
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={saving} className="ml-auto">
          保存工作流
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  )
}
