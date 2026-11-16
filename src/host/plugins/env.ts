/**
 * 外部插件子进程环境（M7 D2）：**白名单**构造，不继承 `process.env` 的其它键。
 *
 * 为什么白名单而不是黑名单：外部插件是用户目录里的第三方代码，宿主无法枚举「敏感变量」
 * 的完整集合（各种 token、代理凭据、私有 registry）。只给运行 Node 所需的最小集合，
 * 泄漏面才是可审计的；secret 不走环境变量，只经 `welcome` 帧下发。
 *
 * 口径：
 * - 固定白名单 + `LC_*` 前缀（本地化变量）；
 * - 子进程就是本机 node（服务端进程本身是 node，`process.execPath` 即 node），
 *   不需要再借 `ELECTRON_RUN_AS_NODE` 把桌面二进制退化成 Node；
 * - `overrides` 最后合并（宿主显式覆盖，例如测试注入精简环境）。
 */
/** 允许继承的环境变量（大小写不敏感匹配，输出保留原键名）。 */
export const PLUGIN_ENV_ALLOWLIST = [
  'PATH',
  'SystemRoot',
  'SystemDrive',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOME',
  'SHELL',
  'LANG',
] as const

/** 允许继承的前缀（`LC_*`：语言/区域设置）。 */
export const PLUGIN_ENV_PREFIXES = ['LC_'] as const

const allowlistKeys = new Set(PLUGIN_ENV_ALLOWLIST.map((key) => key.toUpperCase()))

const isAllowed = (key: string): boolean => {
  const upper = key.toUpperCase()
  if (allowlistKeys.has(upper)) return true
  return PLUGIN_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()))
}

/**
 * 构造插件子进程环境。
 *
 * @param overrides 宿主显式覆盖项（最后合并，可覆盖白名单值）
 * @param source 被过滤的源环境（默认 `process.env`；测试传假环境，避免 stub 全局）
 */
export function buildPluginEnv(
  overrides: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !isAllowed(key)) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    env[key] = value
  }
  return env
}
