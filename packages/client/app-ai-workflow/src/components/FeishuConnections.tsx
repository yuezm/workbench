import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { LarkStatusView } from '@workbench/protocol/ipc'
import type { PluginView } from '@workbench/protocol/plugins'
import { Button } from '@workbench/client-ui-primitives/button'
import { FormError } from '@workbench/client-ui-kit/form-error'
import { badgeCls } from '@workbench/client-ui-kit/panel'
import { toast } from '@workbench/client-ui-kit/toast'
import { cn } from '@workbench/client-ui-kit/cn'
import { getKernelStore } from '@workbench/client-kernel-store'
import {
  connectionHealthOf,
  connectionLabel,
  connectionsOf,
  connectionTarget,
  type ConnectionDraft,
} from '../model/feishu-connections'
import { FeishuAppDialog } from './FeishuAppDialog'
import { FeishuConnectionDialog } from './FeishuConnectionDialog'
import { FeishuStatusCard } from './FeishuStatusCard'

export {
  answerersTextOf,
  connectionHealthOf,
  connectionLabel,
  connectionOfForm,
  connectionsOf,
  connectionTarget,
  statusToneOf,
  targetKindOf,
} from '../model/feishu-connections'
export type { ConnectionDraft, ConnectionTargetKind } from '../model/feishu-connections'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 连接编辑器的打开状态：新建 / 编辑第几条 / 关着 */
type EditorState = { mode: 'create' } | { mode: 'edit'; index: number } | null

/**
 * 飞书连接面板（M45 / 版式重做）。
 *
 * 三层，各管一件事：
 * 1. **状态卡**：本机 lark-cli 现在连的是谁、能不能用、开放平台还差哪一步；
 * 2. **连接列表**：一条连接 = 一个 profile + 一个消息落点 + 一份拍板人名单，行内可编辑 / 移除；
 * 3. **本机应用**：新建 profile、设备码登录、删除 profile 收进独立弹窗（一次只做一件事）。
 *
 * 为什么要这么切：原来这些全摊在同一个面板里——四格状态、一段说明、连接列表、新增连接四格
 * 输入、高级四项、新建 profile 四格、删除 profile 一排、登录一排——同一屏里有 14 个输入控件，
 * 用户分不清哪些格子属于已有连接、哪些属于新连接，也不知道点哪个按钮会发生什么。
 *
 * 口径（与通道一致）：飞书只承载**需要人拍板的卡**——需要你拍板的卡发到这里，点按钮就是答复；
 * 不在飞书里聊天，所以这里没有「派给哪个智能体」这类入站配置。
 *
 * 边界：这里只探测与写配置；secret 单向交给 `lark-cli profile add`（不经工作台落库、不回显）。
 * 登录目标由弹窗自己持有，不借「新增连接」的 profile 选择：两块共用一个值时，新建完 profile
 * 再点登录会落到 lark-cli 当前 profile 上——用户以为登录的是刚建的那个，实际登录的是别的应用。
 */
