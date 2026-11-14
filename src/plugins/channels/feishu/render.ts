/**
 * 飞书卡片渲染（`src/plugins/channels/feishu/render.ts`）：纯函数，不碰 IO。
 *
 * 卡片正文是智能体写的文字，**只作卡片 JSON 的字段值**（不拼命令行 / 不拼模板字符串）：
 * 这里产出的对象由调用方 `JSON.stringify` 后整串作为 `lark-cli --content` 的参数。
 *
 * 结构（Card 2.0，见 lark-im `card/lark-im-card-create.md`）：
 * - `header` 承载标题与状态色：待答 `blue`、只知会 / 已关闭 `grey`、已答复 `green`；
 * - `body` 一个 `markdown` 放正文；`ask` 卡在 open 时按选项竖排一列按钮，答完 / 关闭后
 *   **按钮消失、换成结论**——按钮留在旧卡上等于允许重复作答（内核也会拒，但看着像没反应）；
 * - 选项按钮是等价选择（没有「主操作」），一律 `default` + 撑满，长文案换行而不截断。
 */
import type { Card } from '../../../protocol/entities'

/** 卡片状态色（`header.template`）：各状态一个语义色，与工作台一致。 */
export const FEISHU_CARD_TEMPLATES = {
  ask: 'blue',
  notice: 'grey',
  answered: 'green',
  resolved: 'grey',
} as const

/** 按钮回传值：`card` 是工作台卡片 id，`choice` 是选项下标（内核按它落 `card.answer`）。 */
export interface FeishuClickValue {
  card: string
  choice: number
}

/** 一个可点选项的按钮（Card 2.0：`behaviors[0].type='callback'` 才回调服务端）。 */
export interface FeishuOptionButton {
  tag: 'button'
  text: { tag: 'plain_text'; content: string }
  type: 'default'
  width: 'fill'
  behaviors: [{ type: 'callback'; value: FeishuClickValue }]
}

export type FeishuCardElement =
  { tag: 'markdown'; content: string } | { tag: 'hr' } | FeishuOptionButton

/** 渲染结果（Card 2.0 根结构）。 */
export interface FeishuCard {
  schema: '2.0'
  config: { update_multi: boolean; enable_forward: boolean }
  header: { title: { tag: 'plain_text'; content: string }; template: string }
  body: { elements: FeishuCardElement[] }
}

/** 一个选项按钮：回传值只含卡片 id 与下标，别的一律不带（答案由内核判定）。 */
export function optionButton(cardId: string, label: string, index: number): FeishuOptionButton {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: 'default',
    width: 'fill',
    behaviors: [{ type: 'callback', value: { card: cardId, choice: index } }],
  }
}

/** 答复来源的注释（M43）：谁在哪答的，读卡的人需要知道。 */
function answeredNote(card: Card): string {
  return card.answeredBy === 'ui' ? '（在工作台答复）' : ''
}

/** 已答 / 已关的结论文案：按钮消失，改写成一行可读的结论。 */
function outcomeText(card: Card): string {
  if (card.status === 'answered') {
    const chosen = card.options[card.optionIndex ?? -1] ?? '（选项已失效）'
    return `**已记录：${chosen}**${answeredNote(card)}`
  }
  return card.kind === 'notice' ? '**已处理**' : '**已关闭，不用再决定**'
}

/**
 * 卡片 → 飞书卡片 JSON（M43：一律按卡片**当前状态**渲染）。
 *
 * 通道不再自己记「我点了什么」：点完只回报答案，随后宿主把内核里的最新卡片行送回来，
 * 这里照它渲染。于是「在飞书答的」和「在工作台答的」在同一张卡上看起来一致。
 */
export function renderCard(card: Card): FeishuCard {
  const elements: FeishuCardElement[] = []
  const open = card.status === 'open'
  if (card.text.trim() !== '') elements.push({ tag: 'markdown', content: card.text })
  if (!open) {
    elements.push({ tag: 'hr' })
    elements.push({ tag: 'markdown', content: outcomeText(card) })
  } else if (card.kind === 'ask') {
    if (elements.length > 0) elements.push({ tag: 'hr' })
    card.options.forEach((label, index) => {
      elements.push(optionButton(card.id, label, index))
    })
  }
  return {
    schema: '2.0',
    // 同一个 message_id 上原地更新（`im messages patch`），转发与多端同步都由平台处理
    config: { update_multi: true, enable_forward: false },
    header: {
      title: { tag: 'plain_text', content: card.title },
      template: open
        ? card.kind === 'ask'
          ? FEISHU_CARD_TEMPLATES.ask
          : FEISHU_CARD_TEMPLATES.notice
        : card.status === 'answered'
          ? FEISHU_CARD_TEMPLATES.answered
          : FEISHU_CARD_TEMPLATES.resolved,
    },
    body: { elements },
  }
}
