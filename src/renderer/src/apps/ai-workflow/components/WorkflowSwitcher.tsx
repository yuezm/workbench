import type { ReactElement } from 'react'
import type { WorkflowWithStages } from '../../../../../shared/ai-workflow-api'

interface WorkflowSwitcherProps {
  workflows: WorkflowWithStages[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onNew: () => void
  onEdit: () => void
}

export function WorkflowSwitcher({
  workflows,
  activeId,
  onSelect,
  onNew,
  onEdit,
}: WorkflowSwitcherProps): ReactElement {
  const hasActive = Boolean(workflows.find((w) => w.id === activeId))
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="选择工作流"
        className="rounded-lg border border-line bg-white/[0.03] px-2.5 py-1.5 text-sm text-ink outline-none focus:border-focus"
        value={activeId ?? ''}
        onChange={(e) => onSelect(e.target.value)}
      >
        <option value="">（未选择）</option>
        {workflows.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="rounded-lg bg-focus/15 px-3 py-1.5 text-sm text-focus"
        onClick={onNew}
      >
        新建工作流
      </button>
      <button
        type="button"
        disabled={!hasActive}
        className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-dim disabled:opacity-40"
        onClick={onEdit}
      >
        编辑
      </button>
    </div>
  )
}
