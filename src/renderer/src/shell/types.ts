import type { ComponentType } from 'react'

/** 图标组件入参 */
export interface AppIconProps {
  /** 尺寸（像素），默认由图标组件决定 */
  size?: number
}

/**
 * 工作台 app 契约：每个 app 以此注册进外壳。
 * 新增 app 三步走：新建 src/renderer/src/apps/<id>/、实现 AppDefinition、在 registry.ts 加一行。
 */
export interface AppDefinition {
  /** 唯一 id，kebab-case */
  id: string
  /** 侧边栏显示名 */
  name: string
  /** 侧边栏图标 */
  icon: ComponentType<AppIconProps>
  /** 内容区挂载的入口组件 */
  component: ComponentType
}
