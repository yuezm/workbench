/**
 * Web 装配层：在 `@workbench/bundle-base` 之上决定「这次启动挂不挂界面」。
 *
 * 这里刻意只做决策与文案，不做 IO：产物探测在 `@workbench/host-frontend-static`，
 * 路由与静态响应在 `@workbench/api-http`。服务端装配不需要它也能跑起来。
 */
import type { WebUiMode, WebUiResolution } from '@workbench/host-frontend-static'
import { resolveWebUi } from '@workbench/host-frontend-static'

export { resolveWebUi }
export type { WebUiMode, WebUiResolution }

/**
 * 启动行后缀：把「这次有没有界面」写清楚。
 *
 * 用 `/` 前缀分隔，e2e 与运维脚本按 `workbench listening on <url>` 取地址时不受影响。
 */
export function uiStartupSuffix(resolution: WebUiResolution): string {
  return resolution.dir === null ? ` (api only; ${resolution.reason})` : ` (ui: ${resolution.dir})`
}
