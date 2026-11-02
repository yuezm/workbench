import { useState, type ReactElement } from 'react'
import type {
  Agent,
  EntryMode,
  StageInput,
  WorkflowInput,
  WorkflowWithStages,
} from '../../../../../shared/ai-workflow-api'

interface WorkflowEditorProps {
  workflow: WorkflowWithStages | null
  agents: Agent[]
  onSave: (input: WorkflowInput) => Promise<void>
  onCancel: () => void
}

const inputCls =
  'rounded-lg border border-line bg-white/[0.03] px-2 py-1 text-sm text-ink outline-none focus:border-focus'

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
    <form
      className="flex flex-col gap-3 rounded-2xl border border-line bg-white/[0.03] p-4"
      onSubmit={save}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-ink-dim">
          工作流名称
          <input
            aria-label="工作流名称"
            className={inputCls}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-xs text-ink-dim">
          描述
          <input
            aria-label="工作流描述"
            className={inputCls}
            value={draft.description ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
        </label>
      </div>

      <ul className="flex flex-col gap-2">
        {draft.stages.map((s, i) => (
          <li key={i} className="flex flex-wrap items-end gap-2 rounded-xl border border-line p-2">
            <label className="flex flex-col gap-1 text-xs text-ink-dim">
              阶段名
              <input
                aria-label={`阶段${i + 1}名称`}
                className={inputCls}
                value={s.name}
                onChange={(e) => patchStage(i, { name: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-dim">
              进入时
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
              <label className="flex flex-col gap-1 text-xs text-ink-dim">
                智能体
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
            <label className="flex flex-col gap-1 text-xs text-ink-dim">
              完成后进入
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
            <label className="flex flex-col gap-1 text-xs text-ink-dim">
              打回退回到
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
            <button
              type="button"
              className="text-xs text-red-400 hover:underline"
              onClick={() => removeStage(i)}
            >
              删除阶段
            </button>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-dim"
          onClick={addStage}
        >
          添加阶段
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-focus/15 px-3 py-1.5 text-sm text-focus disabled:opacity-40"
        >
          保存工作流
        </button>
        <button type="button" className="text-sm text-ink-faint hover:underline" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  )
}
