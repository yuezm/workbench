import type { ReactElement } from 'react'
import type { WorkflowWithStages } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { Select } from '../../../components/ui/select'

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
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 py-1 pr-1.5 pl-3 transition-colors duration-150 hover:border-line-strong">
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
        <span className="text-meta text-ink-faint">工作流</span>
        <Select
          ariaLabel="选择工作流"
          value={activeId ?? ''}
          onChange={onSelect}
          options={[
            { value: '', label: '未选择' },
            ...workflows.map((w) => ({ value: w.id, label: w.name })),
          ]}
          className="h-8 w-auto max-w-56 border-0 bg-transparent px-1 hover:border-0 focus:bg-transparent"
        />
        {active && (
          <span className="rounded-sm bg-white/[0.07] px-1.5 py-0.5 text-badge text-ink-dim tabular-nums">
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
