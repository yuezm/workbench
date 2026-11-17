/**
 * 知会（服务端）：取代桌面系统通知，走同一条 SSE 推给所有在线页面。
 *
 * 为什么这样换：系统通知的价值是「人不在这个窗口时也能被打断」。服务器形态下这件事交给
 * 浏览器通知/手机投屏都不如一句实话——页面开着就能看到轻提示，页面关着就由飞书通道去喊人
 * （`host/channels.ts` 的卡片投递本来就是这个职责）。服务端只负责把「该知会一声」记下来，
 * 谁来呈现由客户端决定。
 *
 * 边界：不写事实日志（知会不是业务真相）；标题/正文都截断，防止模型自由文本把推送撑爆。
 */
import type { NoticeEvent, ServerEvent } from '@workbench/protocol/http'
import type { NotifyTarget } from '@workbench/protocol/ipc'

/** 与渲染层 `AppPlugin.id` 同名：知会只落到发通知的那个 app */
export const NOTIFY_APP_ID = 'ai-workflow'
/** 正文上限：一条轻提示读不完更多 */
export const MAX_NOTICE_CHARS = 400

export interface NotifierDeps {
  /** 广播出口（SSE） */
  publish(event: ServerEvent): void
  /** 诊断日志：只记「推了一条知会」，不记正文 */
  log?(line: string): void
}

/** 截断到上限，超出补省略号（避免半句话被当成完整句子）。 */
const clamp = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

/** 与 sdk 的 `NotifyFn` 同形，但正文可省（`/api/notify` 常常只给标题） */
export interface NotifierFn {
  (title: string, body?: string, target?: NotifyTarget): void
}

export function createNotifier(deps: NotifierDeps): NotifierFn {
  return (title, body, target?: NotifyTarget) => {
    const cleanTitle = clamp(title.trim(), MAX_NOTICE_CHARS)
    if (cleanTitle === '') return
    const event: NoticeEvent = {
      kind: 'notice',
      title: cleanTitle,
      body: clamp((body ?? '').trim(), MAX_NOTICE_CHARS),
      ...(target === undefined ? {} : { target: { appId: NOTIFY_APP_ID, ...target } }),
    }
    deps.publish(event)
    deps.log?.(`[notify] ${cleanTitle}`)
  }
}
