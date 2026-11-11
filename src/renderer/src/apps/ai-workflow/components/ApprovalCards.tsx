import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { CheckIcon, XIcon } from 'lucide-react'
import type { Card } from '../../../../../protocol/entities'
import { COMMAND_LIMITS } from '../../../../../protocol/validate'
import { Button } from '../../../components/ui/button'
import { badgeCls } from '../../../components/ui/panel'
import { Textarea } from '../../../components/ui/textarea'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'
import { groupNotices, isFreeFormOption, isNoticeCard, type NoticeGroup } from '../model/cards'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 高亮保持时长：够看清「就是这张」，又不至于一直亮着抢注意力 */
const HIGHLIGHT_MS = 2400

/** 从通知条 / 系统通知跳进来时，卡片的 DOM 锚点（`scrollIntoView` 与测试都靠它） */
const cardDomId = (cardId: string): string => `approval-card-${cardId}`

/** 选项控件需要的导航键（radiogroup 的键盘约定） */
const NAV_KEYS = new Set(['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'])

export interface ApprovalCardsProps {
  /** 属于同一处（一个任务 / 一个会话）的 open 卡；空数组不占版面 */
  cards: Card[]
  /** 要滚到并高亮的卡：点顶部通知条或系统通知进来时给；卡处理完自然消失 */
  focusCardId?: string | null
}

/**
 * 卡片处理区（任务详情 / 聊天面板内嵌）：**待审批与选择都发生在任务内部**。
 *
 * 顶部通知条只列标题并把人送到这里（见 `ApprovalBar`），正文、选项和关闭动作都在本组件：
 * - 「待审批」（`kind: 'ask'`）：**每张卡独占一条**。选项竖排、一行一个，但**选中不等于提交**：
 *   先点一行把它选中（`role="radio"`，可键盘上下移动），把补充说明写完，再按「提交所选」。
 *   原来「点一行即提交」的写法有两个坑：手滑就答错（`card.answer` 不可撤回），以及
 *   「说点其他的」这类选项被选中时人还没写内容就发出去了——那句答案是空的。现在
 *   前者的代价降到一次多余点击，后者由必填判定挡住；
 * - 「通知」（`kind: 'notice'`）：**同落点同文案的重复知会合并成一行**（`×N`），
 *   右上角 `×` 关掉整组（逐张 dispatch `card.resolve`）——只知会的事不该再多一个动作按钮。
 *
 * 两类卡的视觉刻意分开：待审批用警告色卡头 + 实心面板（要人动作），通知用中性面板、
 * 标题降一档字阶（只需知会），一眼能看出哪块在等你。
 *
 * 视图由调用方读（`cards.open`），本组件只管展示与派发；失败只显示后端文案，卡片保留、不崩。
 */
