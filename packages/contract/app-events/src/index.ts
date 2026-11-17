/**
 * app 插件的事件声明（M5）：renderer 的 app 注册表与宿主的事件白名单共用这一份。
 *
 * app 插件只声明自己能发的事件前缀（`AppPlugin.events`）；宿主在 `app.event`
 * 命令入口按本清单校验 `appId` 与 `eventType`，不在清单里的一律拒绝——renderer
 * 传的是不可信数据，事件类型不能由它自定。
 */
export interface AppEventDeclaration {
  /** app 插件 id（与 `AppPlugin.id` 一致，kebab-case） */
  id: string
  /** 该 app 可发的事件类型全集（小写点分，如 pomodoro.completed） */
  events: readonly string[]
}

/** 内置 app 的事件白名单；新增 app 时在这里加一行（与 renderer 注册表同批）。 */
export const APP_EVENTS: readonly AppEventDeclaration[] = [
  { id: 'pomodoro', events: ['pomodoro.completed'] },
  { id: 'ai-workflow', events: [] },
]

/** 某 app 是否可发某事件（宿主入口用；O(app 数 × 事件数)，量级可忽略）。 */
export function isDeclaredAppEvent(appId: string, eventType: string): boolean {
  return APP_EVENTS.some((entry) => entry.id === appId && entry.events.includes(eventType))
}
