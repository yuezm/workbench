import { Fragment, useState, type ReactElement } from 'react'
import { XIcon } from 'lucide-react'
import type { LarkLoginStart, LarkProfileView } from '@workbench/protocol/ipc'
import { Button } from '@workbench/client-ui-primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@workbench/client-ui-primitives/dialog'
import { Field } from '@workbench/client-ui-kit/field'
import { FormError } from '@workbench/client-ui-kit/form-error'
import { Input } from '@workbench/client-ui-primitives/input'
import { toast } from '@workbench/client-ui-kit/toast'
import { cn } from '@workbench/client-ui-kit/cn'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface FeishuAppDialogProps {
  profiles: readonly LarkProfileView[]
  /** 新建 / 删除 profile 之后要求面板重探一次（profile 列表来自 CLI，不本地推导） */
  onChanged: () => void
  onClose: () => void
}

/** 正在进行的动作：新建 / 发起登录 / 轮询授权 / 删除，其余为空闲 */
type Busy = 'add' | 'login' | 'poll' | 'remove' | null

/** profile 行里的「token 状态」徽标：有 token 才显示成功色，其余一律未登录 */
function tokenTone(profile: LarkProfileView): { text: string; cls: string } {
  if (profile.tokenStatus !== null && profile.tokenStatus !== '') {
    return { text: profile.tokenStatus, cls: 'bg-success/15 text-success' }
  }
  return { text: '未登录', cls: 'bg-warning/15 text-warning' }
}

/**
 * 本机飞书应用管理：一张 profile 表 + 行内操作。
 *
 * profile 本身就是列表数据（名字 / 应用 / 登录人 / token 状态），所以按表格铺开：
 * 新建是顶部主操作，登录与删除是行内操作——登录进行中的授权指引挂在该行下面，
 * 删除只有点开的那一行进确认态，不打断别的行。分段控件（新建 / 登录 / 删除）会把
 * 「这台机器上有哪几个应用、各自什么状态」这一层信息拆散到三屏里，看不了全貌。
 *
 * 边界：secret 单向交给 `lark-cli profile add`（不经工作台落库、不回显）；
 * 删除 profile 连带它的 App Secret 与登录 token，先抬一次确认态。
 */
