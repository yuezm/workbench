/**
 * 权限取交集（A2）：`run.access = min(智能体原意, 授权上限)`。
 *
 * 单独成一个无依赖的小模块，避免 `mandate ↔ task-effects` 互相 import 形成环：
 * `mandate` 需要 `runAccessOf`（阶段语义），`task-effects` 需要 `narrowAccess`。
 */
import type { Access } from '@workbench/protocol/entities'

/** 权限宽窄：只用于「取更窄的一个」。 */
const ACCESS_RANK: Record<Access, number> = { read: 1, edit: 2, full: 3 }

/** 取更窄的权限：授权只会收紧，不会放宽。 */
export function narrowAccess(intended: Access, cap: Access): Access {
  return ACCESS_RANK[intended] <= ACCESS_RANK[cap] ? intended : cap
}
