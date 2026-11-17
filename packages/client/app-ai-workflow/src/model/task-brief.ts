/**
 * 任务描述的字段化（M43）：把「描述」从一段自由文本变成按用途分组的字段。
 *
 * 为什么需要：`task.description` 进提示词时是紧跟 `# 任务：{title}` 的**裸段**
 * （`scopes/prompt.ts` 的 `taskPrompt`），AI 侧没有任何结构锚点。而字段是从
 * **阶段的「产出 / 边界」反推**出来的（见 `sop-templates.ts`），不是凭空加的：
 *
 * - 需求组对应「需求澄清」的产出（用户故事 / 验收标准）与「编码实现」的边界
 *   （不动需求澄清之外的模块）——「不做什么」缺位时 AI 必然顺带改无关文件；
 * - BUG 组对应「定位复现」的产出（复现步骤、期望 vs 实测）与「执行测试」的证据、
 *   「缺陷定级」的影响面——「期望行为」缺位时 AI 会把现状当成正确行为。
 *
 * 三条边界：
 *
 * 1. **不给独立的「验收标准」字段**：验收的唯一真相源是阶段的结构化 `acceptance`
 *    （M34，只挂闸门阶段）。任务层再写一份，AI 面对两套判据无法取舍。
 * 2. **序列化进 `description`，不动协议**：字段值的唯一消费方是提示词，一段带段头的
 *    文本已经够用；加真字段要动 protocol → facts → kernel → store → 详情页。
 * 3. **只能序列化、不回解析**：详情页照 Markdown 渲染，不把文本 parse 回字段——那就有
 *    了两套真相源。
 *
 * 段头层级：`prompt.ts` 定死「段用 `#`、段内小节用 `##`」，而 description 是跟随
 * `# 任务` 的一段，所以字段段头用 `###`；字段值里行首的 `#` 必须降级，否则用户能在
 * 描述里伪造出 `# 验收（判据，逐条核对）` 这类内核段——那是提示词注入的入口。
 */
import { COMMAND_LIMITS } from '@workbench/protocol/validate'

/** 描述填写方式：自由文本保持老行为，两个字段组按用途分组 */
export type BriefMode = 'free' | 'requirement' | 'bug'

/** 有字段的组（`free` 没有字段，走原来的单个文本域） */
export type BriefPresetId = Exclude<BriefMode, 'free'>

export interface BriefField {
  key: string
  label: string
  /** 常驻说明：填什么、什么算填好 */
  hint: string
  /** 建议补上：留空时给一行灰字提醒，但**不阻断提交** */
  recommended: boolean
  maxLength: number
}

/**
 * 字段组的定义。`label` 同时是序列化后的段头、`aria-label` 与界面小标签，
 * 一处定义三处使用，改文案不会漂。
 */
export const BRIEF_FIELDS: Readonly<Record<BriefPresetId, readonly BriefField[]>> = {
  requirement: [
    {
      key: 'need',
      label: '需求描述',
      hint: '一两句说清要做什么',
      recommended: true,
      maxLength: 400,
    },
    {
      key: 'goal',
      label: '目标',
      hint: '可观察的结果，不是动作',
      recommended: true,
      maxLength: 400,
    },
    {
      key: 'scope',
      label: '不做什么',
      hint: '明确排除的范围',
      recommended: true,
      maxLength: 400,
    },
    {
      key: 'refs',
      label: '参考',
      hint: '文件路径 / 链接 / 相关任务编号',
      recommended: false,
      maxLength: 400,
    },
  ],
  bug: [
    {
      key: 'symptom',
      label: '现象',
      hint: '现在实际发生了什么',
      recommended: true,
      maxLength: 300,
    },
    {
      key: 'expected',
      label: '期望行为',
      hint: '应该是什么样',
      recommended: true,
      maxLength: 300,
    },
    {
      key: 'steps',
      label: '复现步骤',
      hint: '1. … 2. … 3. …，能稳定复现',
      recommended: true,
      maxLength: 600,
    },
    {
      key: 'env',
      label: '环境',
      hint: '版本 / commit、操作系统、依赖',
      recommended: false,
      maxLength: 300,
    },
    {
      key: 'evidence',
      label: '证据',
      hint: '日志、报错堆栈、截图路径',
      recommended: false,
      maxLength: 400,
    },
    {
      key: 'impact',
      label: '影响面',
      hint: '影响范围与严重度',
      recommended: false,
      maxLength: 300,
    },
  ],
}

