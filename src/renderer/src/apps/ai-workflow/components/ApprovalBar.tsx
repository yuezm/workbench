import { useState, type ReactElement } from 'react'
import type { Card } from '../../../../../protocol/entities'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 信息卡（`options` 为空）只是一条通知：给一个「知道了」把卡关掉，不要求选择。 */
const isNotice = (card: Card): boolean => card.options.length === 0

/**
 * 顶部审批区（M4 最小审批面，M5 改内核视图 + 命令）。
 *
 * 读 `cards.open` 视图（全部 open 卡，按 createdAt 升序），按是否需要回答分两栏：
 * - 「待审批」：`options` 非空的阻塞卡，点选项即 dispatch `card.answer`（`via='ui'`）；
 * - 「通知」：`options` 为空的回执 `notices` 信息卡，点「知道了」dispatch `card.resolve`。
 *
 * 两栏都随 `card.*` 事实失效自动重取视图；失败（重复回答 / 越界 / 已关闭）只显示后端文案，
 * 卡片保留、不崩。无 open 卡时整块不渲染。
 */
export function ApprovalBar(): ReactElement | null {
  const cardsState = useKernelViewState('cards.open')
  const cards = cardsState.data ?? []
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const send = (cardId: string, run: () => Promise<unknown>): void => {
    void (async () => {
      setBusy(cardId)
      try {
        await run()
        setError(null)
      } catch (e) {
        // 内核拒绝（重复回答 / 越界 / 已关闭）只改文案，卡片与列表保持原样
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

  // 无卡：不占版面（错误只在有卡可处理时才有展示语境）
  if (cards.length === 0) return null

  const pending = cards.filter((card) => !isNotice(card))
  const notices = cards.filter(isNotice)
  const shownError = error ?? cardsState.error

  return (
    <div className="mx-4 mt-3 flex flex-col gap-2">
      {pending.length > 0 && (
        <section
          aria-label="待审批"
          className="rounded-xl border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2"
        >
          <SectionHead label="待审批" count={pending.length} tone="text-amber-200" />
          <ul className="mt-1.5 flex flex-col gap-2">
            {pending.map((card) => (
              <li key={card.id} className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] leading-snug text-ink">{card.title}</p>
                  {card.text !== '' && (
                    <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-faint">
                      {card.text}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  {card.options.map((option, index) => (
                    <button
                      key={`${card.id}-${index}`}
                      type="button"
                      disabled={busy === card.id}
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
              </li>
            ))}
          </ul>
        </section>
      )}

      {notices.length > 0 && (
        <section aria-label="通知" className="rounded-xl border border-line bg-surface px-3 py-2">
          <SectionHead label="通知" count={notices.length} tone="text-ink-faint" />
          <ul className="mt-1.5 flex flex-col gap-2">
            {notices.map((card) => (
              <li key={card.id} className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-3 text-[13px] leading-snug text-ink-dim">{card.title}</p>
                  {card.text !== '' && (
                    <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-faint">
                      {card.text}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={busy === card.id}
                  onClick={() => dismiss(card)}
                  className={cn(
                    'shrink-0 rounded-lg border border-line px-2 py-0.5 text-xs text-ink',
                    'transition-colors hover:bg-white/10 disabled:cursor-default disabled:opacity-50',
                  )}
                >
                  知道了
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {shownError !== null && (
        <p role="alert" className="px-1 text-[11px] text-red-300">
          {shownError}
        </p>
      )}
    </div>
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
      <span className={cn('text-[11px] font-medium tracking-wide', tone)}>{label}</span>
      <span className="rounded-sm bg-white/[0.07] px-1.5 py-0.5 text-[11px] text-ink-dim tabular-nums">
        {count}
      </span>
    </div>
  )
}
