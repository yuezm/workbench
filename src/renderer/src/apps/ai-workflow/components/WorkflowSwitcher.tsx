import type { ReactElement } from 'react'
import type { WorkflowWithStages } from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'

interface WorkflowSwitcherProps {
  workflows: WorkflowWithStages[]
  activeId: string | undefined
  onSelect: (id: string) => void
  /** 提供时才显示「新建工作流 / 编辑」按钮（看板顶栏只作切换器用） */
  onNew?: () => void
  onEdit?: () => void
}

/** 工作流切换器：下拉选当前工作流；给出 onNew/onEdit 时附带新建/编辑入口 */
export function WorkflowSwitcher({
  workflows,
  activeId,
  onSelect,
  onNew,
  onEdit,
}: WorkflowSwitcherProps): ReactElement {
  const hasActive = Boolean(workflows.find((w) => w.id === activeId))
  const active = workflows.find((w) => w.id === activeId)
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2.5 rounded-xl border border-line bg-black/25 px-3 py-1.5 backdrop-blur-sm transition-colors duration-200 hover:border-line-strong">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="text-ink-faint"
        >
          <rect x="3" y="4" width="5" height="16" rx="1.2" />
          <rect x="10" y="4" width="5" height="10" rx="1.2" />
          <rect x="17" y="4" width="4" height="13" rx="1.2" />
        </svg>
        <span className="text-xs text-ink-faint">工作流</span>
        <select
          aria-label="选择工作流"
          className="max-w-56 appearance-none bg-transparent text-sm text-ink outline-none"
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
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="pointer-events-none -ml-1 text-ink-faint"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        {active && (
          <span className="rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[11px] text-ink-dim tabular-nums">
            {active.stages.length} 阶段
          </span>
        )}
      </div>

      {onNew && (
        <Button variant="primary" size="sm" onClick={onNew}>
          新建工作流
        </Button>
      )}
      {onEdit && (
        <Button variant="secondary" size="sm" disabled={!hasActive} onClick={onEdit}>
          编辑
        </Button>
      )}
    </div>
  )
}
