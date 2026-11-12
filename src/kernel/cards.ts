/**
 * 卡片生命周期（纯函数，M4）：回执 → `card.*` 事实；回答 → `card.answered` + 续接
 * `run.queued`；关闭 → `card.resolved`。
 *
 * 口径（m4-plan D5–D7、评审结论 2）：
 * - 每条 `ask` 建一张卡（`version=1`、`delivery='pending'`）；同一 run 内同 `key` 的
 *   open 卡再出现时产 `card.updated`（`version+1`、投递重置 `pending`）；
 * - `notices` 每项建一张 `options: []` 的信息卡，**不阻塞 run**、不进 `run.waiting.cardIds`；
 * - `resolves` 只关同一 run 里既有的 open 卡（未知 / 已回答 / 已关闭的 id 零事实）；
 * - `card.answer` 校验「卡片存在 + open + 选项下标合法 + run 仍在 waiting」，产
 *   `card.answered`；该 run 的**阻塞卡**（`options` 非空）全部 answered 后才产续接
 *   `run.queued`（同 run、`turn+1`、`resumeSessionId` 取上一轮会话、清租约与取消标记）。
 *
 * 卡片正文是智能体产出的文字，这里只做数据搬运，不拼进命令 / 提示词里的可执行内容。
 */
import type { Card, CardAnswerVia, CardResolveReason, RunRow } from '../protocol/entities'
import type { CardAnswerCommand } from '../protocol/commands'
import type { Receipt } from '../protocol/inputs'
import type { Actor, Decision, Environment, FactDraft, Id, Iso, View } from './types'
import { answerPrompt, expiredPrompt } from './prompt'
import { plusMs } from './run'

/** 回执事实的 actor：与 `run.receipt` 的其它事实同口径（宿主调度器）。 */
const HOST: Actor = { kind: 'host', via: 'scheduler' }

/** 超时关闭卡片的 actor（宿主定时器到点，不是人也不是调度器）。 */
const TIMER: Actor = { kind: 'host', via: 'timer' }

/**
 * 卡片等人回答的最长时间（M28）。
 *
 * 为什么要有它：实测（线程 `27787670`）两次卡片各挂了 51 分钟才被回答，而这两次问题
 * 都是「方案选型」「待改项谁来落地」——本来就能由智能体自决。超时后关闭卡片、让它带着
 * 已知约束继续，比让人在界面上被动地卡一天更划算；想拦的人仍然可以在这 20 分钟里回答。
 */
export const CARD_TIMEOUT_MS = 20 * 60_000

/** 卡片到期时刻（`createdAt + CARD_TIMEOUT_MS`）。 */
const expiredAt = (card: Card): Iso => plusMs(card.createdAt, CARD_TIMEOUT_MS)

/** 关闭原因 → actor：agent 来自回执、manual 来自 owner、cancelled 来自宿主取消兜底。 */
const RESOLVE_ACTOR: Record<CardResolveReason, Actor> = {
  agent: HOST,
  manual: { kind: 'owner', via: 'ui' },
  cancelled: { kind: 'host', via: 'cancel' },
  expired: TIMER,
}

/** 卡片的稳定顺序：创建时间升序，同毫秒按 id（与 `cards.open` / `cards.byRun` 一致）。 */
function compareCards(a: Card, b: Card): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
}

/** 某 run 的全部卡片（含已答 / 已关闭），按创建时间升序。 */
function cardsOfRun(view: View, runId: Id): Card[] {
  const cards: Card[] = []
  for (const card of view.cards.values()) {
    if (card.runId === runId) cards.push(card)
  }
  return cards.sort(compareCards)
}

/** 某 run 的 open 卡，按创建时间升序。 */
function openCardsOfRun(view: View, runId: Id): Card[] {
  return cardsOfRun(view, runId).filter((card) => card.status === 'open')
}

/**
 * 阻塞卡（`kind: 'ask'`）：只有它需要回答；信息卡（`kind: 'notice'`，`options` 空）
 * 不阻塞续接。判据用显式 `kind`，不再靠「选项是否为空」推断（M12）。
 */
const isBlocking = (card: Card): boolean => card.kind === 'ask'

/**
 * 回执 → 卡片事实（D5）。
 *
 * 返回本次 `ask` 产生的卡片 id（填 `run.waiting.cardIds`）；信息卡与关闭事实只产事实、
 * 不进 cardIds。顺序固定：ask（opened / updated）→ notices（opened）→ resolves（resolved）。
 */
