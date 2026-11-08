/**
 * 卡片读侧视图（渲染层）：判类型、合并信息卡。规则本身在内核，这里只读。
 *
 * - **判据**：`Card.kind` 由内核建卡时写明（M12）；老宿主 / 迁移前的行没有这一列，
 *   缺省时按「有没有选项」兜底，与 `kernel/project.normalizeCard` 同一口径。
 *   没有这层兜底，缺列会把信息卡塞进「待审批」——看到的就是「通知和 ask 混在一起、
 *   样式一样、还没有关闭按钮」。
 * - **合并**：同落点、同标题、同正文的信息卡只占一行（`×N` 记次数，一个 `×` 整组关闭）；
 *   `ask` 每张都要单独拍板，**永远不合并**。
 */
import type { Card } from '../../../../../protocol/entities'

/** 信息卡（只知会，不需要拍板）：`kind='notice'`，或老数据缺 `kind` 且没有选项。 */
export function isNoticeCard(card: Card): boolean {
  const kind = (card as { kind?: Card['kind'] }).kind
  return kind === 'notice' || (kind === undefined && card.options.length === 0)
}

/** 一组同文案的信息卡（合并后的展示单元） */
export interface NoticeGroup {
  /** React key 与「处理中」标记：取组内第一张卡的 id */
  id: string
  /** 代表卡：标题 / 正文 / 落点都取它 */
  notice: Card
  /** 组内全部 open 卡：点一次「知道了」把它们一起关掉 */
  cards: Card[]
}

/**
 * 合并信息卡：同落点、同标题、同正文的重复知会收敛成一行。
 *
 * 智能体每轮都可能再报一次同样的结论，不合并就会在「通知」栏里越堆越长；
 * 合并只按文案与落点，**不跨文案**——不同的话合并会藏掉信息。
 */
export function groupNotices(notices: readonly Card[]): NoticeGroup[] {
  const groups = new Map<string, Card[]>()
  for (const card of notices) {
    const key = [card.taskId ?? '', card.conversationId ?? '', card.title, card.text].join('\u0000')
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [card])
    else bucket.push(card)
  }
  return [...groups.values()].map((cards) => ({
    id: cards[0].id,
    notice: cards[0],
    cards,
  }))
}
