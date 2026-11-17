import { useState, type ReactElement } from 'react'
import type { LarkProfileView } from '@workbench/protocol/ipc'
import { Button } from '@workbench/client-ui-primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workbench/client-ui-primitives/dialog'
import { Field } from '@workbench/client-ui-kit/field'
import { Input } from '@workbench/client-ui-primitives/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workbench/client-ui-primitives/select'
import { Segmented } from '@workbench/client-ui-kit/segmented'
import {
  connectionOfForm,
  targetKindOf,
  type ConnectionDraft,
  type ConnectionTargetKind,
} from '../model/feishu-connections'

export interface FeishuConnectionDialogProps {
  /** 编辑态传入现有连接；新建时省略 */
  connection?: ConnectionDraft
  profiles: readonly LarkProfileView[]
  onSubmit: (connection: ConnectionDraft) => void
  onCancel: () => void
}

const TARGET_OPTIONS: { value: ConnectionTargetKind; label: string }[] = [
  { value: 'current', label: '跟随登录人' },
  { value: 'user', label: '私聊某人' },
  { value: 'chat', label: '发到群' },
]

/**
 * 一条飞书连接的编辑弹窗。
 *
 * 为什么从「面板里一排输入框」改成弹窗：连接是**一条独立配置**（一个 profile + 一个落点 +
 * 一份拍板人名单），在面板里和状态、profile 管理挤在同一屏时，用户分不清哪些格子属于
 * 已有连接、哪些属于新连接。弹窗把「一条连接」收成一个对象，编辑与新增共用同一张表单。
 *
 * 「消息落在哪」用分段控件而不是两个并排输入框：配置里 `chat` 优先于 `user`，
 * 两个都能填时用户无法预判消息会落到群还是私聊。
 *
 * 没有「派给哪个智能体」这一项：飞书只承载需要人拍板的卡（点按钮就是答复），
 * 不在飞书里聊天，因此没有可以派活的对象。
 */
export function FeishuConnectionDialog({
  connection,
  profiles,
  onSubmit,
  onCancel,
}: FeishuConnectionDialogProps): ReactElement {
  const editing = connection !== undefined
  const [label, setLabel] = useState(connection?.label ?? '')
  const [profile, setProfile] = useState(connection?.profile ?? '')
  const [target, setTarget] = useState<ConnectionTargetKind>(targetKindOf(connection ?? {}))
  const [user, setUser] = useState(connection?.user ?? '')
  const [chat, setChat] = useState(connection?.chat ?? '')
  const [answerers, setAnswerers] = useState(
    Array.isArray(connection?.answerers)
      ? connection.answerers.join(', ')
      : (connection?.answerers ?? ''),
  )
  const [errors, setErrors] = useState<{ label?: string; user?: string; chat?: string }>({})

  const clearError = (key: 'label' | 'user' | 'chat'): void => {
    setErrors((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const submit = (ev: React.FormEvent<HTMLFormElement>): void => {
    ev.preventDefault()
    // 连接名与 profile 都空 = 这条连接没有任何可辨识信息，落库后也分不清是谁
    if (label.trim() === '' && profile.trim() === '') {
      setErrors({
        label: '至少填连接名或选一个 profile（profile 留空 = 用 lark-cli 当前 profile）',
      })
      return
    }
    // 选了落点却没填地址时不静默退化成「跟随登录人」：那会把消息发给用户自己
    if (target === 'user' && user.trim() === '') {
      setErrors({ user: '填接收人的 open_id，或把落点改成「跟随登录人」' })
      return
    }
    if (target === 'chat' && chat.trim() === '') {
      setErrors({ chat: '填群 chat_id（oc_ 开头），或把落点改成「跟随登录人」' })
      return
    }
    setErrors({})
    onSubmit(
      connectionOfForm({
        label,
        profile,
        user: target === 'user' ? user : '',
        chat: target === 'chat' ? chat : '',
        answerers,
      }),
    )
  }

  return (
    <Dialog
      open
      onOpenChange={() => {
        // 受控弹窗无 Trigger：dismiss 只会发 false，直接收口
        onCancel()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑飞书连接' : '添加飞书连接'}</DialogTitle>
          <DialogDescription>
            一条连接 = 一个飞书应用；拍板卡发到这里，点按钮就是答复。
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="连接名" error={errors.label ?? null}>
              <Input
                aria-label="飞书连接名"
                placeholder="如：工作台助手"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value)
                  clearError('label')
                }}
              />
            </Field>
            <Field label="profile" hint="留空 = lark-cli 当前 profile">
              <Select
                value={profile}
                onValueChange={(next) => {
                  setProfile(next)
                  clearError('label')
                }}
              >
                <SelectTrigger aria-label="飞书 profile" className="w-full">
                  <SelectValue placeholder={profiles.length === 0 ? '没有 profile' : '选一个'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">当前 profile</SelectItem>
                  {profiles.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {item.name}
                      {item.active ? '（在用）' : ''}
                    </SelectItem>
                  ))}
                  {/* 编一条绑了已删除 profile 的旧连接：补一条兜底项，别让下拉显示成「没选」 */}
                  {profile !== '' && !profiles.some((item) => item.name === profile) && (
                    <SelectItem value={profile}>{profile}（本机没有）</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">消息落在哪</span>
            <div className="self-start">
              <Segmented
                value={target}
                onChange={(next) => {
                  setTarget(next)
                  setErrors({})
                }}
                options={TARGET_OPTIONS}
                ariaLabel="飞书连接消息落点"
              />
            </div>
            {target === 'user' && (
              <Field label="接收人 open_id" error={errors.user ?? null}>
                <Input
                  aria-label="飞书连接接收人"
                  placeholder="ou_ 开头；留空等于发给自己"
                  value={user}
                  onChange={(e) => {
                    setUser(e.target.value)
                    clearError('user')
                  }}
                />
              </Field>
            )}
            {target === 'chat' && (
              <Field label="群 chat_id" error={errors.chat ?? null}>
                <Input
                  aria-label="飞书连接群"
                  placeholder="oc_ 开头"
                  value={chat}
                  onChange={(e) => {
                    setChat(e.target.value)
                    clearError('chat')
                  }}
                />
              </Field>
            )}
            {target === 'current' && (
              <p className="text-xs text-faint-foreground">发到 profile 登录人的私聊。</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="谁能拍板" hint="逗号分隔的 open_id；留空只认接收人">
              <Input
                aria-label="飞书连接拍板人"
                placeholder="ou_1, ou_2"
                value={answerers}
                onChange={(e) => setAnswerers(e.target.value)}
              />
            </Field>
          </div>

          <DialogFooter>
            <Button type="button" variant="quiet" size="sm" onClick={onCancel}>
              取消
            </Button>
            <Button type="submit" variant="default" size="sm">
              保存连接
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
