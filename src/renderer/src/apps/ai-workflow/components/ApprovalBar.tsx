import { useState, type ReactElement } from 'react'
import type { Card } from '../../../../../protocol/entities'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * 顶部「待审批」条（M4 最小审批面，M5 改内核视图 + 命令）。
 *
 * 读 `cards.open` 视图（全部 open 卡，按 createdAt 升序），每条卡展示标题 / 正文摘要 / 选项按钮；
 * 点击即 dispatch `card.answer`（`via='ui'`）。成功后随 `card.*` 事实失效自动重取视图，
 * 失败（重复回答 / 越界 / 已关闭）只显示后端文案，卡片保留、不崩。无 open 卡时不渲染。
 */
export function ApprovalBar(): ReactElement | null {
  const cardsState = useKernelViewState('cards.open')
  const cards = cardsState.data ?? []
  const [error, setError] = useState<string | null>(null)
  const [answering, setAnswering] = useState<string | null>(null)

  const answer = (card: Card, optionIndex: number): void => {
    void (async () => {
      setAnswering(card.id)
      try {
        await getKernelStore().dispatch({
          type: 'card.answer',
          commandId: '',
          cardId: card.id,
          optionIndex,
          via: 'ui',
        })
        setError(null)
      } catch (e) {
        // 内核拒绝（重复回答 / 越界 / 已关闭）只改文案，卡片与列表保持原样
        setError(errMsg(e))
      } finally {
        setAnswering(null)
      }
    })()
  }

  // 无待审批卡：不占版面（错误只在有卡可答时才有展示语境）
  if (cards.length === 0) return null

  const shownError = error ?? cardsState.error

  return (
    <section
      aria-label="待审批"
      className="mx-4 mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-wide text-amber-200">待审批</span>
        <span className="rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[11px] text-ink-dim tabular-nums">
          {cards.length}
        </span>
      </div>

      <ul className="mt-1.5 flex flex-col gap-2">
        {cards.map((card) => (
          <li key={card.id} className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] leading-snug text-ink">{card.title}</p>
              {card.text !== '' && (
                <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-faint">
                  {card.text}
                </p>
              )}
            </div>
            {card.options.length > 0 && (
              <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                {card.options.map((option, index) => (
                  <button
                    key={`${card.id}-${index}`}
                    type="button"
                    disabled={answering === card.id}
                    onClick={() => answer(card, index)}
                    className={cn(
                      'rounded-lg border border-line px-2 py-0.5 text-xs text-ink',
                      'transition-colors hover:bg-white/10 disabled:cursor-default disabled:opacity-50',
                    )}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      {shownError !== null && (
        <p role="alert" className="mt-1.5 text-[11px] text-red-300">
          {shownError}
        </p>
      )}
    </section>
  )
}
