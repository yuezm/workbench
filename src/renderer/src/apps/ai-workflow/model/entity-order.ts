import { useSyncExternalStore } from 'react'

/**
 * 实体显示顺序（智能体 / 工作流）：渲染层偏好，存 localStorage。
 *
 * 为什么不是事实：顺序只决定「设置清单与侧栏里先看到谁、默认落到哪一个」，
 * 不参与派活、流转、校验里的任何判定；与主题偏好同口径留在渲染层
 * （`lib/theme.ts`），不进工作台事实日志，库里也不会多出一批只为显示服务的投影列。
 *
 * 读：登记过的按存的次序排在前面，没登记过的（新建的 / 别处导入的 / 顺序里残留的
 * 已删 id）按原始次序追加在后——所以新增实体永远出在末尾，不会凭空插到中间。
 */

export type EntityOrderKind = 'agent' | 'workflow'

/** 落盘的键（localStorage）：一个 kind 一个键 */
export const ENTITY_ORDER_STORAGE_KEYS: Record<EntityOrderKind, string> = {
  agent: 'workbench.agent-order',
  workflow: 'workbench.workflow-order',
}

/** 全部 kind（清理与初始读取都按它遍历） */
const KINDS: readonly EntityOrderKind[] = ['agent', 'workflow']

/**
 * 解析本地存下的顺序：坏 JSON / 不是数组 / 元素不是非空字符串 / 重复 id
 * 一律逐项丢弃（丢空即「没存过」），不让一份脏数据把清单排成随机形状。
 */
export function parseEntityOrder(raw: string | null): string[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const ids: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string' || item === '' || ids.includes(item)) continue
    ids.push(item)
  }
  return ids
}

/**
 * 按存的顺序排：命中顺序的按存的次序在前，其余保持传入次序追加在后
 * （空顺序 = 原样返回，与原视图的 `created_at` 次序一致）。
 */
export function sortByEntityOrder<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  if (order.length === 0) return [...items]
  const rank = new Map(order.map((id, index) => [id, index]))
  const fallback = order.length
  return [...items].sort(
    (left, right) => (rank.get(left.id) ?? fallback) - (rank.get(right.id) ?? fallback),
  )
}

/**
 * 拖动重排：把 `id` 挪到 `targetId` 当前所在的下标（等价于 arrayMove）。
 * 任一方不在清单里、或拖到自己身上时原样返回副本。
 * 返回整份 id 顺序，调用方直接落盘——顺手把已删实体的残留 id 冲掉。
 */
export function moveInEntityOrderTo(
  ids: readonly string[],
  id: string,
  targetId: string,
): string[] {
  const from = ids.indexOf(id)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/**
 * 键盘兜底：`delta` = -1 / 1 挪一格。拖动是主路径，键盘只在抓手聚焦时用（拖拽本身不可键盘操作）。
 * 越界或 id 不在清单里时原样返回副本——首尾再按同方向就是空操作。
 */
export function moveInEntityOrder(ids: readonly string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id)
  const to = from < 0 ? from : from + delta
  if (from < 0 || to < 0 || to >= ids.length) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/** 读本地顺序：读不到（隐私模式 / 脏值）按「没存过」 */
function readStoredOrder(kind: EntityOrderKind): string[] {
  try {
    return parseEntityOrder(window.localStorage.getItem(ENTITY_ORDER_STORAGE_KEYS[kind]))
  } catch {
    /* localStorage 不可用：顺序只在本次会话里生效 */
    return []
  }
}

let orders: Record<EntityOrderKind, string[]> = {
  agent: readStoredOrder('agent'),
  workflow: readStoredOrder('workflow'),
}

const listeners = new Set<() => void>()

/** 当前顺序（引用稳定，供 useSyncExternalStore 比较） */
export function getEntityOrder(kind: EntityOrderKind): string[] {
  return orders[kind]
}

/**
 * 全量顺序快照：返回同一个对象直到 `setEntityOrder` 换掉它。
 * `useSyncExternalStore` 的客户端快照与 SSR 快照共用它（引用稳定才不抖）。
 */
function getOrdersSnapshot(): Record<EntityOrderKind, string[]> {
  return orders
}

/** 订阅顺序变化（返回退订函数） */
export function subscribeEntityOrder(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 换一份顺序：先落盘再通知；存不下（配额 / 隐私模式）不报错，内存态仍然生效 */
export function setEntityOrder(kind: EntityOrderKind, ids: readonly string[]): void {
  orders = { ...orders, [kind]: [...ids] }
  try {
    window.localStorage.setItem(ENTITY_ORDER_STORAGE_KEYS[kind], JSON.stringify(orders[kind]))
  } catch {
    /* 存不下就在本次会话里生效 */
  }
  for (const listener of listeners) listener()
}

/**
 * 按存的顺序排好的清单 + 两档排序入口。
 *
 * `moveTo` 是拖动落点（把某一项挪到另一项的下标），`move` 是抓手上的键盘 ↑ / ↓。
 * 两者传入的都是「当前看到的顺序」——不含已删实体、含新建实体，
 * 因此一次拖动就把整份清单固化成新的顺序。
 */
export function useEntityOrder<T extends { id: string }>(
  kind: EntityOrderKind,
  items: readonly T[],
): {
  items: T[]
  move: (id: string, delta: number) => void
  moveTo: (id: string, targetId: string) => void
} {
  const order = useSyncExternalStore(subscribeEntityOrder, getOrdersSnapshot, getOrdersSnapshot)[
    kind
  ]
  const ordered = sortByEntityOrder(items, order)
  const ids = ordered.map((item) => item.id)
  const move = (id: string, delta: number): void => {
    setEntityOrder(kind, moveInEntityOrder(ids, id, delta))
  }
  const moveTo = (id: string, targetId: string): void => {
    setEntityOrder(kind, moveInEntityOrderTo(ids, id, targetId))
  }
  return { items: ordered, move, moveTo }
}

/**
 * 测试用：清掉内存顺序与本地存储（生产代码不会调用）。
 */
export function resetEntityOrderForTest(): void {
  for (const kind of KINDS) {
    orders = { ...orders, [kind]: [] }
    try {
      window.localStorage.removeItem(ENTITY_ORDER_STORAGE_KEYS[kind])
    } catch {
      /* 清不掉就留着，不影响断言 */
    }
  }
  listeners.clear()
}
