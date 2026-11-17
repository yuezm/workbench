import type { ReactElement } from 'react'
import type { LarkStatusView } from '@workbench/protocol/ipc'
import { Button } from '@workbench/client-ui-primitives/button'
import { cn } from '@workbench/client-ui-kit/cn'
import { statusToneOf } from '../model/feishu-connections'

export interface FeishuStatusCardProps {
  status: LarkStatusView | null
  /** 探测失败的原因（只用来判断「未就绪」这一档，文案由面板的错误条播报） */
  error: string | null
  busy: boolean
  onRefresh: () => void
}

/** 状态卡里的一格：标签在上、值在下，路径与 id 用等宽 */
function Meta({
  label,
  value,
  mono = false,
  title,
}: {
  label: string
  value: string
  mono?: boolean
  title?: string
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-faint-foreground">{label}</dt>
      <dd
        className={cn('truncate text-xs text-muted-foreground', mono && 'font-mono')}
        title={title ?? value}
      >
        {value}
      </dd>
    </div>
  )
}

/**
 * 飞书接入状态卡：本机 lark-cli 现在连的是谁、能不能用、还差哪一步。
 *
 * 分工：左边状态点 + 一句话结论（可用 / 待登录 / 未就绪 / 撞车），中间三格本机事实，
 * 底部一行「接入链路」——正常态只有订阅提醒，撞车或探测失败时才多出告警行。
 * 结论只写一次：结论行说状态与应用，清单说 CLI 路径、工作区与身份，不重复同一串信息。
 */
export function FeishuStatusCard({
  status,
  error,
  busy,
  onRefresh,
}: FeishuStatusCardProps): ReactElement {
  const tone = statusToneOf(status, error)
  const appId = status?.appId ?? ''
  const foreign = status?.foreign ?? null
  const hint = status?.hint ?? null
  const conflict = status?.conflict === true

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-muted px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          aria-hidden="true"
          className={cn(
            'size-2 shrink-0 rounded-full',
            tone === null ? 'bg-muted-foreground' : tone.dotCls,
          )}
        />
        <span
          className={cn(
            'text-sm font-medium',
            tone === null ? 'text-muted-foreground' : tone.textCls,
          )}
        >
          {tone === null ? '探测中' : tone.text}
        </span>
        <span className="text-xs text-faint-foreground">当前应用</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {appId === '' ? '—' : appId}
        </span>
        <Button
          type="button"
          variant="quiet"
          size="sm"
          className="ml-auto"
          disabled={busy}
          onClick={onRefresh}
        >
          {busy ? '探测中…' : '重新探测'}
        </Button>
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3">
        <Meta
          label="lark-cli"
          value={status === null ? '探测中…' : (status.program ?? '未找到')}
          title={status?.program ?? ''}
          mono
        />
        <Meta label="工作区" value={status?.workspace ?? '—'} />
        <Meta
          label="身份 / token"
          value={status === null ? '—' : `${status.identity ?? '—'} · ${status.tokenStatus ?? '—'}`}
        />
      </dl>

      {/* 接入链路：把「还差什么」写成一句可执行的话，而不是三段说明 */}
      <div className="flex flex-col gap-1 border-t border-border pt-2">
        {conflict || foreign !== null || hint !== null ? (
          <p className={cn('text-xs', conflict ? 'text-destructive' : 'text-muted-foreground')}>
            {foreign !== null && (
              <>
                别的 agent 绑定在「{foreign.workspace ?? '未知工作区'}」（应用{' '}
                {foreign.appId ?? '未知'}）
                {conflict ? '：与工作台相同，会抢事件长连接，请给工作台换一个应用' : ''}
              </>
            )}
            {foreign === null && hint}
          </p>
        ) : null}
        {foreign !== null && hint !== null && (
          <p className="text-xs text-faint-foreground">{hint}</p>
        )}
        {appId !== '' && (
          <p className="text-xs text-faint-foreground">
            长连接要求开放平台已订阅 card.action.trigger 与
            im.message.receive_v1（订阅状态探测不到， 这里只给入口）——{' '}
            <a
              className="text-brand underline"
              href={`https://open.feishu.cn/app/${appId}/event`}
              target="_blank"
              rel="noreferrer"
            >
              打开「{appId}」的事件与回调
            </a>
          </p>
        )}
      </div>
    </section>
  )
}