/** 界面上「填写方式」的三个选项（顺序即展示顺序，自由文本是默认项） */
export const BRIEF_MODES: readonly { value: BriefMode; label: string }[] = [
  { value: 'free', label: '自由文本' },
  { value: 'requirement', label: '需求' },
  { value: 'bug', label: 'BUG' },
]

/** 模式的展示名（提示文案里要念出组名） */
export const briefModeLabel = (mode: BriefMode): string =>
  BRIEF_MODES.find((option) => option.value === mode)?.label ?? mode

/** 描述总长上限与协议同口径（`COMMAND_LIMITS.description`），不是另立一套 */
export const BRIEF_TOTAL_LIMIT = COMMAND_LIMITS.description

/** 该模式的字段列表；`free` 没有字段 */
export const briefFields = (mode: BriefMode): readonly BriefField[] =>
  mode === 'free' ? [] : BRIEF_FIELDS[mode]

/**
 * 把字段值里的行首 `#` 降级成全角 `＃`。
 *
 * 只处理行首的连续 `#`：markdown 标题必须是行首，换掉就等于废掉「伪造内核段」的路；
 * 正文中间的 `#` 是正常内容（C#、issue 编号），原样保留。
 */
export function escapeHeadingLines(value: string): string {
  return value
    .split('\n')
    .map((line) =>
      line.replace(
        /^(\s*)(#+)/,
        (_match, space: string, hashes: string) => `${space}${'＃'.repeat(hashes.length)}`,
      ),
    )
    .join('\n')
}

/**
 * 字段值 → 描述正文：每个非空字段一段 `### 段头`，空字段**整段消失**（不留空标题）。
 * 全空时返回空串——描述保持「可选」，不因为切过一次组就凭空多出内容。
 */
export function serializeBrief(mode: BriefMode, values: Readonly<Record<string, string>>): string {
  const sections: string[] = []
  for (const field of briefFields(mode)) {
    const raw = (values[field.key] ?? '').trim()
    if (raw === '') continue
    sections.push(`### ${field.label}\n${escapeHeadingLines(raw)}`)
  }
  return sections.join('\n\n')
}

/** 序列化后的字符长度（按码点算，与协议上限同口径） */
export const briefLength = (text: string): number => Array.from(text).length

/** 超出总长上限多少字符；0 = 没超。超了宿主会整条拒绝，所以必须提交前挡住 */
export const briefOverflow = (text: string): number =>
  Math.max(0, briefLength(text) - BRIEF_TOTAL_LIMIT)

/** 还没填的建议字段（label 列表），用于那行「建议补上：…」的灰字 */
export function missingRecommended(
  mode: BriefMode,
  values: Readonly<Record<string, string>>,
): string[] {
  return briefFields(mode)
    .filter((field) => field.recommended && (values[field.key] ?? '').trim() === '')
    .map((field) => field.label)
}

/**
 * 按工作流 / 起始阶段的名字猜这条任务更像哪一组，好给一句「切过去按字段填」的建议。
 *
 * 只按名字判，**只用于提示、绝不自动切组**：猜错时最坏结果是多一行灰字，而不是
 * 用户填到一半发现字段被换掉。分不出倾向返回 `null`（不提示）。
 */
const BUG_HINTS = ['缺陷', '故障', 'bug', 'issue', '复现', '回归', '线上问题'] as const
const REQUIREMENT_HINTS = ['需求', '交付', '研发', '产品', '方案', '立项', '功能'] as const

const hits = (text: string, hints: readonly string[]): number =>
  hints.reduce((sum, hint) => (text.includes(hint) ? sum + 1 : sum), 0)

export function suggestBriefMode(input: {
  workflowName: string
  stageName: string
}): BriefPresetId | null {
  const text = `${input.workflowName} ${input.stageName}`.toLowerCase()
  const bug = hits(text, BUG_HINTS)
  const requirement = hits(text, REQUIREMENT_HINTS)
  if (bug > requirement) return 'bug'
  if (requirement > bug) return 'requirement'
  return null
}
