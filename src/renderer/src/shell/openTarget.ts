import { useSyncExternalStore } from 'react'
import type { OpenTarget } from '../../../protocol/ipc'

/**
 * shell 级的导航 store（同步内存）：**当前 app** + **待打开落点**。
 *
 * **为什么放在 shell，而不是某个 app 里**：落点由系统通知（main 进程点击）产生，它描述的
 * 第一件事是「切到哪个 app」（`appId`），然后才是 app 内部的「哪个任务 / 会话 / 卡片」。
 * 切 app 是 shell 的职责，而 shell 不能反向依赖任何 app；所以落点必须停在两者之间：
 * shell 读到 `appId` 切 app，目标 app 挂载后自己继续消费同一份落点。放进某个 app 的 state
 * 会有两个后果——app 还没挂载时落点无处可存（点击就丢了），以及 shell 为了切 app 得依赖
 * 那个 app 的内部实现。
 *
 * **为什么当前 app 也在这里**：「切 app」是落点的第一跳。如果它留在组件 state 里，就得在
 * effect 里校正 state 或渲染期改 state，两者都会引发级联渲染（`react-hooks` v7 直接判 error），
 * 而且两个真相源会互相覆盖（先切过去、落点清空后又弹回原 app）。和落点写在同一笔里，
 * 天然是「切过去就停在那儿」：清空落点只清落点，不动当前 app。
 *
 * **为什么需要 `seq`**：只按内容判断「落点变了没有」会漏掉「连点两条同内容通知」——
 * 对象字段全等，订阅者看不出这是新的一次点击，界面就不会重新定位（卡已经滚走了、或者
 * 用户手动滚开后又点了一次）。`seq` 单调递增，一次点击一个序号，消费方以它为判据就必然
 * 重新处理一次；同时它也是异步续作的安全阀：查询回来时序号已经变了，说明有更新的落点
 * 在路上，旧的那次结果应当丢弃。
 *
 * 生命周期：`main.tsx` 在渲染前把 `bridge.onOpenTarget` 接到 `pushOpenTarget` 上（先订阅后渲染，
 * 窗口加载期间的那一次点击也进得来）；`Workbench` 读 `useActiveAppId` 切 app、**不清空**落点；
 * 清空由消费方（目标 app 处理完）调用 `clearOpenTarget`，否则 app 还没来得及读就被 shell 清掉了。
 */
export interface PendingOpenTarget extends OpenTarget {
  /** 单调递增序号：每次 push +1，消费方据此区分「同内容的新一次点击」 */
  seq: number
}

/** 落点订阅者：收到新的待打开落点，或 `null`（已被消费 / 已清空） */
export type OpenTargetListener = (target: PendingOpenTarget | null) => void

/** 当前待打开的落点：`null` = 没有 */
let current: PendingOpenTarget | null = null
/** 当前 app（顶部栏选中项）：`null` = 还没选过，由外壳回落到第一个 app */
let activeAppId: string | null = null
/** 最近一次分配的序号；只在 push 时递增，`clear` 不回收（回收会让新落点与旧序号撞车） */
let seq = 0
/** 订阅者（`useSyncExternalStore` 的 onChange 与 app 侧的落点消费方） */
const listeners = new Set<() => void>()
/** 落点订阅方（与 `listeners` 分开：读快照的一侧不需要知道「落点长什么样」） */
const targetListeners = new Set<OpenTargetListener>()

function publish(): void {
  for (const listener of listeners) listener()
  for (const listener of targetListeners) listener(current)
}

/** 记下一个待打开的落点（系统通知点击进来；同内容连点两次也会各占一个 seq）。 */
export function pushOpenTarget(target: OpenTarget): void {
  seq += 1
  current = { ...target, seq }
  // 第一跳与落点同一笔写入：切 app 不会与「落点被消费」打架
  activeAppId = target.appId
  publish()
}

/** 消费完就清空：落点是一次性的，留着会在下次挂载 / 重连时被重放一遍。 */
export function clearOpenTarget(): void {
  if (current === null) return
  current = null
  publish()
}

/** 顶部栏点选 app（用户主动切换，与落点无关）。 */
export function selectApp(id: string): void {
  if (activeAppId === id) return
  activeAppId = id
  publish()
}

/**
 * 订阅落点：订阅时**先把当前还没被消费的落点重放一次**，之后再收每次变化。
 *
 * 重放是必须的——系统通知可能先于 app 挂载到达（点击发生在窗口加载期间），订阅晚一步
 * 就再也收不到那一次推送；而落点在 `clearOpenTarget` 之前一直留在 store 里，正好能补上。
 */
export function subscribeOpenTarget(listener: OpenTargetListener): () => void {
  targetListeners.add(listener)
  listener(current)
  return () => {
    targetListeners.delete(listener)
  }
}

/**
 * 订阅当前待打开落点（同步内存读取，不需要 Promise / 加载态）。
 *
 * 函数引用在模块级固定（`subscribe` / `getSnapshot` 是模块常量），组件重渲染不会反复订阅。
 */
export function useOpenTarget(): PendingOpenTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 订阅当前 app id（`null` = 还没选过，外壳回落到第一个 app）。 */
export function useActiveAppId(): string | null {
  return useSyncExternalStore(subscribe, getActiveAppId, getActiveAppId)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): PendingOpenTarget | null {
  return current
}

function getActiveAppId(): string | null {
  return activeAppId
}

/**
 * 仅在测试里重置，避免用例之间互相污染（风格同 `kernelStore.resetKernelForTest`）。
 *
 * 连 `seq` 一起归零：下个用例从头开始数，断言「第一条就是 1」才有意义；
 * 订阅者一并清掉——上一个用例的组件即使漏了退订，也不会被新用例的落点唤醒。
 */
export function resetOpenTargetForTest(): void {
  current = null
  activeAppId = null
  seq = 0
  listeners.clear()
  targetListeners.clear()
}
