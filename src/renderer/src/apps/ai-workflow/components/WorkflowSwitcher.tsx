import type { ReactElement } from 'react'
import type { WorkflowWithStages } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select'

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
  const active = workflows.find((w) => w.id === activeId)
  const hasActive = active !== undefined
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted py-1 pr-1.5 pl-3 transition-colors duration-150 hover:border-input">
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
          className="text-faint-foreground"
        >
          <rect x="3" y="4" width="5" height="16" rx="1.2" />
          <rect x="10" y="4" width="5" height="10" rx="1.2" />
          <rect x="17" y="4" width="4" height="13" rx="1.2" />
        </svg>
        <span className="text-xs text-faint-foreground">工作流</span>
        <Select value={active?.id ?? ''} onValueChange={onSelect}>
          <SelectTrigger
            aria-label="选择工作流"
            size="sm"
            className="w-auto max-w-56 border-0 bg-transparent px-1 hover:border-0 focus:bg-transparent"
          >
            <SelectValue placeholder="未选择" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">未选择</SelectItem>
            {workflows.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {active && (
          <span className="rounded-sm bg-accent px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
            {active.stages.length} 阶段
          </span>
        )}
      </div>

      {onNew && (
        <Button variant="default" size="sm" onClick={onNew}>
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
