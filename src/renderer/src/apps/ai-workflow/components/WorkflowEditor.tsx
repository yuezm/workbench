import { useState, type ReactElement } from 'react'
import type {
  Agent,
  EntryMode,
  StageInput,
  WorkflowInput,
  WorkflowWithStages,
} from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'
import { Field } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import { panelCls } from '../../../components/ui/panel'
import { Select } from '../../../components/ui/select'
import { cn } from '../../../lib/cn'

interface WorkflowEditorProps {
  workflow: WorkflowWithStages | null
  agents: Agent[]
  onSave: (input: WorkflowInput) => Promise<void>
  onCancel: () => void
}

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
        <Field label="工作流名称" className="w-56">
          <Input
            aria-label="工作流名称"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>
        <Field label="描述" className="min-w-0 flex-1">
          <Input
            aria-label="工作流描述"
            value={draft.description ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </Field>
      </div>

      <div className="flex flex-col gap-3">
        {draft.stages.map((s, i) => (
          <div key={i} className="rounded-xl border border-line bg-white/[0.02] p-3">
            <div className="flex items-end gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-focus/15 text-[11px] font-medium text-focus">
                {i + 1}
              </span>
              <Field label="阶段名" className="min-w-0 flex-1">
                <Input
                  aria-label={`阶段${i + 1}名称`}
                  value={s.name}
                  onChange={(e) => patchStage(i, { name: e.target.value })}
                />
              </Field>
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
              <Field label="进入时">
                <Select
                  ariaLabel={`阶段${i + 1}进入方式`}
                  value={s.entryMode}
                  onChange={(v) => patchStage(i, { entryMode: v as EntryMode })}
                  options={[
                    { value: 'none', label: '不交接' },
                    { value: 'agent', label: '交给智能体' },
                    { value: 'user', label: '交给用户' },
                  ]}
                />
              </Field>
              {s.entryMode === 'agent' && (
                <Field label="智能体">
                  <Select
                    ariaLabel={`阶段${i + 1}智能体`}
                    value={s.agentId ?? ''}
                    onChange={(v) => patchStage(i, { agentId: v || null })}
                    options={[
                      { value: '', label: '（选择）' },
                      ...agents.map((a) => ({ value: a.id, label: a.name })),
                    ]}
                  />
                </Field>
              )}
              <Field label="完成后进入">
                <Select
                  ariaLabel={`阶段${i + 1}完成后进入`}
                  value={s.onCompleteIndex == null ? '' : String(s.onCompleteIndex)}
                  onChange={(v) => patchStage(i, { onCompleteIndex: v === '' ? null : Number(v) })}
                  options={[
                    { value: '', label: '下一阶段/结束' },
                    ...targetOptions.map((t) => ({ value: String(t.i), label: t.name })),
                  ]}
                />
              </Field>
              <Field label="打回退回到">
                <Select
                  ariaLabel={`阶段${i + 1}打回退回到`}
                  value={s.onRejectIndex == null ? '' : String(s.onRejectIndex)}
                  onChange={(v) => patchStage(i, { onRejectIndex: v === '' ? null : Number(v) })}
                  options={[
                    { value: '', label: '上一阶段/原地' },
                    ...targetOptions.map((t) => ({ value: String(t.i), label: t.name })),
                  ]}
                />
              </Field>
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
