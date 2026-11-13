/**
 * 阶段脚本的表单纯函数（M40）：默认值、多行文本 ↔ argv / 环境变量。
 *
 * 全部是纯函数（不依赖 React、不做 IO）：编辑器只把结果写回草稿，单测直接比对值。
 * 口径与协议层一致——argv 逐项一个元素、不经 shell；环境变量 `KEY=VALUE` 一行一个。
 */
import type { StageScript } from '../../../../../protocol/entities'

/**
 * 脚本超时的可选档位（毫秒）：脚本通常比智能体轮次短得多（跑门禁 / 构建），
 * 所以档位比阶段超时小一档；`timeoutMs` 恒为数字（缺省 10 分钟）。
 */
export const SCRIPT_TIMEOUT_CHOICES = [
  { value: String(5 * 60_000), label: '5 分钟' },
  { value: String(10 * 60_000), label: '10 分钟' },
  { value: String(30 * 60_000), label: '30 分钟' },
  { value: String(60 * 60_000), label: '60 分钟' },
] as const

/** 脚本缺省超时（毫秒）：表单里选「默认」时写进 `timeoutMs`，内核按它算 `deadlineAt`。 */
export const SCRIPT_DEFAULT_TIMEOUT_MS = 10 * 60_000

/** 新建脚本配置：一条空命令 + 空参数，连接取传入的运行时（通常是第一条命令执行器）。 */
export function defaultScript(runtimeId: string): StageScript {
  return {
    runtimeId,
    command: '',
    args: [],
    cwd: null,
    env: {},
    timeoutMs: SCRIPT_DEFAULT_TIMEOUT_MS,
  }
}

/** 参数文本 → argv：一行一项，去掉空行与首尾空白（项内空格保留）。 */
export function parseArgLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** argv → 参数文本：一行一项，便于编辑。 */
export function formatArgLines(args: readonly string[]): string {
  return args.join('\n')
}

/**
 * 环境变量文本 → 键值对象：一行一个 `KEY=VALUE`。
 *
 * 没有 `=` 的行、键名为空的行直接丢弃（内核只校验键名形状，界面上不该让人写出死行）；
 * 值里的 `=` 保留（`A=b=c` → `{A: 'b=c'}`）。
 */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    // 行已 trim，`=` 前面至少有一个非空白字符，键不可能为空
    const key = line.slice(0, at).trim()
    env[key] = line.slice(at + 1).trim()
  }
  return env
}

/** 键值对象 → 环境变量文本：按 `KEY=VALUE` 一行一个（键排序，编辑时稳定）。 */
export function formatEnvLines(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((key) => `${key}=${env[key]}`)
    .join('\n')
}
