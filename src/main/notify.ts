/**
 * 系统通知原件（M4 D11）：`sdk.notify` 的宿主实现，唯一 import Electron `Notification` 的地方之一。
 *
 * 为什么在 `src/main` 而不是 `src/host`：`host` 不依赖 Electron（窗口/托盘/通知由装配根注入），
 * 因此 refactor-plan 里的 `host/notify.ts` 在 M4 更正为 `src/main/notify.ts`（见 m4-plan D11）。
 *
 * 边界：title/body 只作 `Notification` 的参数——不拼 shell 命令、不拼 HTML/模板字符串，
 * 也不写日志（通知文案与卡片正文不落日志）。平台不支持或构造失败时返回 `false` 而不抛，
 * 由调用方决定是否落 `card.delivery_failed`；通知失败不影响卡片状态与内核。
 */
import { Notification } from 'electron'

/**
 * 展示一条系统通知；成功返回 true，平台不支持/构造失败返回 false（不抛、不记文案）。
 */
export function notify(title: string, body: string): boolean {
  try {
    if (!Notification.isSupported()) return false
    new Notification({ title, body }).show()
    return true
  } catch {
    return false
  }
}