export interface ReceiptCards {
  facts: FactDraft[]
  cardIds: Id[]
}

export function cardsFromReceipt(
  view: View,
  run: RunRow,
  receipt: Receipt,
  now: Iso,
  env: Environment,
): ReceiptCards {
  const facts: FactDraft[] = []
  const cardIds: Id[] = []
  // 同一次回执里同 key 的多条 ask 也要归并到同一张卡，所以维护一份工作集；
  // resolves 只认回执之前的 open 卡（关掉的「旧」卡片），不关本次刚建的卡。
  const existingOpen = openCardsOfRun(view, run.id)
  const open = [...existingOpen]

  for (const ask of receipt.ask ?? []) {
    const key = ask.key ?? null
    const existing = key === null ? undefined : open.find((card) => card.key === key)
    if (existing) {
      const card: Card = {
        ...existing,
        title: ask.title,
        text: ask.text ?? '',
        options: [...ask.options],
        version: existing.version + 1,
        delivery: 'pending',
        deliveryRef: null,
        updatedAt: now,
      }
      facts.push({
        type: 'card.updated',
        actor: HOST,
        at: now,
        payload: {
          card,
          changes: ['title', 'text', 'options', 'version', 'delivery'],
        },
      })
      cardIds.push(card.id)
      open[open.indexOf(existing)] = card
      continue
    }
    const card: Card = {
      id: env.nextId('card'),
      runId: run.id,
      taskId: run.taskId,
      conversationId: run.conversationId,
      title: ask.title,
      text: ask.text ?? '',
      kind: 'ask',
      options: [...ask.options],
      key,
      version: 1,
      status: 'open',
      delivery: 'pending',
      deliveryRef: null,
      optionIndex: null,
      answeredBy: null,
      answeredAt: null,
      createdAt: now,
      updatedAt: now,
    }
    facts.push({ type: 'card.opened', actor: HOST, at: now, payload: { card } })
    cardIds.push(card.id)
    open.push(card)
  }

  for (const notice of receipt.notices ?? []) {
    const card: Card = {
      id: env.nextId('card'),
      runId: run.id,
      taskId: run.taskId,
      conversationId: run.conversationId,
      title: notice,
      text: '',
      kind: 'notice',
      options: [],
      key: null,
      version: 1,
      status: 'open',
      delivery: 'pending',
      deliveryRef: null,
      optionIndex: null,
      answeredBy: null,
      answeredAt: null,
      createdAt: now,
      updatedAt: now,
    }
    facts.push({ type: 'card.opened', actor: HOST, at: now, payload: { card } })
  }

  // resolves 只关既有的 open 卡（输入契约：关掉的「旧」卡片 id）；同一 id 重复出现只关一次。
  const resolved = new Set<Id>()
  for (const cardId of receipt.resolves ?? []) {
    if (resolved.has(cardId)) continue
    const card = existingOpen.find((entry) => entry.id === cardId)
    if (!card) continue
    resolved.add(cardId)
    facts.push(...resolveFacts(view, cardId, 'agent', now))
  }

  return { facts, cardIds }
}

/** 关闭一张 open 卡（`agent` 来自回执 / `manual` 来自命令 / `cancelled` 由 run 取消）；非 open 幂等零事实。 */
export function resolveFacts(
  view: View,
  cardId: Id,
  reason: CardResolveReason,
  now: Iso,
): FactDraft<'card.resolved'>[] {
  const card = view.cards.get(cardId)
  if (!card || card.status !== 'open') return []
  const resolved: Card = { ...card, status: 'resolved', updatedAt: now }
  return [
    {
      type: 'card.resolved',
      actor: RESOLVE_ACTOR[reason],
      at: now,
      payload: { card: resolved, reason },
    },
  ]
}

/**
 * 卡片超时（M28）：等待超过 `CARD_TIMEOUT_MS` 的 `ask` 卡关闭，并把该 run 续接一轮。
 *
 * 口径：
 * - 只看 `open` 的 `ask` 卡（`notice` 不阻塞，不需要超时），且所属 run 仍在 `waiting`
 *   ——run 已经离开等待态说明卡早晚会被 `closeCardsOnFinish` 收掉，这里不重复处理；
 * - **只对阶段 run 生效**：续接提示词是阶段口径（验收 / 闸门 / 待改项），而聊天由人发起，
 *   没人问话时助手自己接着说一轮不是「继续干活」，是自言自语；
 * - 同一 run 的多张卡一起关、只续接一次（续接提示词里列出全部超时问题）；
 * - 到期判定用 `createdAt + CARD_TIMEOUT_MS` 与注入的 `now` 比较，不读时钟。
 */
