import type { ReactElement } from 'react'
import type { Run, RunStatus } from '../../../../../shared/ai-workflow-api'
import { cn } from '../../../lib/cn'

interface RunLogProps {
  runs: Run[]
}

/** 运行状态配色：成功绿、失败红、进行中紫、取消灰 */
const STATUS_TONE: Record<RunStatus, string> = {
  queued: 'text-focus',
  running: 'text-focus',
  succeeded: 'text-short',
  failed: 'text-red-400',
  cancelled: 'text-ink-faint',
}

export function RunLog({ runs }: RunLogProps): ReactElement {
  if (runs.length === 0) {
    return (
      <div className="grid place-items-center rounded-xl border border-dashed border-line py-6 text-xs text-ink-faint">
        暂无运行记录
      </div>
    )
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
      {runs.map((r) => (
        <li key={r.id} className="px-4 py-3 transition-colors hover:bg-white/[0.03]">
          <div className="flex items-center justify-between gap-3">
            <span
              className={cn(
                'rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px]',
                STATUS_TONE[r.status],
              )}
            >
              {r.status}
            </span>
            <span className="text-[11px] text-ink-faint tabular-nums">
              {r.startedAt ?? r.createdAt}
            </span>
          </div>
          {r.error && (
            <p className="mt-2 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">
              {r.error}
            </p>
          )}
          {r.output && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-black/30 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-dim">
              {r.output}
            </pre>
          )}
        </li>
      ))}
    </ul>
  )
}
