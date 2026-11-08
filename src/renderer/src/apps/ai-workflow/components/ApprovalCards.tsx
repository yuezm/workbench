import { useState, type ReactElement, type ReactNode } from 'react'
import type { Card } from '../../../../../protocol/entities'
import { Button } from '../../../components/ui/button'
import { badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 信息卡（`kind: 'notice'`）只是一条知会：给一个「知道了」把卡关掉，不要求选择。 */
const isNotice = (card: Card): boolean => card.kind === 'notice'

export interface ApprovalCardsProps {
  /** 属于同一处（一个任务 / 一个会话）的 open 卡；空数组不占版面 */
  cards: Card[]
}

/**
 * 卡片处理区（任务详情 / 聊天面板内嵌）：**待审批与选择都发生在任务内部**。
 *
 * 顶部通知条只列标题并把人送到这里（见 `ApprovalBar`），正文、选项和关闭动作都在本组件：
 * - 「待审批」：`kind !== 'notice'` 的阻塞卡，**选项一行一个**（全宽行、序号锚点、行间距 6px），
 *   点一行立即 dispatch `card.answer`（`via='ui'`）；
 * - 「通知」：`kind: 'notice'` 的回执 `notices` 信息卡，点「知道了」dispatch `card.resolve`。
 *
 * 选项为什么竖排：横排行内按钮挨在一起，长文案还会被挤成两三列，误点一次就答错了
 * （`card.answer` 不可撤回）。竖排后每一行的可点区域是整行、行与行之间留 6px、左侧带序号，
 * 手指和鼠标都不容易落错。
 *
 * 视图由调用方读（`cards.open`），本组件只管展示与派发；失败只显示后端文案，卡片保留、不崩。
 */
export function ApprovalCards({ cards }: ApprovalCardsProps): ReactElement | null {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const send = (cardId: string, run: () => Promise<unknown>): void => {
    void (async () => {
      setBusy(cardId)
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

  const dismiss = (card: Card): void => {
    send(card.id, () =>
      getKernelStore().dispatch({ type: 'card.resolve', commandId: '', cardId: card.id }),
    )
  }

  if (cards.length === 0) return null

  const pending = cards.filter((card) => !isNotice(card))
  const notices = cards.filter(isNotice)

  return (
    <section aria-label="待处理卡" className="flex flex-col gap-3">
      {pending.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-title font-medium text-ink">
            待审批
            <span className={badgeCls}>{pending.length}</span>
          </h3>
          <ul className="flex flex-col gap-2">
            {pending.map((card) => (
              <li key={card.id}>
                <CardShell tone="warn">
                  <p className="text-title font-medium text-ink">{card.title}</p>
                  {card.text !== '' && (
                    <p className="mt-1.5 text-body whitespace-pre-wrap text-ink-dim">{card.text}</p>
                  )}
                  {/* 选项竖排：一行一个，整行可点，序号只是视觉锚点（读屏不念，避免「1 裸名」） */}
                  <p className="mt-3 text-meta text-ink-dim">点一行即提交，不能撤回</p>
                  <ul aria-label="可选项" className="mt-2 flex flex-col gap-2">
                    {card.options.map((option, index) => (
                      <li key={`${card.id}-${index}`}>
                        <button
                          type="button"
                          disabled={busy === card.id}
                          onClick={() => answer(card, index)}
                          className={cn(
                            'flex min-h-10 w-full items-start gap-2.5 rounded-md px-3 py-2 text-left',
                            'bg-surface-2 text-action font-medium text-ink ring-1 ring-line select-none',
                            'transition-colors duration-150 ease-out',
                            'hover:bg-surface-3 hover:ring-line-strong',
                            'focus-visible:ring-2 focus-visible:ring-focus/50 focus-visible:ring-offset-2 focus-visible:ring-offset-abyss',
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
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-title font-medium text-ink">
            通知
            <span className={badgeCls}>{notices.length}</span>
          </h3>
          <ul className="flex flex-col gap-2">
            {notices.map((card) => (
              <li key={card.id}>
                <CardShell>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-title font-medium text-ink">{card.title}</p>
                      {card.text !== '' && (
                        <p className="mt-1 text-body whitespace-pre-wrap text-ink-dim">
                          {card.text}
                        </p>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy === card.id}
                      onClick={() => dismiss(card)}
                    >
                      知道了
                    </Button>
                  </div>
                </CardShell>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error !== null && (
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

/** 卡片外壳：待审批用警告色描底（要人动作），通知用常规面板底色（只需知会） */
function CardShell({ tone, children }: { tone?: 'warn'; children: ReactNode }): ReactElement {
  return (
    <div
      className={
        tone === 'warn'
          ? 'rounded-xl border border-warn/25 bg-warn/[0.06] px-4 py-3'
          : 'rounded-xl border border-line bg-surface px-4 py-3'
      }
    >
      {children}
    </div>
  )
}
