/**
 * 阶段类别的视觉映射（M18）：四个类别各有自己的颜色，编辑器与看板共用这一份。
 *
 * 类别本身由协议算（`stageKindOf`：内置阶段按键取，自己添加的阶段一律「进行中」），
 * 这里只回答「长什么样」——纯常量，不依赖 React、不做 IO，单测直接比对类名即可。
 *
 * 颜色一律走语义 token（`check:ui` 会拦调色板外色值与孤儿 token 类名）：
 * - 未开始：最弱的前景（还没动）；
 * - 进行中：`brand`（唯一强调色，任务正在跑）；
 * - 已完成：`success`；
 * - 已关闭：文字退到最弱一级，圆点用 `destructive`（取消是「不做了」，不是「做完了」）。
 *
 * `chip` 是同色的低透明度底：徽标要能读到字，又不能抢过标题。
 */
import type { StageKind } from '../../../../../protocol/entities'

export interface StageKindMeta {
  /**
   * 类别文案（编辑器阶段详情里的徽标）。
   * 看板列头不显示它：列头只留阶段名 + 类别圆点，「待办」旁边不再写「未开始」。
   */
  label: string
  /** 圆点底色（`bg-` 前缀的类名）：看板列头、阶段列表 */
  dot: string
  /** 文字色（`text-` 前缀）：编辑器徽标文字 */
  text: string
  /** 徽标底色（同色低透明度 15% 或 10%）：与 `text` 搭配 */
  chip: string
}

export const STAGE_KIND_META: Record<StageKind, StageKindMeta> = {
  pending: {
    label: '未开始',
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    chip: 'bg-muted-foreground/15',
  },
  active: {
    label: '进行中',
    dot: 'bg-brand',
    text: 'text-brand',
    chip: 'bg-brand/15',
  },
  done: {
    label: '已完成',
    dot: 'bg-success',
    text: 'text-success',
    chip: 'bg-success/15',
  },
  closed: {
    label: '已关闭',
    dot: 'bg-destructive',
    text: 'text-muted-foreground',
    chip: 'bg-destructive/10',
  },
}