export function FeishuConnections({ plugin }: { plugin: PluginView }): ReactElement {
  const connections = useMemo(() => connectionsOf(plugin.config['connections']), [plugin.config])
  const [status, setStatus] = useState<LarkStatusView | null>(null)
  const [busy, setBusy] = useState<'status' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState>(null)
  const [appOpen, setAppOpen] = useState(false)

  const refresh = useCallback((): void => {
    setBusy('status')
    void (async () => {
      try {
        setStatus(await window.workbench.lark({ action: 'status' }))
        setError(null)
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(null)
      }
    })()
  }, [])

  // 挂载后立刻探测一次：放到微任务里，避免在 effect 同步阶段改 state（React 会报级联渲染）
  useEffect(() => {
    void Promise.resolve().then(refresh)
  }, [refresh])

  /** 把连接列表写回插件设置（`plugin.set` 只合并 config，不动其它字段） */
  const saveConnections = (next: ConnectionDraft[], message: string): void => {
    setBusy('save')
    setError(null)
    void (async () => {
      try {
        await getKernelStore().dispatch({
          type: 'plugin.set',
          commandId: '',
          pluginId: plugin.id,
          enabled: plugin.enabled,
          config: { connections: JSON.stringify(next) },
        })
        // 成功只浮一句就走：这条提示不需要人确认任何东西，留在版面上反而要人再关一次
        toast(message)
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(null)
      }
    })()
  }

  const submitConnection = (connection: ConnectionDraft): void => {
    if (editor?.mode === 'edit') {
      const next = connections.map((item, at) => (at === editor.index ? connection : item))
      saveConnections(next, `已保存 ${next.length} 条连接`)
    } else {
      const next = [...connections, connection]
      saveConnections(next, `已保存 ${next.length} 条连接`)
    }
    setEditor(null)
  }

  const removeConnection = (index: number): void => {
    const next = connections.filter((_, at) => at !== index)
    saveConnections(next, `已保存 ${next.length} 条连接`)
  }

  const profiles = status?.profiles ?? []
  const toolsBusy = busy !== null

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-foreground">飞书连接</h3>
        <p className="text-xs text-faint-foreground">
          一条连接 = 一个 lark-cli profile = 一个飞书应用：需要你拍板的卡发到这里，点按钮就是答复。
        </p>
      </div>

      <FeishuStatusCard
        status={status}
        error={error}
        busy={busy === 'status'}
        onRefresh={refresh}
      />

      <FormError message={error} onDismiss={() => setError(null)} />

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">连接</span>
          <span className={badgeCls}>{connections.length}</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="ml-auto"
            disabled={toolsBusy}
            onClick={() => setEditor({ mode: 'create' })}
          >
            添加连接
          </Button>
        </div>

        {connections.length === 0 ? (
          <div className="flex flex-col gap-1 rounded-xl border border-dashed border-border px-4 py-4">
            <p className="text-sm text-foreground">还没有连接</p>
            <p className="text-xs text-faint-foreground">
              选一个 profile 添加即可；本机还没有 profile
              时，先去「管理本机应用」新建一个（需要飞书应用的 App ID / App Secret）。
            </p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-muted">
            {connections.map((connection, index) => {
              const label = connectionLabel(connection, index)
              const health = connectionHealthOf(connection, status)
              return (
                <li
                  key={`${label}-${index}`}
                  className="flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 hover:bg-accent"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{label}</span>
                      <span className={cn('rounded-sm px-1.5 py-0.5 text-xs', health.cls)}>
                        {health.text}
                      </span>
                    </span>
                    <span className="truncate text-xs text-faint-foreground">
                      {connection.profile ?? '当前 profile'} · {connectionTarget(connection)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <Button
                      type="button"
                      variant="quiet"
                      size="sm"
                      disabled={toolsBusy}
                      aria-label={`编辑连接 ${label}`}
                      onClick={() => setEditor({ mode: 'edit', index })}
                    >
                      编辑
                    </Button>
                    <Button
                      type="button"
                      variant="quiet-destructive"
                      size="sm"
                      disabled={toolsBusy}
                      aria-label={`移除连接 ${label}`}
                      onClick={() => removeConnection(index)}
                    >
                      移除
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted px-4 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">本机应用（lark-cli profile）</span>
          <span className="text-xs text-faint-foreground">
            新建应用、设备码登录、删除 profile 都收在这里；当前探测到 {profiles.length} 个。
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={badgeCls}>{profiles.length} 个 profile</span>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            disabled={toolsBusy}
            onClick={() => setAppOpen(true)}
          >
            管理本机应用
          </Button>
        </div>
      </div>

      {editor !== null && (
        <FeishuConnectionDialog
          {...(editor.mode === 'edit' ? { connection: connections[editor.index] } : {})}
          profiles={profiles}
          onSubmit={submitConnection}
          onCancel={() => setEditor(null)}
        />
      )}

      {appOpen && (
        <FeishuAppDialog
          profiles={profiles}
          onChanged={refresh}
          onClose={() => setAppOpen(false)}
        />
      )}
    </section>
  )
}