export function expiredCardFacts(
  view: View,
  now: Iso,
): FactDraft<'card.resolved' | 'run.queued'>[] {
  const facts: FactDraft<'card.resolved' | 'run.queued'>[] = []
  const byRun = new Map<Id, { run: RunRow; cards: Card[] }>()
  for (const card of view.cards.values()) {
    if (card.status !== 'open' || card.kind !== 'ask') continue
    if (expiredAt(card) > now) continue
    const run = view.runs.get(card.runId)
    if (!run || run.status !== 'waiting' || run.purpose !== 'stage') continue
    const bucket = byRun.get(card.runId)
    if (bucket) bucket.cards.push(card)
    else byRun.set(card.runId, { run, cards: [card] })
  }
  for (const { run, cards } of byRun.values()) {
    const ordered = [...cards].sort(compareCards)
    for (const card of ordered) facts.push(...resolveFacts(view, card.id, 'expired', now))
    facts.push({
      type: 'run.queued',
      actor: TIMER,
      at: now,
      payload: { run: resumedRun(run, expiredPrompt(ordered), null) },
    })
  }
  return facts
}

/**
 * 续接入队行（回答完毕 / `later` 复查）：回到 `queued`，`turn+1`，续接上一轮的会话 id，
 * 清租约与超时时刻、重置 `cancelRequested`（D6/D7）。`notBefore` 只在 `later` 时非空。
 */
export function resumedRun(run: RunRow, prompt: string, notBefore: Iso | null): RunRow {
  return {
    ...run,
    status: 'queued',
    turn: run.turn + 1,
    resumeSessionId: run.sessionId ?? run.resumeSessionId,
    notBefore,
    leaseId: null,
    leaseUntil: null,
    deadlineAt: null,
    cancelRequested: false,
    deliverables: null,
    prompt,
  }
}

/**
 * `card.answer`（D6）：校验卡片存在、`open`、选项下标合法、run 仍在 `waiting`，产
 * `card.answered`；该 run 的阻塞卡全部答完时追加续接 `run.queued`（prompt 带全部问答对，
 * 以及人随答案写的补充说明）。
 *
 * `note` 只搬进事实与续接提示词的**资料**段：它是人写的自由文本，不能拼进指令段，也不改
 * 阶段流转、不消耗闸门预算——判定与去向仍然只由回执 `verdict` 与人拖卡片决定。
 * 非法 / 重复回答一律 `reject`，零事实。
 */
export function answerFacts(
  view: View,
  input: CardAnswerCommand,
  now: Iso,
  _env: Environment,
): Decision {
  const card = view.cards.get(input.cardId)
  if (!card)
    return { facts: [], reject: { code: 'not_found', message: '卡片不存在: ' + input.cardId } }
  if (card.status !== 'open') {
    return {
      facts: [],
      reject: { code: 'conflict', message: '卡片已回答或已关闭: ' + card.id },
    }
  }
  // 信息卡（options 为空）没有合法下标，越界一律 invalid_input（不产事实、不覆盖已有回答）。
  if (
    !Number.isInteger(input.optionIndex) ||
    input.optionIndex < 0 ||
    input.optionIndex >= card.options.length
  ) {
    return {
      facts: [],
      reject: { code: 'invalid_input', message: '选项下标越界: ' + String(input.optionIndex) },
    }
  }
  const run = view.runs.get(card.runId)
  if (!run || run.status !== 'waiting') {
    return {
      facts: [],
      reject: { code: 'conflict', message: '运行不存在或不在等待状态: ' + card.runId },
    }
  }

  const by: CardAnswerVia = input.via ?? 'ui'
  const answered: Card = {
    ...card,
    status: 'answered',
    optionIndex: input.optionIndex,
    answeredBy: by,
    answeredAt: now,
    updatedAt: now,
  }
  /** 人随答案写的补充说明：空 / 全空白等于没写，不进事实也不进提示词 */
  const note = input.note?.trim() ?? ''
  const facts: FactDraft[] = [
    {
      type: 'card.answered',
      actor: { kind: 'owner', via: by },
      at: now,
      payload: { card: answered, by, ...(note === '' ? {} : { note }) },
    },
  ]

  // 同一 run 里还有没答的阻塞卡（信息卡不算）→ run 保持 waiting，不产入队事实。
  const others = openCardsOfRun(view, run.id).some(
    (entry) => entry.id !== answered.id && isBlocking(entry),
  )
  if (others) return { facts }

  // 该 run 的问答对（已回答的卡片，按创建时间升序）；本卡用答后的状态参与拼装。
  // 已知边界：附言随「最后一张答完」的那次续接进提示词，同一批多张卡各自的附言只有最后
  // 一张会被带上（其余留在 `card.answered.note` 事实里可审计）。M12 的打扰规则要求同一轮
  // 只发一张 ask 卡，闸门判定也是一张卡，产品路径上不会走到这一支。
  const batch = cardsOfRun(view, run.id)
    .filter((entry) => entry.id !== answered.id && entry.optionIndex !== null)
    .concat(answered)
    .sort(compareCards)
  facts.push({
    type: 'run.queued',
    actor: HOST,
    at: now,
    payload: { run: resumedRun(run, answerPrompt(batch, note), null) },
  })
  return { facts }
}

