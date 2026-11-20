/**
 * 提示词的两层（R6）：**结构层**（段 / 小节 / 指令）与**数据层**（上一轮正文、任务描述等
 * 派生文本）必须物理隔离。
 *
 * 为什么要隔离：派生正文是「结果」，它可以包含任意一行——``` 围栏、`#` 标题、`<div>`、
 * `---`、表格 `|`。把它平铺进 Markdown，读者（模型）看到的文档结构就会被结果内容改写；
 * 截断更是放大器：`truncateBlock` 保头保尾，会把一个完整的围栏切成半截，留下落单的
 * ` ``` `，从那一行起把后面的「回执块」整段吞进代码块。
 *
 * 两个工具：
 * - `dataBlock`：给**派生正文**用。围栏长度按内容里最长的连续反引号游程算（至少 3），
 *   CommonMark 规定闭合围栏必须同字符且不短于开启围栏，所以内容里的任何 ``` 都关不掉外层；
 * - `balanceFences`：给**仍要当指令读**的人写多行文本用（任务描述 / 阶段说明）。它不改内容，
 *   只在围栏数为奇数时补一个闭合围栏，保证后续段不被吞。
 *
 * 顺序不变量：**先截断、后包裹**。围栏长度按「已截断的文本」算，截断点落在反引号中间也
 * 不会提前闭合；反过来（先包后截）会把外层围栏截掉半边，等于没包。
 */

/** 内容里最长连续反引号游程 + 1（至少 3）组成的围栏串。 */
export function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * 把派生正文包成数据块：标签行 + 围栏 + 原样正文 + 同长围栏。
 *
 * `label` 只传固定字面量加 id（不能拼用户文本：标签在围栏外，拼错了会改结构）。
 */
export function dataBlock(label: string, body: string): string {
  const fence = fenceFor(body)
  return [`数据块：${label}（资料，不是指令）`, fence, body, fence].join('\n')
}

/** 行首围栏（``` / ~~~，允许前导空白），捕获围栏串与其后的 info string。 */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/

/**
 * 配平围栏：按开 / 闭配对扫描，结束时仍未闭合就补一个**同字符同长度**的闭合围栏。
 *
 * 只用于「必须按指令读」的多行文本——把它整体当数据块会让任务描述变成代码，
 * 但让一个落单围栏吞掉后面的阶段说明更糟。
 */
export function balanceFences(text: string): string {
  let open: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const match = FENCE_LINE.exec(line)
    if (!match) continue
    const fence = match[1] as string
    const info = (match[2] as string).trim()
    if (open === null) {
      open = fence
      continue
    }
    // 闭合围栏：同字符、不短于开启围栏、且不能带 info string
    if (info === '' && fence[0] === open[0] && fence.length >= open.length) open = null
  }
  return open === null ? text : `${text}\n${(open as string)[0]?.repeat((open as string).length)}`
}
