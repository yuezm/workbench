import type { ReactElement } from 'react'
import type { Mandate } from '@workbench/protocol/authority'
import { useKernelViewState } from '@workbench/client-shell/useKernelView'
import { FormError } from '@workbench/client-ui-kit/form-error'
import { Panel, badgeCls } from '@workbench/client-ui-kit/panel'
import { cn } from '@workbench/client-ui-kit/cn'

const STRENGTH: Record<Mandate['strength'], string> = {
  explicit: '明确请求',
  inferred: '推断候选',
}

const BASIS: Record<Mandate['basis'], string> = {
  addressed: '点名',
  followup: '跟帖',
  table: '准入表',
  bot: '机器人',
  manual: '手工',
}

const REVOKED: Record<NonNullable<Mandate['revokedReason']>, string> = {
  stop: '人工停止',
  revalidate: '重校验失败',
  policy: '策略变更',
}

const ACCESS: Record<Mandate['scope']['access'], string> = {
  read: '只读',
  edit: '可改',
  full: '全权（可跑命令）',
}

const when = (iso: string): string => {
  const at = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

const byLabel = (mandate: Mandate): string => {
  if (mandate.by.kind === 'manual') return '本机手工创建'
  return `${mandate.by.source} · ${mandate.by.identity.id}`
}

/**
 * 任务详情 → 授权（A2）：这个任务凭什么被执行、范围多大、哪版策略、撤没撤。
 *
 * 只读 `mandates.byTask`；撤销入口仍是「停止执行」（`task.stop` 会在同一批事实里撤销授权），
 * 界面不另造一条写入路径。没有授权行时说明是「兼容模式 / 历史任务」，而不是显示一片空白。
 */
export function MandateSection({
  taskId,
  scopeLabel,
}: {
  taskId: string
  /** 范围里的工作流 / 阶段名（看板已知，内核只存 id） */
  scopeLabel: string
}): ReactElement {
  const state = useKernelViewState('mandates.byTask', { taskId })
  const mandate = state.data ?? null

  if (state.error !== null && mandate === null) {
    return <FormError message={state.error} />
  }

  const revoked = mandate !== null && mandate.revokedAt !== null

  return (
    <Panel className="flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">授权</h3>
        <span
          className={cn(
            badgeCls,
            revoked ? 'text-warning' : mandate === null ? 'text-faint-foreground' : undefined,
          )}
        >
          {mandate === null ? '无记录' : revoked ? '已撤销' : '有效'}
        </span>
        {mandate !== null && (
          <span className="text-xs text-faint-foreground">策略 v{mandate.policyVersion}</span>
        )}
      </div>

      {mandate === null ? (
        <p className="text-xs text-faint-foreground">
          没有授权记录：兼容模式或历史任务。停止执行等高危动作仍受阶段权限约束。
        </p>
      ) : (
        <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">强度</dt>
            <dd className="text-foreground">{STRENGTH[mandate.strength]}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">依据</dt>
            <dd className="text-foreground">{BASIS[mandate.basis]}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">范围</dt>
            <dd className="text-foreground">{scopeLabel}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">权限上限</dt>
            <dd className="text-foreground">{ACCESS[mandate.scope.access]}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">授予</dt>
            <dd className="text-foreground">
              {byLabel(mandate)} · {when(mandate.grantedAt)}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">
              {mandate.revokedReason === null ? '规则' : '撤销'}
            </dt>
            <dd className={revoked ? 'text-warning' : 'text-foreground'}>
              {mandate.revokedReason === null
                ? mandate.ruleIds.length === 0
                  ? '无（手工任务）'
                  : mandate.ruleIds.join(', ')
                : `${REVOKED[mandate.revokedReason]} · ${when(mandate.revokedAt ?? mandate.grantedAt)}`}
            </dd>
          </div>
        </dl>
      )}
    </Panel>
  )
}
