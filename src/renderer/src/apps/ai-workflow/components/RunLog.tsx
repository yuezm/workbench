import type { ReactElement } from 'react'
import type { Run } from '../../../../../shared/ai-workflow-api'

interface RunLogProps {
  runs: Run[]
}

export function RunLog({ runs }: RunLogProps): ReactElement {
  if (runs.length === 0) {
    return <p className="px-1 py-2 text-xs text-ink-faint">暂无运行记录</p>
  }
  return (
    <ul className="flex flex-col gap-2">
      {runs.map((r) => (
        <li key={r.id} className="rounded-lg border border-line bg-white/[0.02] p-2 text-xs">
          <div className="flex items-center justify-between text-ink-dim">
            <span className="font-medium text-ink">{r.status}</span>
            <span className="text-ink-faint">{r.startedAt ?? r.createdAt}</span>
          </div>
          {r.error && <p className="mt-1 text-red-400">{r.error}</p>}
          {r.output && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-ink-faint">
              {r.output}
            </pre>
          )}
        </li>
      ))}
    </ul>
  )
}
