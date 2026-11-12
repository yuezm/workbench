/**
 * 回执键的唯一真相源（M24）。
 *
 * 同一份事实原来写了三处：提示词文案（`kernel/prompt`）、解析器白名单
 * （`plugins/shared/receipt-block`）、协议校验（`protocol/validate` 的 `checkReceipt`）。
 * M14/M20/M21 加键时改了后两处、漏了解析器——提示词让模型写 `findings` /
 * `addresses` / `acceptance`，执行器却把整块判成「不是回执」，评审硬门与验收续评
 * 整条断路，而且不报错。
 *
 * 现在键集合、每键口径、形状示例、上限文案只在这里定义一次：
 * - `kernel/prompt` 按可用键生成提示词段落（不再手写文案）；
 * - `plugins/shared/receipt-block` 用 `RECEIPT_KEYS` 做解析白名单；
 * - 测试断言「文案 / 解析 / 校验」三处键集合逐键一致，漂移会直接红。
 *
 * 这里只描述契约，不描述阶段：哪些键在哪个阶段真的有出口，由
 * `kernel/prompt` 的 `taskReceiptKeys` 决定（非闸门阶段念 `verdict` 只是噪音）。
 */

/** 回执块可携带的键，也是解析白名单的顺序（与提示词展示顺序一致）。 */
export const RECEIPT_KEYS = [
  'ask',
  'notices',
  'resolves',
  'later',
  'events',
  'spawn',
  'notes',
  'verdict',
  'checks',
  'deliverables',
  'findings',
  'addresses',
  'acceptance',
] as const

export type ReceiptKey = (typeof RECEIPT_KEYS)[number]

/**
 * 单键说明：`text` 是一句口径（提示词里跟在键名后面），`shape` 是该键的 JSON 形状示例。
 *
 * 用 `Record<ReceiptKey, …>` 而不是数组：加键时类型检查强制补文案，
 * 少写一条就编译不过。
 */
export interface ReceiptKeyDoc {
  text: string
  shape: string
}

export const RECEIPT_KEY_DOCS: Record<ReceiptKey, ReceiptKeyDoc> = {
  ask: {
    text: '要人拍板。发出去即挂起等回答；一轮只发一张，同一决策的多个待定项写进 `text` 分行。',
    shape: '[{"title":"选一个","text":"用 A 还是 B？","options":["A","B"],"key":"plan"}]',
  },
  notices: {
    text: '不弹通知的知会。只写会改变判断的一句话，过程与待办写正文。',
    shape: '["已完成依赖安装"]',
  },
  resolves: {
    text: '关掉不再需要的旧卡片。填卡片 id。',
    shape: '["card-id"]',
  },
  later: {
    text: '约一个 ISO 8601 时刻再跑一轮。同块出现 `ask` / `notices` 时不生效。',
    shape: '"2026-11-06T09:00:00.000Z"',
  },
  events: {
    text: '派生事件。`source` / `type` / `subject` 必填，命中规则才建任务。',
    shape: '[{"source":"agent","type":"issues.opened","subject":"issue-1","summary":"发现新问题"}]',
  },
  spawn: {
    text: '派子任务。只写拆成哪件事，派给谁、放哪个目录由内核定。',
    shape: '[{"subject":"实现登录页","summary":"含表单与校验","stageId":"st-2","key":"login"}]',
  },
  notes: {
    text: '线程笔记。一条一句。',
    shape: '["先跑测试再提交"]',
  },
  verdict: {
    text: '闸门结论：`pass` 或 `fail`。与 `checks` 成对给；`fail` 要在正文写清哪条没过。',
    shape: '{"verdict":"pass","checks":[{"cmd":"pnpm check","exitCode":0}]}',
  },
  checks: {
    text: '闸门证据：实际执行过的命令与退出码，`verdict` 为 `pass` 时每条 `exitCode` 必须是 0。',
    shape: '[{"cmd":"pnpm check","exitCode":0}]',
  },
  deliverables: {
    text: '阶段交付物：交给下游的坐标（分支 / 基线 / 提交 / 文件 / 门禁）。没有产出的项省略或写 null，别把过程写进来。',
    shape:
      '{"branch":"feat/x","base":"develop","commits":["57be895"],"files":["src/a.ts"],"gates":[{"cmd":"pnpm check","exitCode":0}]}',
  },
  findings: {
    text: '评审待改项。`requiredAction` 写成「复跑什么、看到什么算修好」。',
    shape:
      '[{"key":"R1","severity":"blocker","location":"src/a.ts:42","claim":"...","requiredAction":"..."}]',
  },
  addresses: {
    text: '对上轮 `findings` 逐条回应。`fixed` 带 `checkRef`（指向同块里退出码 0 的 `checks`），`rejected` / `deferred` 写 `note`；漏回应的不推进下一阶段。',
    shape:
      '[{"findingId":"<报告id>#R1","disposition":"fixed","checkRef":"pnpm check","note":"..."}]',
  },
  acceptance: {
    text: '逐条自评本阶段「验收」。`no` = 验收段第几条（按出现顺序，从 1 数），配 `met` 与 `evidence`；缺项按未达。',
    shape: '[{"no":1,"met":true,"evidence":"pnpm check 退出码 0"}]',
  },
}

/** 条数与字长上限（一次说清，不散落在各键文案里）。 */
export const RECEIPT_LIMITS_LINE =
  '上限：`ask` / `notices` / `resolves` / `events` / `notes` 各 100 项，`findings` / `addresses` 各 200 项，`spawn` 32 项，`checks` 32 条，`deliverables` 的 `commits` 20 项 / `files` 40 项 / `gates` 32 条，`acceptance` 12 条，`options` 最多 20 项；`title` ≤200、`text` / `evidence` ≤2000、`summary` ≤200、`claim` / `requiredAction` / `note` ≤500、`key` ≤32 字。'

/**
 * 任何阶段都可能用到的出口（不含阶段专属的 `notes` / `verdict` / `checks` /
 * `findings` / `addresses` / `acceptance`）。
 */
export const BASE_RECEIPT_KEYS: readonly ReceiptKey[] = [
  'ask',
  'notices',
  'resolves',
  'later',
  'events',
  'spawn',
]

/**
 * 聊天轮的键：没有阶段、不挂线程，所以没有验收自评、闸门判定、评审回应与线程笔记。
 * 留全量只是噪音，还会诱导模型在没有出口的键上乱填。
 */
export const CHAT_RECEIPT_KEYS: readonly ReceiptKey[] = BASE_RECEIPT_KEYS