/**
 * 运行 / 任务结束时收起还 open 的卡（M12 补口）。
 *
 * 卡片只在「等人回答」时有意义：run 落终态（成功 / 失败 / 取消）或任务完成后，留在
 * `cards.open` 里就是「审批和通知还不消失」。这里在决策出口统一扫一遍，覆盖回执直接结束、
 * 宿主兜底终态、取消、任务完成等所有路径：
 *
 * - 候选 = 视图里还 open 的卡（其 run 本批终态，或所属任务本批完成）+ 本批新开在终态 run 上的卡；
 * - 本批已经回答 / 关闭 / 更新过的卡跳过（事实顺序优先，不重复产 `card.resolved`）；
 * - 理由统一 `cancelled`：是宿主随运行结束收尾，不是人点掉的，actor 随之记 host/cancel。
 *
 * 纯函数：只读视图与已产出的事实，不猜别的状态。
 */
export function closeCardsOnFinish(view: View, decision: Decision, now: Iso): Decision {
  if (decision.facts.length === 0) return decision
  const finishedRuns = new Set<Id>()
  const finishedTasks = new Set<Id>()
  /** 本批已经答掉 / 关掉的卡不再补一条关闭；本批新开的卡仍要按「run 是否结束」处理 */
  const touched = new Set<Id>()

  for (const fact of decision.facts) {
    switch (fact.type) {
      case 'run.succeeded':
      case 'run.failed':
      case 'run.cancelled':
        finishedRuns.add((fact.payload as { run: RunRow }).run.id)
        break
      case 'task.completed':
        finishedTasks.add((fact.payload as { task: { id: Id } }).task.id)
        break
      case 'card.answered':
      case 'card.resolved':
        touched.add((fact.payload as { card: Card }).card.id)
        break
      default:
        break
    }
  }
  if (finishedRuns.size === 0 && finishedTasks.size === 0) return decision

  /** 卡的 run / 任务是否在本批结束 */
  const closes = (card: Card): boolean =>
    (card.runId !== null && finishedRuns.has(card.runId)) ||
    (card.taskId !== null && finishedTasks.has(card.taskId))

  const candidates = new Map<Id, Card>()
  for (const card of view.cards.values()) {
    if (card.status === 'open' && closes(card)) candidates.set(card.id, card)
  }
  // 同批新开的卡（回执成功的同时给了 notices）也在这里收掉：它们不在视图里
  for (const fact of decision.facts) {
    if (fact.type !== 'card.opened') continue
    const card = (fact.payload as { card: Card }).card
    if (closes(card)) candidates.set(card.id, card)
  }

  const facts = [...decision.facts]
  for (const card of [...candidates.values()].sort(compareCards)) {
    if (touched.has(card.id)) continue
    // 同批新开的卡不在视图里，不能走 resolveFacts（它按 id 回查视图），直接按行造事实
    const resolved: Card = { ...card, status: 'resolved', updatedAt: now }
    facts.push({
      type: 'card.resolved',
      actor: RESOLVE_ACTOR.cancelled,
      at: now,
      payload: { card: resolved, reason: 'cancelled' },
    })
  }
  return facts.length === decision.facts.length ? decision : { ...decision, facts }
}