export function ApprovalCards({ cards, focusCardId }: ApprovalCardsProps): ReactElement | null {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** 每张卡各自的补充说明草稿（按卡片 id），提交后卡片消失、草稿随之无意义 */
  const [notes, setNotes] = useState<Record<string, string>>({})
  /** 每张卡已选中但未提交的选项（按卡片 id）——提交前的一切都还可改 */
  const [picked, setPicked] = useState<Record<string, number>>({})
  /** 就地校验文案（按卡片 id）：必填没写就提交，原因写在输入框下面 */
  const [errors, setErrors] = useState<Record<string, string>>({})
  const noteRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})

  useEffect(() => {
    // 没给定位目标（缺省 / null / 空串）就什么都不做：锚点、滚动、高亮都只服务于「点了通知」
    if (!focusCardId) return
    const anchor = document.getElementById(cardDomId(focusCardId))
    if (anchor === null) return
    // 高亮直接写 DOM，不进 state：它是一次性视觉提示，为它多排一次渲染只会让卡片区闪两下。
    // 这里做的是「同步外部系统」（滚动 + 标记），样式由 `data-[focused=true]:*` 变体接住。
    if (typeof anchor.scrollIntoView === 'function') {
      anchor.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
    anchor.setAttribute('data-focused', 'true')
    const timer = setTimeout(() => anchor.removeAttribute('data-focused'), HIGHLIGHT_MS)
    return () => {
      clearTimeout(timer)
      anchor.removeAttribute('data-focused')
    }
  }, [focusCardId])

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

  const clearLocalError = (cardId: string): void => {
    setErrors((prev) => {
      if (!(cardId in prev)) return prev
      const next = { ...prev }
      delete next[cardId]
      return next
    })
  }

  const requireText = (card: Card, index: number | undefined): boolean =>
    index !== undefined && isFreeFormOption(card.options[index] ?? '')

  const answer = (card: Card, optionIndex: number, note: string): void => {
    // 附言是可选资料：空 / 全空白时不带这个字段，续接提示词就与没有它时逐字一致
    const text = note.trim()
    send(card.id, () =>
      getKernelStore().dispatch({
        type: 'card.answer',
        commandId: '',
        cardId: card.id,
        optionIndex,
        via: 'ui',
        ...(text === '' ? {} : { note: text }),
      }),
    )
  }

  /**
   * 提交选中项。**校验放在这里而不是禁用按钮上**：「选了却说点不动」比弹一句原因更难懂，
   * 没选时按钮带可见理由禁用，选了但没写必填内容时就地点出原因并把焦点送回输入框。
   *
   * 参数收窄成 `number`：没选的时候不渲染这个按钮（见提交条），所以这里不需要「万一没选」的守卫
   * ——那种守卫永远走不到，只会变成一条没人敢删的死分支。
   */
  const submit = (card: Card, index: number): void => {
    const note = notes[card.id] ?? ''
    if (requireText(card, index) && note.trim() === '') {
      setErrors((prev) => ({ ...prev, [card.id]: '这一项要写下具体内容再提交' }))
      noteRefs.current[card.id]?.focus()
      return
    }
    clearLocalError(card.id)
    answer(card, index, note)
  }

  /** 选中一行：只是选中。要提交见 `submit` */
  const select = (card: Card, index: number): void => {
    clearLocalError(card.id)
    setPicked((prev) => ({ ...prev, [card.id]: index }))
  }

  /** 选项组的键盘导航：上下移动即换选中项，并把焦点跟过去（radiogroup 约定） */
  const movePick = (card: Card, event: KeyboardEvent<HTMLDivElement>): void => {
    if (!NAV_KEYS.has(event.key)) return
    const total = card.options.length
    if (total === 0) return
    event.preventDefault()
    const current = picked[card.id] ?? 0
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? total - 1
          : (current + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + total) %
            total
    setPicked((prev) => ({ ...prev, [card.id]: next }))
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
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
    <section aria-label="待处理卡" className="flex flex-col gap-5">
      {pending.length > 0 && (
        <section aria-label="待审批" className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
            待审批
            <span className={badgeCls}>{pending.length}</span>
            <span className="ml-auto text-xs font-normal text-faint-foreground">
              选中一项 → 提交
            </span>
          </h3>
          <ul className="flex flex-col gap-2">
            {pending.map((card) => {
              const index = picked[card.id]
              const needsText = requireText(card, index)
              const localError = errors[card.id]
              const hint =
                index === undefined
                  ? '先选一项，再提交'
                  : needsText
                    ? '这一项要写下具体内容才能提交'
                    : '提交后不能撤回'
              return (
                <li key={card.id}>
                  <div
                    id={cardDomId(card.id)}
                    data-card-id={card.id}
                    className={cn(
                      'overflow-hidden rounded-xl border border-warning/25 bg-card',
                      'transition-[border-color,box-shadow] duration-200 ease-out',
                      'data-[focused=true]:border-brand/60 data-[focused=true]:ring-2 data-[focused=true]:ring-brand/30',
                    )}
                  >
                    {/* 卡头：这条在等你拍板。状态靠色条与文字说，不占标题字号 */}
                    <div className="flex items-center gap-2 border-b border-warning/20 bg-warning/[0.07] px-4 py-2">
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full bg-warning"
                      />
                      <span className="text-xs font-medium text-warning">待你决定</span>
                      <span className="ml-auto shrink-0 text-xs text-faint-foreground tabular-nums">
                        {card.options.length} 个选项
                      </span>
                    </div>

                    <div className="px-4 pt-3 pb-3.5">
                      <p className="text-base font-medium text-foreground">{card.title}</p>
                      {card.text !== '' && (
                        <p className="mt-1.5 text-sm whitespace-pre-wrap text-muted-foreground">
                          {card.text}
                        </p>
                      )}

                      {/* 选项竖排：一行一个、整行可点；序号只做视觉锚点（读屏不念） */}
                      <div
                        role="radiogroup"
                        aria-label={`选项：${card.title}`}
                        className="mt-3 flex flex-col gap-1.5"
                        onKeyDown={(event) => movePick(card, event)}
                      >
                        {card.options.map((option, optionIndex) => {
                          const active = index === optionIndex
                          return (
                            <button
                              key={`${card.id}-${optionIndex}`}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              // roving tabindex：整组只有一个 Tab 停点，组内用方向键换项
                              tabIndex={(index ?? 0) === optionIndex ? 0 : -1}
                              disabled={busy === card.id}
                              onClick={() => select(card, optionIndex)}
                              className={cn(
                                'flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left',
                                'transition-colors duration-150 ease-out outline-none',
                                'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                                active
                                  ? 'border-brand/60 bg-brand/10'
                                  : 'border-border bg-muted/50 hover:bg-accent',
                                'disabled:pointer-events-none disabled:opacity-50',
                              )}
                            >
                              <span
                                aria-hidden="true"
                                className={cn(
                                  'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                                  active
                                    ? 'border-brand bg-brand text-primary-foreground'
                                    : 'border-input',
                                )}
                              >
                                {active && <CheckIcon className="size-3" />}
                              </span>
                              <span className="min-w-0 flex-1 text-sm break-words whitespace-pre-wrap text-foreground">
                                {option}
                              </span>
                              <span
                                aria-hidden="true"
                                className="mt-0.5 shrink-0 text-xs text-faint-foreground tabular-nums"
                              >
                                {optionIndex + 1}
                              </span>
                            </button>
                          )
                        })}
                      </div>

                      {/* 补充说明：选了「说点其他的」就是答案本身（必填），其余选项是可选资料 */}
                      <label className="mt-3 block">
                        <span className="mb-1 block text-xs text-muted-foreground">
                          {needsText
                            ? '补充说明（必填）：写下你选这一项的具体内容'
                            : '补充说明（可选）：有异议或想追问的写在这里，会随所选项一起交给它'}
                        </span>
                        <Textarea
                          ref={(node) => {
                            noteRefs.current[card.id] = node
                          }}
                          aria-label={`补充说明：${card.title}`}
                          aria-required={needsText}
                          aria-invalid={localError !== undefined}
                          rows={2}
                          className="max-h-24 resize-none"
                          value={notes[card.id] ?? ''}
                          maxLength={COMMAND_LIMITS.cardNote}
                          disabled={busy === card.id}
                          placeholder={
                            needsText
                              ? '写下你选这一项的具体内容'
                              : '例如：第 2 条我不同意，先说说依据'
                          }
                          onChange={(event) => {
                            clearLocalError(card.id)
                            const value = event.target.value
                            setNotes((prev) => ({ ...prev, [card.id]: value }))
                          }}
                        />
                      </label>
                      {localError !== undefined && (
                        <p role="alert" className="mt-1.5 text-xs text-destructive">
                          {localError}
                        </p>
                      )}

                      <div className="mt-3 flex items-center gap-2 border-t border-border pt-2.5">
                        <p className="min-w-0 flex-1 text-xs text-faint-foreground">{hint}</p>
                        {/* 没选时按钮禁用且没有回调（点了也没事可做）；理由写在左边的 hint 里。
                            保持同一个 <button>，避免「选中」时换元素导致底色闪一下。 */}
                        <Button
                          type="button"
                          size="sm"
                          disabled={index === undefined || busy === card.id}
                          onClick={index === undefined ? undefined : () => submit(card, index)}
                        >
                          {busy === card.id ? '提交中…' : '提交所选'}
                        </Button>
                      </div>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {notices.length > 0 && (
        <section aria-label="通知" className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
            通知
            <span className={badgeCls}>{notices.length}</span>
          </h3>
          <ul className="flex flex-col gap-1.5">
            {notices.map((group) => (
              <li key={group.id}>
                <div
                  id={cardDomId(group.id)}
                  data-card-id={group.id}
                  className={cn(
                    'rounded-xl border border-border bg-card px-4 py-3',
                    'transition-[border-color,box-shadow] duration-200 ease-out',
                    'data-[focused=true]:border-brand/60 data-[focused=true]:ring-2 data-[focused=true]:ring-brand/30',
                  )}
                >
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-faint-foreground hover:text-foreground"
                      aria-label={`关闭通知：${group.notice.title}`}
                      title="关闭通知"
                      disabled={busy === group.id}
                      onClick={() => dismiss(group)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                </div>
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
