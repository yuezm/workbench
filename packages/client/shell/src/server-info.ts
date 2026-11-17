import { useSyncExternalStore } from 'react'
import type { ServerInfo } from '@workbench/protocol/http'

/**
 * 服务信息（`/api/info` 的一次快照）：顶部栏显示版本，设置页显示数据目录与在线页面数。
 *
 * 为什么做成模块级 store 而不是每个组件各取一次：`/api/info` 在页面启动时只该请求一次
 * （`main.tsx` 已经为了「服务连不上」先探过一次），把它存起来让所有组件读同一份，
 * 避免顶部栏和设置页打出两个请求、两处显示不同版本。
 */
let current: ServerInfo | null = null
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const listener of listeners) listener()
}

/** 写入启动时取到的服务信息（`main.tsx` 调用一次）。 */
export function setServerInfo(info: ServerInfo): void {
  current = info
  emit()
}

export function getServerInfo(): ServerInfo | null {
  return current
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const snapshot = (): ServerInfo | null => current

/** 订阅服务信息；未取到之前返回 null（顶部栏据此不显示版本，而不是显示一个假版本） */
export function useServerInfo(): ServerInfo | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** 仅在测试里重置（避免用例之间互相污染）。 */
export function resetServerInfoForTest(): void {
  current = null
  listeners.clear()
}
