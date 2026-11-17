import type { ComponentType } from 'react'

/** 图标组件入参 */
export interface AppIconProps {
  /** 尺寸（像素），默认由图标组件决定 */
  size?: number
}

/**
 * 工作台 app 插件契约（M5）：每个 app 以此注册进外壳。
 * 新增 app 三步走：新建 src/renderer/src/apps/<id>/、实现 AppPlugin、在 registry.ts 加一行；
 * 可发事件的 app 在 `events` 声明前缀，并同步 `src/shared/apps.ts` 的白名单。
 */
export interface AppPlugin {
  /** 唯一 id，kebab-case */
  id: string
  /** 顶部导航显示名 */
  name: string
  /** 顶部导航图标 */
  icon: ComponentType<AppIconProps>
  /** 内容区挂载的入口组件 */
  component: ComponentType
  /** 可发事件类型（如 pomodoro.completed）；未声明则不能发 `app.event` */
  events?: readonly string[]
}
