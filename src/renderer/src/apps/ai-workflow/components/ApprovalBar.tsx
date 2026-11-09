import type { ReactElement } from 'react'
import type { Card } from '../../../../../protocol/entities'
import { badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'
import { groupNotices, isNoticeCard } from '../model/cards'

/** 卡片的落点：挂任务的卡进任务详情，聊天卡进对应会话 */
const targetOf = (card: Card): 'task' | 'conversation' | null =>
  card.taskId !== null ? 'task' : card.conversationId !== null ? 'conversation' : null

const TARGET_LABEL: Record<'task' | 'conversation', string> = {
  task: '任务',
  conversation: '对话',
}

export interface ApprovalBarProps {
  /** 全部 open 卡（`cards.open` 视图），由页面读取后下传 */
  cards: Card[]
  /** 点条目 → 跳到该卡的落点（任务详情 / 会话），处理动作在落点内做 */
  onOpen: (card: Card) => void
}

/**
 * 顶部通知条：**只列标题**，不展示正文与选项。
 *
 * 卡片正文可能很长（智能体写出来的问题背景、事实清单、多个候选项），塞在顶栏会挤掉工作区；
 * 而回答又需要上下文。所以这里只做「有人在等你」的信标：一行标题 + 落点与选项数，
 * 点进任务详情（或会话）后再看正文、再选（见 `ApprovalCards`）。
 *
 * 两栏口径不同：
 * - 「待审批」一张卡一行，**不合并**——两个决定不能挤成一行；
 * - 「通知」按落点 + 文案合并，同一句知会重复 N 次只占一行（`×N`），点进落点整组关掉。
 *
 * 无 open 卡时整块不渲染。`cards.open` 读失败的文案不在这里展示：条子在没有卡时整块消失，
 * 把错误挂在条子里等于「有错误但没有地方显示」，那条错误统一由页面级错误条播报。
 */
export function ApprovalBar({ cards, onOpen }: ApprovalBarProps): ReactElement | null {
  if (cards.length === 0) return null

  const pending = cards.filter((card) => !isNoticeCard(card))
  const notices = groupNotices(cards.filter(isNoticeCard))

  return (
    <div className="mx-4 mt-3 flex flex-col gap-2">
      {pending.length > 0 && (
        <section
          aria-label="待审批"
          className="rounded-xl border border-warning/20 bg-warning/[0.06] px-3 py-2"
        >
          <SectionHead label="待审批" count={pending.length} tone="text-warning" />
          <ul className="mt-1 flex flex-col">
            {pending.map((card) => (
              <li key={card.id}>
                <Row
                  card={card}
                  note={card.options.length > 0 ? `${card.options.length} 项待选` : null}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {notices.length > 0 && (
        <section aria-label="通知" className="rounded-xl border border-border bg-card px-3 py-2">
          <SectionHead label="通知" count={notices.length} tone="text-faint-foreground" />
          <ul className="mt-1 flex flex-col">
            {notices.map((group) => (
              <li key={group.id}>
                <Row
                  card={group.notice}
                  note={group.cards.length > 1 ? `×${group.cards.length}` : null}
                  onOpen={onOpen}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** 一行一张卡 / 一组通知：标题单行截断，尾随计数与落点；整行可点 */
function Row({
  card,
  note,
  onOpen,
}: {
  card: Card
  /** 尾随的次要徽标：待审批是「N 项待选」，合并后的通知是「×N」 */
  note: string | null
  onOpen: (card: Card) => void
}): ReactElement {
  const target = targetOf(card)
  return (
    <button
      type="button"
      disabled={target === null}
      onClick={() => onOpen(card)}
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent disabled:cursor-default"
    >
      <span className="min-w-0 flex-1 truncate text-base font-medium text-foreground">
        {card.title}
      </span>
      {note !== null && (
        <span className={cn(badgeCls, 'shrink-0')} aria-hidden={note.startsWith('×')}>
          {note}
        </span>
      )}
      {target !== null && (
        <span className="shrink-0 text-xs text-faint-foreground">{TARGET_LABEL[target]}</span>
      )}
    </button>
  )
}

/** 段落标题 + 计数徽标（两栏样式一致，只换标题色调） */
function SectionHead({
  label,
  count,
  tone,
}: {
  label: string
  count: number
  tone: string
}): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className={cn('text-xs font-medium', tone)}>{label}</span>
      <span className={cn(badgeCls, 'tabular-nums')}>{count}</span>
    </div>
  )
}
