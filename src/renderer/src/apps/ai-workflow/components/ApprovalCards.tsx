import { useState, type ReactElement, type ReactNode } from 'react'
import type { Card } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'
import { groupNotices, isNoticeCard, type NoticeGroup } from '../model/cards'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface ApprovalCardsProps {
  /** 属于同一处（一个任务 / 一个会话）的 open 卡；空数组不占版面 */
  cards: Card[]
}

/**
 * 卡片处理区（任务详情 / 聊天面板内嵌）：**待审批与选择都发生在任务内部**。
 *
 * 顶部通知条只列标题并把人送到这里（见 `ApprovalBar`），正文、选项和关闭动作都在本组件：
 * - 「待审批」（`kind: 'ask'`）：**每张卡独占一条**，选项一行一个（全宽行、序号锚点、行间距 8px），
 *   点一行立即 dispatch `card.answer`（`via='ui'`）。要拍板的事不能合并——两张卡是两个决定；
 * - 「通知」（`kind: 'notice'`）：**同落点同文案的重复知会合并成一行**（`×N`），
 *   右上角 `×` 关掉整组（逐张 dispatch `card.resolve`）——只知会的事不该再多一个动作按钮。
 *
 * 两类卡的视觉也刻意分开：待审批用警告色描底 + 左侧色条（要人动作），通知用中性面板、
 * 标题降一档字阶（只需知会），一眼能看出哪块在等你。
 *
 * 选项为什么竖排：横排行内按钮挨在一起，长文案还会被挤成两三列，误点一次就答错了
 * （`card.answer` 不可撤回）。竖排后每一行的可点区域是整行、行与行之间留 8px、左侧带序号，
 * 手指和鼠标都不容易落错。
 *
 * 视图由调用方读（`cards.open`），本组件只管展示与派发；失败只显示后端文案，卡片保留、不崩。
 */
export function ApprovalCards({ cards }: ApprovalCardsProps): ReactElement | null {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const send = (key: string, run: () => Promise<unknown>): void => {
    void (async () => {
      setBusy(key)
      try {
        await run()
        setError(null)
      } catch (e) {
        // 内核拒绝（重复回答 / 越界 / 已关闭）只改文案，卡片保持原样
        setError(errMsg(e))
      } finally {
        setBusy(null)
      }
    })()
  }

  const answer = (card: Card, optionIndex: number): void => {
    send(card.id, () =>
      getKernelStore().dispatch({
        type: 'card.answer',
        commandId: '',
        cardId: card.id,
        optionIndex,
        via: 'ui',
      }),
    )
  }

  /** 关掉一组信息卡：逐张 resolve，任何一张失败就把后端文案亮出来，其余卡保持原样。 */
  const dismiss = (group: NoticeGroup): void => {
    send(group.id, async () => {
      for (const card of group.cards) {
        await getKernelStore().dispatch({ type: 'card.resolve', commandId: '', cardId: card.id })
      }
    })
  }

  if (cards.length === 0) return null

  const pending = cards.filter((card) => !isNoticeCard(card))
  const notices = groupNotices(cards.filter(isNoticeCard))

  return (
    <section aria-label="待处理卡" className="flex flex-col gap-3">
      {pending.length > 0 && (
        <section aria-label="待审批" className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
            待审批
            <span className={badgeCls}>{pending.length}</span>
          </h3>
          <ul className="flex flex-col gap-2">
            {pending.map((card) => (
              <li key={card.id}>
                <CardShell tone="ask">
                  <p className="text-base font-medium text-foreground">{card.title}</p>
                  {card.text !== '' && (
                    <p className="mt-1.5 text-sm whitespace-pre-wrap text-muted-foreground">
                      {card.text}
                    </p>
                  )}
                  {/* 选项竖排：一行一个，整行可点，序号只是视觉锚点（读屏不念，避免「1 裸名」） */}
                  <p className="mt-3 text-xs text-muted-foreground">点一行即提交，不能撤回</p>
                  <ul aria-label="可选项" className="mt-2 flex flex-col gap-2">
                    {card.options.map((option, index) => (
                      <li key={`${card.id}-${index}`}>
                        <button
                          type="button"
                          disabled={busy === card.id}
                          onClick={() => answer(card, index)}
                          className={cn(
                            'flex min-h-10 w-full items-start gap-2.5 rounded-md px-3 py-2 text-left',
                            'bg-muted text-sm font-medium text-foreground ring-1 ring-border select-none',
                            'transition-colors duration-150 ease-out',
                            'hover:bg-accent hover:ring-input',
                            'focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                            'disabled:pointer-events-none disabled:opacity-40',
                          )}
                        >
                          <span className={cn(badgeCls, 'mt-0.5 shrink-0')} aria-hidden="true">
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                            {option}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </CardShell>
              </li>
            ))}
          </ul>
        </section>
      )}

      {notices.length > 0 && (
        <section aria-label="通知" className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
            通知
            <span className={badgeCls}>{notices.length}</span>
          </h3>
          <ul className="flex flex-col gap-2">
            {notices.map((group) => (
              <li key={group.id}>
                <CardShell>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                        <span className="min-w-0 break-words">{group.notice.title}</span>
                        {group.cards.length > 1 && (
                          <span className={cn(badgeCls, 'shrink-0')} aria-hidden="true">
                            ×{group.cards.length}
                          </span>
                        )}
                      </p>
                      {group.notice.text !== '' && (
                        <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">
                          {group.notice.text}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-8 px-0 text-faint-foreground hover:text-foreground"
                        aria-label={`关闭通知：${group.notice.title}`}
                        title="关闭通知"
                        disabled={busy === group.id}
                        onClick={() => dismiss(group)}
                      >
                        ×
                      </Button>
                    </div>
                  </div>
                </CardShell>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

/**
 * 卡片外壳：两种卡片的区别靠底色 + 描边 + 左侧色条，不靠字号猜。
 *
 * - `tone='ask'`：警告色描底 + 左侧 2px 警告色条 —— 这里在等你拍板，答完才续接；
 * - 无 `tone`：中性面板 —— 只是一条知会，看完点掉即可。
 */
function CardShell({ tone, children }: { tone?: 'ask'; children: ReactNode }): ReactElement {
  return (
    <div
      className={
        tone === 'ask'
          ? 'rounded-xl border border-l-2 border-warning/25 border-l-warning bg-warning/[0.06] px-4 py-3'
          : 'rounded-xl border border-border bg-card px-4 py-3'
      }
    >
      {children}
    </div>
  )
}
