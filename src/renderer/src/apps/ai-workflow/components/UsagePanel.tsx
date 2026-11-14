import { useMemo, useState, type ReactElement } from 'react'
import type { UsageAgentRow, UsageDailyRow } from '../../../../../protocol/views'
import { useKernelView, useKernelViewState } from '../../../shell/useKernelView'
import { Panel } from '../../../components/ui/panel'

/** 统计窗口（天）：固定近 7 天，先不做时间选择器（个人自用，够看趋势与今日）。 */
const DAYS = 7

const EMPTY_AGENT_ROWS: UsageAgentRow[] = []

const numberFormat = new Intl.NumberFormat('zh-CN')

const tokenTotal = (row: UsageDailyRow | UsageAgentRow): number =>
  row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens

const money = (value: number): string => `$${value.toFixed(2)}`

interface UsagePanelProps {
  /** 时间源；测试注入固定时刻。窗口时刻只取一次，避免每次渲染都换参数重订阅。 */
  now?: () => string
}

/**
 * 用量面板（M36-E）：近 7 天的轮数 / token / 成本，另按智能体拆一行。
 *
 * 口径由 `usage.daily` / `usage.byAgent` 给：缺 token 或成本的轮次单独计数，
 * 面板照实写「N 轮未报成本」，不把缺失折成 0 让人误以为这轮不花钱。
 * 读路径走 kernelStore 订阅（事实批次到达后自动重取），不用裸 `window.workbench`。
 */
export function UsagePanel({ now }: UsagePanelProps = {}): ReactElement {
  const [at] = useState<string>(() => (now ?? (() => new Date().toISOString()))())
  const params = useMemo(() => ({ days: DAYS, now: at }), [at])

  const dailyState = useKernelViewState('usage.daily', params)
  const byAgent = useKernelView('usage.byAgent', params) ?? EMPTY_AGENT_ROWS
  const agents = useKernelView('agents.all') ?? []
  const daily = dailyState.data ?? []

  const rounds = daily.reduce((sum, row) => sum + row.rounds, 0)
  const tokens = daily.reduce((sum, row) => sum + tokenTotal(row), 0)
  const cost = daily.reduce((sum, row) => sum + row.costUsd, 0)
  const missingCost = daily.reduce((sum, row) => sum + row.missingCost, 0)
  const nameOf = (agentId: string | null): string =>
    agentId === null
      ? '未指定智能体'
      : (agents.find((agent) => agent.id === agentId)?.name ?? agentId)

  return (
    <Panel className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <span className="text-sm text-muted-foreground">近 {DAYS} 天</span>
        <Metric label="轮次" value={numberFormat.format(rounds)} />
        <Metric label="tokens" value={numberFormat.format(tokens)} />
        <Metric label="成本" value={money(cost)} />
        {missingCost > 0 && (
          <span className="text-xs text-warning" role="status">
            {missingCost} 轮未报成本
          </span>
        )}
      </div>

      {dailyState.error !== null && (
        <p className="text-sm text-destructive" role="alert">
          用量读取失败：{dailyState.error}
        </p>
      )}

      {dailyState.loading && dailyState.error === null && (
        <p className="text-sm text-muted-foreground">读取中…</p>
      )}

      {!dailyState.loading && dailyState.error === null && rounds === 0 && (
        <p className="text-sm text-muted-foreground">近 {DAYS} 天还没有已结束的轮次。</p>
      )}

      {!dailyState.loading && dailyState.error === null && byAgent.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="pb-2 font-medium">智能体</th>
              <th className="pb-2 text-right font-medium">轮次</th>
              <th className="pb-2 text-right font-medium">tokens</th>
              <th className="pb-2 text-right font-medium">成本</th>
            </tr>
          </thead>
          <tbody>
            {byAgent.map((row) => (
              <tr key={row.agentId ?? 'none'} className="border-t border-border/60">
                <td className="py-2">{nameOf(row.agentId)}</td>
                <td className="py-2 text-right tabular-nums">{numberFormat.format(row.rounds)}</td>
                <td className="py-2 text-right tabular-nums">
                  {numberFormat.format(tokenTotal(row))}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {money(row.costUsd)}
                  {row.missingCost > 0 && (
                    <span className="ml-1 text-xs text-warning">（{row.missingCost} 轮缺）</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

function Metric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-medium text-foreground tabular-nums">{value}</span>
    </span>
  )
}
