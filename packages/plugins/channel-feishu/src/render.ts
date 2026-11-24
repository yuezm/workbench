/**
 * 飞书卡片渲染（`src/plugins/channels/feishu/render.ts`）：纯函数，不碰 IO。
 *
 * 卡片正文是智能体写的文字，**只作卡片 JSON 的字段值**（不拼命令行 / 不拼模板字符串）：
 * 这里产出的对象由调用方 `JSON.stringify` 后整串作为 `lark-cli --content` 的参数。
 *
 * 结构（Card 2.0，见 lark-im `card/lark-im-card-create.md`）：
 * - `header` 承载标题与状态色：待答 `blue`、只知会 / 已关闭 `grey`、已答复 `green`；
 * - `body` 第一块是**上下文**（M54：项目 / 任务 / 会话 / 阶段 / 智能体）——标题是智能体写的
 *   自由文本，只看到「覆盖率棘轮红：打回补测还是接受现状？」的人既不知道这是哪个项目，
 *   也不知道该不该答；宿主给的上下文就摆在这里，读不到（null）就整块不出现；
 * - 其下是正文；`ask` 卡在 open 时按选项竖排一列按钮，答完 / 关闭后
 *   **按钮消失、换成结论**——按钮留在旧卡上等于允许重复作答（内核也会拒，但看着像没反应）；
 * - 选项按钮是等价选择（没有「主操作」），一律 `default` + 撑满，长文案换行而不截断。
 */
import type { CardContext } from '@workbench/protocol/channels'
import type { Card } from '@workbench/protocol/entities'

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

/**
 * 卡片上下文的文字行（M54）：第一行「项目 / 任务 / 会话」，第二行「阶段 / 智能体」。
 *
 * 只摆有值的那几项：缺的项不占位（`项目 ` 这种半截标签比没有更糟），整行都没有就不出现。
 * 这里不做判定——谁该答仍看连接配置的名单，`CardContext` 只用于展示。
 */
export function contextLines(context: CardContext | null): string[] {
  if (context === null) return []
  const rows: [string, string | null][][] = [
    [
      ['项目', context.projectName],
      ['任务', context.taskTitle],
      ['会话', context.conversationTitle],
    ],
    [
      ['阶段', context.stageName],
      ['智能体', context.agentName],
    ],
  ]
  return rows
    .map((row) =>
      row
        .filter(([, value]) => (value ?? '').trim() !== '')
        .map(([label, value]) => `${label} ${(value as string).trim()}`)
        .join(' · '),
    )
    .filter((line) => line !== '')
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
 * 卡片 → 飞书卡片 JSON（M43：一律按卡片**当前状态**渲染；M54：带上归属上下文）。
 *
 * 通道不再自己记「我点了什么」：点完只回报答案，随后宿主把内核里的最新卡片行送回来，
 * 这里照它渲染。于是「在飞书答的」和「在工作台答的」在同一张卡上看起来一致。
 *
 * `context` 由宿主给（`host/card-context.ts`）：读不到是 null，此时卡片与改动前完全一样。
 */
export function renderCard(card: Card, context: CardContext | null = null): FeishuCard {
  const elements: FeishuCardElement[] = []
  const open = card.status === 'open'
  const lines = contextLines(context)
  if (lines.length > 0) elements.push({ tag: 'markdown', content: lines.join('\n') })
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
