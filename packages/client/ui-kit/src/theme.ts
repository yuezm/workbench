import { useSyncExternalStore } from 'react'

/**
 * 主题偏好：亮色 / 暗色 / 跟随系统。
 *
 * - 偏好（preference）是用户选的：存 localStorage（渲染层自己的偏好，不进工作台事实日志）。
 * - 生效主题（resolved）是实际渲染的：偏好是「跟随系统」时由系统色决定。
 *
 * 渲染方式：`<html>` 上挂 `light` / `dark` 类，主题变量写在 global.css 的
 * `:root`（亮）与 `.dark`（暗）两套里，Tailwind 的 `dark:` 变体随之生效。
 */

/** 用户可选的三种偏好 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 实际生效的主题（`system` 解析后的结果） */
export type ResolvedTheme = 'light' | 'dark'

/** 偏好落盘的键（localStorage） */
export const THEME_STORAGE_KEY = 'workbench.theme'

/** 跟随系统时监听的媒体查询 */
const DARK_QUERY = '(prefers-color-scheme: dark)'

const PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system']

/** 是不是受支持的偏好值（读本地存储时用来挡脏数据） */
export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && PREFERENCES.includes(value as ThemePreference)
}

/** 系统是否偏好暗色（没有 matchMedia 时按亮色处理） */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(DARK_QUERY).matches
}

/** 偏好 + 系统色 → 实际生效的主题 */
export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

/** 读本地偏好：读不到（隐私模式 / 脏值）时按「跟随系统」 */
function readStoredPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(raw) ? raw : 'system'
  } catch {
    /* localStorage 不可用：偏好只在内存里生效 */
    return 'system'
  }
}

/** 写本地偏好：写失败（配额 / 隐私模式）不报错，内存态仍然生效 */
function writeStoredPreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    /* 存不下就在本次会话里生效 */
  }
}

/** 当前状态快照（对象整体替换，供 useSyncExternalStore 比较引用） */
export interface ThemeState {
  /** 用户选的偏好 */
  preference: ThemePreference
  /** 实际生效的主题 */
  resolved: ResolvedTheme
}

let preference: ThemePreference = readStoredPreference()
let resolved: ResolvedTheme = resolveTheme(preference, systemPrefersDark())
let snapshot: ThemeState = { preference, resolved }

const listeners = new Set<() => void>()

/** 把生效主题写进 `<html>` 的类名（CSS 变量与 `dark:` 变体都靠它） */
function applyThemeClass(next: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.classList.toggle('dark', next === 'dark')
  root.classList.toggle('light', next === 'light')
}

/** 重新算生效主题并通知订阅者 */
function refresh(): void {
  resolved = resolveTheme(preference, systemPrefersDark())
  applyThemeClass(resolved)
  snapshot = { preference, resolved }
  for (const listener of listeners) listener()
}

/**
 * 跟随系统时监听系统色变化：用户在系统里改了深浅色，窗口开着也要跟着变。
 * 只装一次监听（媒体查询对象按 DARK_QUERY 复用）。
 */
let media: MediaQueryList | null = null
function ensureMediaListener(): void {
  if (media !== null) return
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  media = window.matchMedia(DARK_QUERY)
  const onChange = (): void => {
    if (preference !== 'system') return
    refresh()
  }
  media.addEventListener('change', onChange)
}

/**
 * 初始化主题：读偏好 → 算生效主题 → 挂类名 → 订阅系统色变化。
 * 在渲染前调用一次（main.tsx），避免首帧用错主题。
 */
export function initTheme(): void {
  ensureMediaListener()
  applyThemeClass(resolved)
}

/** 当前偏好 */
export function getThemePreference(): ThemePreference {
  return preference
}

/** 当前生效主题 */
export function getResolvedTheme(): ResolvedTheme {
  return resolved
}

/** 订阅主题变化（返回退订函数） */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  ensureMediaListener()
  return () => {
    listeners.delete(listener)
  }
}

/** 快照读取（useSyncExternalStore 要求引用稳定，故用模块级对象） */
function getSnapshot(): ThemeState {
  return snapshot
}

/** 切换偏好：落盘 → 重算 → 通知 */
export function setThemePreference(next: ThemePreference): void {
  preference = next
  writeStoredPreference(next)
  refresh()
}

/**
 * 主题 Hook：读当前偏好与生效主题，并给出切换入口。
 *
 * @example
 * const { preference, resolved, setPreference } = useTheme()
 */
export function useTheme(): ThemeState & { setPreference: (next: ThemePreference) => void } {
  const state = useSyncExternalStore(subscribeTheme, getSnapshot, getSnapshot)
  return { ...state, setPreference: setThemePreference }
}

/**
 * 测试用：恢复默认（跟随系统 + 亮色生效），清掉本地存储与订阅者。
 * 生产代码不会调用。
 */
export function resetThemeForTest(): void {
  preference = 'system'
  resolved = 'light'
  snapshot = { preference, resolved }
  listeners.clear()
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY)
  } catch {
    /* 清不掉就留着，不影响断言 */
  }
  applyThemeClass('light')
}
