/**
 * 系统通知原件（M4 D11；点击落点后续迭代）：`sdk.notify` 的宿主实现，唯一 import Electron
 * `Notification` 的地方之一。
 *
 * 为什么在 `src/main` 而不是 `src/host`：`host` 不依赖 Electron（窗口/托盘/通知由装配根注入），
 * 因此 refactor-plan 里的 `host/notify.ts` 在 M4 更正为 `src/main/notify.ts`（见 m4-plan D11）。
 *
 * 边界：title/body 只作 `Notification` 的参数——不拼 shell 命令、不拼 HTML/模板字符串，
 * 也不写日志（通知文案与卡片正文不落日志）。平台不支持或构造失败时返回 `false` 而不抛，
 * 由调用方决定是否落 `card.delivery_failed`；通知失败不影响卡片状态与内核。
 *
 * 点击：带落点时挂 `click`，把窗口唤到前台再把 `OpenTarget` 推给渲染层。`appId` 不由这里补
 * ——本文件不认识 app（`OpenTarget` 的 app 身份由装配根统一填），它只负责把落点原样送达。
 */
import { BrowserWindow, Notification } from 'electron'
import { WORKBENCH_OPEN_TARGET_CHANNEL, type OpenTarget } from '../protocol/ipc'

/**
 * 还活着（未被系统丢弃、还可能被点）的通知。
 *
 * 必须留 module 级活引用：Electron 的通知对象一旦被 GC，Windows 通知中心里的那条就成了
 * 沉默的贴纸——点了没有回调，因为已经没有 JS 对象接着。`click` / `close` / 展示失败时
 * 删掉自己，长跑进程里才只增到「屏幕上还挂着的条数」为止。
 */
const alive = new Set<Notification>()

/** 把窗口唤到前台并把落点推给渲染层；窗口没了或渲染进程已退出就什么都不做。 */
function focusAndSend(target: OpenTarget): void {
  const window = BrowserWindow.getAllWindows()[0]
  if (window === undefined) return
  // 最小化的窗口只 `show()` 不会弹回来，必须先 restore
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  try {
    window.webContents.send(WORKBENCH_OPEN_TARGET_CHANNEL, target)
  } catch {
    // 窗口正在销毁 / 渲染进程已崩：跳转失败只影响这一次点击，不该把通知打崩
  }
}

/**
 * 构造好通知并（有落点时）挂上点击 / 关闭监听；平台不支持或构造抛错返回 null。
 *
 * 监听必须在 `show()` 之前挂：通知中心里第一条通知可能很快就被人点，
 * 事件挂晚了这一下点击就丢了。
 */
function createNotification(
  title: string,
  body: string,
  target: OpenTarget | undefined,
): Notification | null {
  try {
    if (!Notification.isSupported()) return null
    const notification = new Notification({ title, body })
    if (target !== undefined) {
      alive.add(notification)
      notification.on('click', () => {
        alive.delete(notification)
        focusAndSend(target)
      })
      notification.on('close', () => {
        alive.delete(notification)
      })
    }
    return notification
  } catch {
    return null
  }
}

/**
 * 展示一条系统通知；成功返回 true，平台不支持/构造失败返回 false（不抛、不记文案）。
 *
 * `target` 缺省时行为与 M4 完全一致（不挂监听、返回值只看构造与 show）；
 * 有落点才接住点击——点通知 → 窗口到前台 → 渲染层收到落点（切 app / 进详情 / 高亮那张卡）。
 */
export function notify(title: string, body: string, target?: OpenTarget): boolean {
  const notification = createNotification(title, body, target)
  if (notification === null) return false
  try {
    notification.show()
    return true
  } catch {
    // 展示失败的通知不会出现在通知中心，也就不会有 click / close：引用当下就收回
    alive.delete(notification)
    return false
  }
}
