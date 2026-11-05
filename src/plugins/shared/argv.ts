/**
 * 参数模板（argv）纯函数，`command` 执行器与运行时表单共用。
 *
 * 只做字符串处理：不读时钟、不碰文件/网络、不 import node/host。
 * 模板是 JSON 数组文本，**每项仍是一个独立 argv 元素**——展开只替换项内的占位符，
 * 不拆分、不拼接，因此提示词永远不会变成命令行字符串的一部分。
 *
 * 错误语义（便于执行器捕获）：`parseArgsTemplate` 对非法输入**抛可读 Error**，
 * 消息以 `argsTemplate` 开头；空串/纯空白按「无参数」返回 `[]`（NULL/空 = 无参数）。
 */
import { ARGV_PLACEHOLDERS, type ArgvPlaceholder } from '../../protocol/entities'

/** 展开用的变量：键与协议层白名单同源，缺失值由调用方折成空串 */
export type ArgvVars = Record<ArgvPlaceholder, string>

/** 占位符匹配：只认白名单里的名字，未知占位符原样保留（由 IPC/协议层负责拒绝） */
const PLACEHOLDER_RE = new RegExp(`\\{(${ARGV_PLACEHOLDERS.join('|')})\\}`, 'g')

/**
 * 解析参数模板：空串/纯空白 → `[]`；非法 JSON、非字符串数组 → 抛 Error。
 * 不做项数/长度/占位符校验（那是 `protocol/validate.ts` 的职责，插件只防御非法 JSON）。
 */
export function parseArgsTemplate(text: string): string[] {
  if (text.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('argsTemplate 不是合法的 JSON 文本')
  }
  if (!Array.isArray(parsed)) throw new Error('argsTemplate 必须是 JSON 字符串数组')
  for (const [index, item] of parsed.entries()) {
    if (typeof item !== 'string') {
      throw new Error(`argsTemplate[${index}] 必须是字符串`)
    }
  }
  return parsed as string[]
}

export interface ExpandedArgs {
  /** 展开后的 argv：项数与模板一致，每项仍是一个元素 */
  args: string[]
  /** 模板里出现 `{prompt}`：提示词已是 argv 元素，不应再写 stdin */
  promptInArgs: boolean
}

/**
 * 逐项替换 `{model}/{effort}/{cwd}/{context}/{prompt}`。
 *
 * 替换用函数回调，变量值里的 `$&` 之类不会被当作替换模式二次解释。
 * `promptInArgs` 只看模板是否含 `{prompt}`（恰好等于或包含都算）。
 */
export function expandArgs(items: readonly string[], vars: ArgvVars): ExpandedArgs {
  const promptInArgs = items.some((item) => item.includes('{prompt}'))
  const args = items.map((item) =>
    item.replace(PLACEHOLDER_RE, (_match, name: string) => vars[name as ArgvPlaceholder]),
  )
  return { args, promptInArgs }
}