export function FeishuAppDialog({
  profiles,
  onChanged,
  onClose,
}: FeishuAppDialogProps): ReactElement {
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(profiles.length === 0)
  const [app, setApp] = useState({ name: '', appId: '', secret: '' })
  /** 登录进行中的那一行与它的设备码（同一时刻只登一个） */
  const [login, setLogin] = useState<(LarkLoginStart & { profile: string }) | null>(null)
  /** 正在发起登录的 profile：设备码还没回来时也要让那一行显示「发起中…」 */
  const [loginPending, setLoginPending] = useState<string | null>(null)
  /** 进确认态的删除目标 */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const addProfile = (): void => {
    setBusy('add')
    setError(null)
    void (async () => {
      try {
        const name = app.name.trim()
        const result = await window.workbench.lark({
          action: 'add-profile',
          name,
          appId: app.appId.trim(),
          secret: app.secret,
        })
        if (!result.ok) {
          setError(result.error ?? '新建 profile 失败')
          return
        }
        toast(`已新建 profile「${name}」`)
        setApp({ name: '', appId: '', secret: '' })
        setCreating(false)
        onChanged()
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(null)
      }
    })()
  }

  const startLogin = (name: string): void => {
    setBusy('login')
    setLoginPending(name)
    setError(null)
    setLogin(null)
    void (async () => {
      try {
        const result = await window.workbench.lark({ action: 'login-start', profile: name })
        if (!result.ok) {
          setError(result.error ?? '发起登录失败')
          return
        }
        setLogin({ ...result, profile: name })
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(null)
        setLoginPending(null)
      }
    })()
  }

  const finishLogin = (): void => {
    if (login === null || login.deviceCode === undefined) return
    // 上面已排除 deviceCode === undefined：就地取出（const 收窄），闭包里不必再兜底
    const deviceCode = login.deviceCode
    const profile = login.profile
    setBusy('poll')
    setError(null)
    void (async () => {
      try {
        const result = await window.workbench.lark({
          action: 'login-poll',
          deviceCode,
          profile,
        })
        if (!result.ok) {
          setError(result.error ?? '还没完成授权，稍后再点一次')
          return
        }
        toast('登录完成')
        setLogin(null)
        onChanged()
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(null)
      }
    })()
  }

  const removeProfile = (name: string): void => {
    setBusy('remove')
    setError(null)
    void (async () => {
      try {
        const result = await window.workbench.lark({ action: 'remove-profile', name })
        if (!result.ok) {
          setError(result.error ?? '删除 profile 失败')
          return
        }
        toast(`已删除 profile「${name}」`)
        // 删掉的那一行不该留着展开的授权指引，也不该留在确认态
        setLogin((current) => (current?.profile === name ? null : current))
        setConfirmRemove(null)
        onChanged()
      } catch (e) {
        setError(errMsg(e))
      } finally {
        setBusy(null)
      }
    })()
  }

  const renderCreate = (): ReactElement => (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted px-3 py-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="profile 名">
          <Input
            aria-label="新 profile 名"
            placeholder="如 workbench"
            value={app.name}
            onChange={(e) => setApp((current) => ({ ...current, name: e.target.value }))}
          />
        </Field>
        <Field label="App ID">
          <Input
            aria-label="飞书 App ID"
            placeholder="cli_xxxxxxxx"
            value={app.appId}
            onChange={(e) => setApp((current) => ({ ...current, appId: e.target.value }))}
          />
        </Field>
        <Field label="App Secret" hint="只交给 lark-cli，不落工作台库">
          <Input
            type="password"
            autoComplete="new-password"
            aria-label="飞书 App Secret"
            value={app.secret}
            onChange={(e) => setApp((current) => ({ ...current, secret: e.target.value }))}
          />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <p className="text-xs text-faint-foreground">建完点「登录」做一次设备码授权。</p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button type="button" variant="quiet" size="sm" onClick={() => setCreating(false)}>
            取消
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={busy !== null}
            onClick={addProfile}
          >
            {busy === 'add' ? '新建中…' : '创建 profile'}
          </Button>
        </div>
      </div>
    </div>
  )

  return (
    <Dialog
      open
      onOpenChange={() => {
        onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>本机飞书应用</DialogTitle>
          <DialogDescription>
            一个 profile = 一个飞书应用（App ID + Secret + 登录 token）；增删只改本机 lark-cli。
          </DialogDescription>
        </DialogHeader>

        <FormError message={error} onDismiss={() => setError(null)} />

        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">profile</span>
          <span className="rounded-sm bg-accent px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
            {profiles.length} 个
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="ml-auto"
            disabled={busy !== null || creating}
            onClick={() => setCreating(true)}
          >
            新建 profile
          </Button>
        </div>

        {creating && renderCreate()}

        {profiles.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-faint-foreground">
            还没有 profile，先在上面新建（要 App ID / App Secret）。
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-muted text-xs text-faint-foreground">
                  <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                    profile
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                    应用
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                    登录人
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
                    token
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => {
                  const tone = tokenTone(profile)
                  const removing = confirmRemove === profile.name
                  const loggingIn = login?.profile === profile.name
                  return (
                    <Fragment key={profile.name}>
                      <tr className="border-t border-border">
                        <th scope="row" className="px-3 py-2 font-normal">
                          <span className="flex items-center gap-1.5">
                            <span
                              className="block max-w-40 truncate text-sm font-medium text-foreground"
                              title={profile.name}
                            >
                              {profile.name}
                            </span>
                            {profile.active && (
                              <span className="rounded-sm bg-accent px-1.5 py-0.5 text-xs whitespace-nowrap text-muted-foreground">
                                在用
                              </span>
                            )}
                          </span>
                        </th>
                        <td className="px-3 py-2">
                          <span
                            className="block max-w-32 truncate font-mono text-xs text-muted-foreground"
                            title={profile.appId}
                          >
                            {profile.appId === '' ? '—' : profile.appId}
                          </span>
                        </td>
                        <td className="max-w-32 truncate px-3 py-2 text-xs whitespace-nowrap text-muted-foreground">
                          {profile.user ?? '—'}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={cn('rounded-sm px-1.5 py-0.5 text-xs', tone.cls)}>
                            {tone.text}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="flex items-center justify-end gap-1.5">
                            <Button
                              type="button"
                              variant="quiet"
                              size="xs"
                              // 正在登录的那一行不给重复发起：设备码只有一份
                              disabled={busy !== null || loggingIn}
                              aria-label={`登录 profile ${profile.name}`}
                              onClick={() => startLogin(profile.name)}
                            >
                              {busy === 'login' && loginPending === profile.name
                                ? '发起中…'
                                : '登录'}
                            </Button>
                            {removing ? (
                              <>
                                <Button
                                  type="button"
                                  variant="quiet"
                                  size="icon-xs"
                                  aria-label="取消删除"
                                  title="取消删除"
                                  disabled={busy !== null}
                                  onClick={() => setConfirmRemove(null)}
                                >
                                  <XIcon />
                                </Button>
                                <Button
                                  type="button"
                                  variant="quiet-destructive"
                                  size="xs"
                                  disabled={busy !== null}
                                  onClick={() => removeProfile(profile.name)}
                                >
                                  {busy === 'remove' ? '删除中…' : '确认删除'}
                                </Button>
                              </>
                            ) : (
                              <Button
                                type="button"
                                variant="quiet-destructive"
                                size="xs"
                                disabled={busy !== null}
                                aria-label={`删除 profile ${profile.name}`}
                                onClick={() => setConfirmRemove(profile.name)}
                              >
                                删除
                              </Button>
                            )}
                          </span>
                        </td>
                      </tr>
                      {loggingIn && login?.verificationUrl !== undefined && (
                        <tr className="border-t border-border bg-muted">
                          <td colSpan={5} className="px-3 py-2">
                            {/* 授权链接只给短标签：设备码 URL 长且不可换行，直接铺开会把表格撑宽、
                                把右侧操作列挤出可视区（这也是一次真机缺陷）。完整地址放 title / href。 */}
                            <div className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                给「{profile.name}」授权：打开链接确认后回来点右侧按钮
                              </span>
                              <a
                                className="shrink-0 text-xs text-brand underline"
                                href={login.verificationUrl}
                                title={login.verificationUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                打开授权页
                              </a>
                              <Button
                                type="button"
                                variant="secondary"
                                size="xs"
                                className="shrink-0"
                                disabled={busy !== null}
                                onClick={finishLogin}
                              >
                                {busy === 'poll' ? '确认中…' : '我已完成授权'}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
