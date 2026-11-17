import type { LarkProfileView, LarkStatusView } from '@workbench/protocol/ipc'

/** 连接配置形状（与通道插件读的 JSON 同形；不认识的字段原样保留，避免吃掉手写内容） */
export interface ConnectionDraft {
  label?: string
  profile?: string
  user?: string
  chat?: string
  answerers?: string | string[]
}

/** 从插件配置里的 `connections` 字段解析连接列表（坏 JSON = 空列表，不让面板炸掉）。 */
export function connectionsOf(raw: unknown): ConnectionDraft[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(
    (item): item is ConnectionDraft =>
      item !== null && typeof item === 'object' && !Array.isArray(item),
  )
}

/** 连接的展示名：label → profile → 「未命名连接」 */
export function connectionLabel(connection: ConnectionDraft, index: number): string {
  const label = connection.label ?? connection.profile
  return label === undefined || label.trim() === '' ? `连接 ${index + 1}` : label.trim()
}

/** 连接的接收目标摘要（群 / 私聊 / 跟随登录人）。 */
export function connectionTarget(connection: ConnectionDraft): string {
  if (typeof connection.chat === 'string' && connection.chat.trim() !== '') {
    return `群 ${connection.chat.trim()}`
  }
  if (typeof connection.user === 'string' && connection.user.trim() !== '') {
    return `私聊 ${connection.user.trim()}`
  }
  return '登录人（默认）'
}

/** 答案人列表：数组或逗号串都认。 */
export function answerersTextOf(connection: ConnectionDraft): string {
  if (Array.isArray(connection.answerers)) return connection.answerers.join(', ')
  return connection.answerers ?? ''
}

/**
 * 把表单里的一行转回配置对象（空字段不写，避免占位空串）。
 *
 * 没有「派给哪个智能体」：飞书只承载需要人拍板的卡，点按钮即答复，不在飞书里聊天。
 */
export function connectionOfForm(form: {
  label: string
  profile: string
  user: string
  chat: string
  answerers: string
}): ConnectionDraft {
  const connection: ConnectionDraft = {}
  if (form.label.trim() !== '') connection.label = form.label.trim()
  if (form.profile.trim() !== '') connection.profile = form.profile.trim()
  if (form.user.trim() !== '') connection.user = form.user.trim()
  if (form.chat.trim() !== '') connection.chat = form.chat.trim()
  const answerers = [
    ...new Set(
      form.answerers
        .split(/[,，;；\s]+/u)
        .map((item) => item.trim())
        .filter((item) => item !== ''),
    ),
  ]
  if (answerers.length > 0) connection.answerers = answerers
  return connection
}

/** 一条连接的消息落点：群 / 私聊某人 / 跟随登录人（配置里 chat 优先于 user）。 */
export type ConnectionTargetKind = 'current' | 'user' | 'chat'

export function targetKindOf(connection: ConnectionDraft): ConnectionTargetKind {
  if (typeof connection.chat === 'string' && connection.chat.trim() !== '') return 'chat'
  if (typeof connection.user === 'string' && connection.user.trim() !== '') return 'user'
  return 'current'
}

/** 行内健康度：这条连接的 profile 在本机拿不拿得到 token（只读探测结果，不推导装载规则）。 */
export interface ConnectionHealth {
  text: string
  cls: string
}

const HEALTH_TONES = {
  ready: 'bg-success/15 text-success',
  unlogged: 'bg-warning/15 text-warning',
  missing: 'bg-destructive/15 text-destructive',
  probing: 'bg-accent text-muted-foreground',
} as const

/**
 * 连接状态：profile 留空 = 跟随 lark-cli 当前登录（用整体可用性），
 * 指定了 profile 就看本机探测结果里那个 profile 的 token。
 */
export function connectionHealthOf(
  connection: ConnectionDraft,
  status: LarkStatusView | null,
): ConnectionHealth {
  if (status === null) return { text: '探测中', cls: HEALTH_TONES.probing }
  const wanted = connection.profile?.trim() ?? ''
  if (wanted === '') {
    return status.available && status.ok
      ? { text: '跟随当前登录', cls: HEALTH_TONES.ready }
      : { text: '未登录', cls: HEALTH_TONES.unlogged }
  }
  const profile: LarkProfileView | undefined = status.profiles.find((item) => item.name === wanted)
  if (profile === undefined) return { text: '本机没有这个 profile', cls: HEALTH_TONES.missing }
  if (profile.tokenStatus === null || profile.tokenStatus === '') {
    return { text: '未登录', cls: HEALTH_TONES.unlogged }
  }
  return { text: '就绪', cls: HEALTH_TONES.ready }
}

/** 面板顶部整体状态：可用 / 待登录 / 未就绪 / 与别的 agent 撞车 */
export interface StatusTone {
  text: string
  /** 文字色 class（用于状态点与文案） */
  textCls: string
  /** 圆点 class */
  dotCls: string
}

export function statusToneOf(
  status: LarkStatusView | null,
  error: string | null,
): StatusTone | null {
  if (status === null) {
    return error === null ? null : { text: '未就绪', textCls: 'text-warning', dotCls: 'bg-warning' }
  }
  if (!status.ok) return { text: '未就绪', textCls: 'text-warning', dotCls: 'bg-warning' }
  if (status.conflict)
    return { text: '与别的 agent 撞车', textCls: 'text-destructive', dotCls: 'bg-destructive' }
  if (!status.available) return { text: '待登录', textCls: 'text-warning', dotCls: 'bg-warning' }
  return { text: '可用', textCls: 'text-success', dotCls: 'bg-success' }
}
