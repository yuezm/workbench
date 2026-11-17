/**
 * 阶段脚本的表单纯函数（M40 / M42）：默认值、多行文本 ↔ **步骤** / 环境变量。
 *
 * 全部是纯函数（不依赖 React、不做 IO）：编辑器只把结果写回草稿，单测直接比对值。
 * 口径与协议层一致——每步一项 argv、不经 shell；环境变量 `KEY=VALUE` 一行一个。
 */
import type { ScriptStep, StageScript } from '@workbench/protocol/entities'

/**
 * 脚本超时的可选档位（毫秒）：脚本通常比智能体轮次短得多（跑门禁 / 构建），
 * 所以档位比阶段超时小一档；`timeoutMs` 恒为数字（缺省 10 分钟，**整轮预算**，所有步骤共用）。
 */
export const SCRIPT_TIMEOUT_CHOICES = [
  { value: String(5 * 60_000), label: '5 分钟' },
  { value: String(10 * 60_000), label: '10 分钟' },
  { value: String(30 * 60_000), label: '30 分钟' },
  { value: String(60 * 60_000), label: '60 分钟' },
] as const

/** 脚本缺省超时（毫秒）：表单里选「默认」时写进 `timeoutMs`，内核按它算 `deadlineAt`。 */
export const SCRIPT_DEFAULT_TIMEOUT_MS = 10 * 60_000

/**
 * 步骤上限（与协议 `SCRIPT_LIMITS.maxSteps` 同口径，界面只做提示）。
 * 放在这里而不是从协议导入，是因为表单要自己判断「还能不能再加一步」。
 */
export const SCRIPT_MAX_STEPS = 8

/** 新建脚本配置：一步空参数 + 默认超时，连接取传入的运行时（通常是第一条命令执行器）。 */
export function defaultScript(runtimeId: string): StageScript {
  return {
    runtimeId,
    steps: [{ label: '', args: [] }],
    cwd: null,
    env: {},
    timeoutMs: SCRIPT_DEFAULT_TIMEOUT_MS,
    runAll: true,
  }
}

/** 新建一步：空标签 + 空参数（验收序号由人挑，默认不挂钩）。 */
export function emptyStep(): ScriptStep {
  return { label: '', args: [] }
}

/**
 * 只保留当前契约里的字段（老数据 / 外部写入里残留的 `command`、`args` 在这里脱落）。
 *
 * 命令以运行时为准，阶段上留着一条看不见也改不动的命令就是第二份真相源；
 * 编辑器每次保存都过一遍这里，脏键随保存清掉。
 */
export function cleanScript(script: StageScript | null | undefined): StageScript | null {
  if (!script) return null
  const legacy = script as StageScript & { args?: readonly string[] }
  // 老形状（一条 args）在界面上也按「一步」呈现：保存时就地升级成 steps
  const steps =
    legacy.steps ??
    (legacy.args === undefined ? [emptyStep()] : [{ label: '', args: [...legacy.args] }])
  return {
    runtimeId: script.runtimeId,
    steps: steps.map((step) => ({
      label: step.label ?? '',
      args: [...(step.args ?? [])],
      ...(step.acceptance === undefined ? {} : { acceptance: step.acceptance }),
    })),
    cwd: script.cwd ?? null,
    env: { ...(script.env ?? {}) },
    timeoutMs: script.timeoutMs ?? null,
    runAll: script.runAll ?? true,
  }
}

/**
 * 改脚本配置：有脚本就浅合并，没有就按默认配置补一份再合并。
 *
 * 「没有脚本」这条守卫界面走不到（脚本块只在 `stage.script` 非空时渲染），抽成纯函数
 * 是为了让它能被单测直接覆盖——顺手也让调用点少一个 `if (!current) return` 的空转分支。
 */
export function applyScriptPatch(
  script: StageScript | null | undefined,
  patch: Partial<StageScript>,
): StageScript {
  if (!script) return { ...defaultScript(''), ...patch }
  return { ...script, ...patch }
}

/**
 * 改其中一步：按位置浅合并；位置越界原样返回（不造半截步骤）。
 *
 * 与 `applyScriptPatch` 同一模式：抽出来让「加 / 删 / 改步骤」三个操作都能单测。
 */
export function patchStep(
  steps: readonly ScriptStep[],
  index: number,
  patch: Partial<ScriptStep>,
): ScriptStep[] {
  if (index < 0 || index >= steps.length) return [...steps]
  return steps.map((step, at) => (at === index ? { ...step, ...patch } : step))
}

/** 追加一步；已到上限时原样返回（超限由协议层兜底，界面不让人写出存不下去的配置）。 */
export function addStep(steps: readonly ScriptStep[]): ScriptStep[] {
  return steps.length >= SCRIPT_MAX_STEPS ? [...steps] : [...steps, emptyStep()]
}

/** 删掉第 N 步；只剩一步时不动（脚本至少要跑一步）。 */
export function removeStep(steps: readonly ScriptStep[], index: number): ScriptStep[] {
  if (steps.length <= 1 || index < 0 || index >= steps.length) return [...steps]
  return steps.filter((_, at) => at !== index)
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
