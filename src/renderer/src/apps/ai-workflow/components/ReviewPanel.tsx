import { useState, type ReactElement } from 'react'
import type { ReviewFinding, ReviewReport } from '../../../../../protocol/review'
import { Button } from '../../../components/ui/button'
import { badgeCls } from '../../../components/ui/panel'
import { FormError } from '../../../components/ui/form-error'

const SEVERITY_LABEL: Record<ReviewFinding['severity'], string> = {
  blocker: '阻断',
  high: '高',
  medium: '中',
  low: '低',
}

const STATUS_LABEL: Record<ReviewFinding['status'], string> = {
  open: '待处理',
  addressed: '已修',
  rejected: '不改',
  deferred: '延后',
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface ReviewPanelProps {
  /** 该任务的评审报告（`reviews.byTask`，按 rev 升序） */
  reports: ReviewReport[]
  /** 「提升为文档」：页面注入，成功返回落盘路径；失败抛错（这里就地展示） */
  onExport: (reportId: string) => Promise<string>
}

/**
 * 评审结论面板（M14 的 S5）：任务详情里把「这份任务被评过什么」摆出来。
 *
 * 只读投影：判定、判定证据、待改清单与逐条状态都在这里。清单正文在 `<userData>/artifacts`
 * （应用数据，不进仓库），需要进仓库时人点「提升为文档」→ 宿主写到 `<项目>/docs/reviews/`。
 * 多个 `rev` 时只展开最新一版，历史版本给一行计数（旧结论不覆盖，但不占版面）。
 */
export function ReviewPanel({ reports, onExport }: ReviewPanelProps): ReactElement {
  const [busy, setBusy] = useState(false)
  const [path, setPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latest = reports[reports.length - 1]

  if (latest === undefined) {
    return (
      <section aria-label="评审结论" className="flex flex-col gap-2">
        <h3 className="text-base font-medium text-foreground">评审结论</h3>
        <p className="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-faint-foreground">
          这个任务还没有评审结论（进入评审阶段并给出判定后，清单会出现在这里）。
        </p>
      </section>
    )
  }

  const open = latest.findings.filter((finding) => finding.status === 'open').length
  const verdictCls =
    latest.verdict === 'fail'
      ? 'bg-warning/15 text-warning'
      : latest.verdict === 'pass'
        ? 'bg-success/15 text-success'
        : 'bg-accent text-muted-foreground'

  const exportDoc = (): void => {
    setBusy(true)
    setError(null)
    setPath(null)
    void onExport(latest.id)
      .then((target) => setPath(target))
      .catch((e: unknown) => setError(errMsg(e)))
      .finally(() => setBusy(false))
  }

  return (
    <section aria-label="评审结论" className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
        评审结论
        <span className={badgeCls}>rev {latest.rev}</span>
        <span className={`rounded-sm px-1.5 py-0.5 text-xs ${verdictCls}`}>
          {latest.verdict === null ? '无判定' : latest.verdict}
        </span>
        {open > 0 && <span className={badgeCls}>待处理 {open}</span>}
        {reports.length > 1 && (
          <span className="text-xs text-faint-foreground">
            另有 {reports.length - 1} 个历史版本
          </span>
        )}
      </h3>

      {latest.checks.length > 0 && (
        <ul aria-label="判定证据" className="flex flex-col gap-1">
          {latest.checks.map((check) => (
            <li key={`${check.cmd}-${check.exitCode}`} className="text-xs text-muted-foreground">
              <code className="rounded-sm bg-accent px-1 py-0.5">{check.cmd}</code> → 退出码{' '}
              <span className={check.exitCode === 0 ? 'text-success' : 'text-warning'}>
                {check.exitCode}
              </span>
            </li>
          ))}
        </ul>
      )}

      {latest.findings.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-2 text-sm text-faint-foreground">
          这份评审没有列出待改条目。
        </p>
      ) : (
        <ul aria-label="待改清单" className="flex flex-col gap-1.5">
          {latest.findings.map((finding) => (
            <li
              key={finding.id}
              className="flex flex-col gap-1 rounded-xl border border-border bg-accent px-3 py-2"
            >
              <div className="flex items-center gap-2 text-sm text-foreground">
                <span className="shrink-0 font-medium">{finding.key}</span>
                <span
                  className={
                    finding.severity === 'blocker' || finding.severity === 'high'
                      ? 'shrink-0 rounded-sm bg-warning/15 px-1.5 py-0.5 text-xs text-warning'
                      : 'shrink-0 rounded-sm bg-accent px-1.5 py-0.5 text-xs text-muted-foreground'
                  }
                >
                  {SEVERITY_LABEL[finding.severity]}
                </span>
                {finding.location !== null && (
                  <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {finding.location}
                  </code>
                )}
                <span
                  className={
                    finding.status === 'open'
                      ? 'shrink-0 rounded-sm bg-warning/15 px-1.5 py-0.5 text-xs text-warning'
                      : 'shrink-0 rounded-sm bg-success/15 px-1.5 py-0.5 text-xs text-success'
                  }
                >
                  {STATUS_LABEL[finding.status]}
                </span>
              </div>
              <p className="text-sm text-foreground">{finding.claim}</p>
              <p className="text-xs text-muted-foreground">验收：{finding.requiredAction}</p>
              {finding.note !== null && (
                <p className="text-xs text-muted-foreground">说明：{finding.note}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          title="把这个版本的评审报告写进项目的 docs/reviews/（由你决定何时提交）"
          onClick={exportDoc}
        >
          {busy ? '正在写文件…' : '提升为文档'}
        </Button>
        {path !== null && (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={path}>
            已写入 {path}
          </span>
        )}
      </div>
      <FormError message={error} />
    </section>
  )
}
