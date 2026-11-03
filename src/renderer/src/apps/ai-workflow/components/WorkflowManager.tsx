import type { ReactElement } from 'react'
import type { WorkflowWithStages } from '../../../../../shared/ai-workflow-api'
import { Button } from '../../../components/ui/button'

interface WorkflowManagerProps {
  workflows: WorkflowWithStages[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onEdit: (workflow: WorkflowWithStages) => void
  onNew: () => void
}

/** 设置区的工作流清单：新建 / 选择 / 编辑工作流定义 */
export function WorkflowManager({
  workflows,
  activeId,
  onSelect,
  onEdit,
  onNew,
}: WorkflowManagerProps): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-faint">
          {workflows.length > 0
            ? '工作流定义决定看板的阶段与流转规则。'
            : '还没有工作流，先新建一条。'}
        </p>
        <Button variant="primary" size="sm" onClick={onNew}>
          新建工作流
        </Button>
      </div>

      {workflows.length === 0 ? (
        <p className="grid place-items-center rounded-xl border border-dashed border-line py-6 text-xs text-ink-faint">
          暂无工作流
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {workflows.map((w) => {
            const active = w.id === activeId
            return (
              <li
                key={w.id}
                className={
                  active
                    ? 'flex items-center gap-3 bg-focus/[0.06] px-4 py-3'
                    : 'flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]'
                }
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 flex-col items-start text-left outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
                  onClick={() => onSelect(w.id)}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-ink">
                    {w.name}
                    {active && (
                      <span className="rounded-full bg-focus/15 px-1.5 py-0.5 text-[11px] text-focus">
                        当前
                      </span>
                    )}
                  </span>
                  <span className="text-[11px] text-ink-faint">
                    {w.stages.length} 阶段
                    {w.description ? ` · ${w.description}` : ''}
                  </span>
                </button>
                <Button variant="ghost" size="sm" onClick={() => onEdit(w)}>
                  编辑
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
