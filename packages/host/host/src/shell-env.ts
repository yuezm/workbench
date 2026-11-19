/**
 * 子进程环境基线（跨平台）：构造 / 归一 / 校验。
 *
 * ## 为什么需要这一层
 *
 * `SpawnOptions.env` 的语义是「给值即整体替换」。执行器四家都按「只加几个自己的键」
 * 传 `env`（`dshEnv` 只返回 `DSH_PERMISSION_MODE` 加会话根），于是宿主环境被整块丢掉。
 * Windows 上 libuv 会给子进程补 `PATH` / `SystemRoot` 等少数「必需变量」，
 * **但补不到 `PATHEXT`** —— 子进程里的 pwsh 于是无法把 `git` 解析成 `git.exe`，
 * 模型只能一条条命令手写 `$env:PATHEXT=…` 绕过去（实测一次任务为此烧掉 20 多条命令）。
 *
 * 所以「继承宿主环境再叠加」必须是一个**显式语义**（`envMode: 'inherit'`），
 * 并由这一层保证三件事：
 *
 * 1. 必需键一定在场（缺席就看得出是缺陷，而不是让它变成运行期的玄学失败）；
 * 2. 路径变量归一（去空段 / 去相对段 / 保序去重）——重复段是「反复追加 PATH」的征兆，
 *    留着只会让每次 spawn 都把上一轮的长度再叠一遍；
 * 3. 平台差异集中在一处（`;` vs `:`、`PATHEXT`、Windows 键名大小写），
 *    生产用 `process.platform`，测试直接传入三个平台跑同一套断言。
 *
 * ## Windows 的坑：`Path` 不是 `PATH`
 *
 * Windows 上 `process.env` 的键名是 `Path`（不是 `PATH`），而 `{...process.env}` 展开成
 * 普通对象后**大小写敏感**：`spread.PATH` 是 `undefined`。所以取值/写回一律走
 * `envKeyOf()` 做大小写不敏感查找，保留原键名，避免 `Path` 与 `PATH` 并存。
 */
import type { EnvPatch } from '@workbench/capabilities/types'

/** 生产与测试共同支持的目标平台（未知平台按 POSIX 处理）。 */
export type ShellPlatform = 'win32' | 'darwin' | 'linux'

/** 路径类变量：值里是「分隔符连起来的一组目录」。 */
const PATH_KEYS: Record<ShellPlatform, readonly string[]> = {
  win32: ['PATH', 'PATHEXT'],
  darwin: ['PATH'],
  linux: ['PATH'],
}

/**
 * 必需键：缺任何一个，子进程都会有「看起来像业务失败」的故障。
 *
 * 只收「缺了就真的跑不起来」的键：`LANG` / `TMPDIR` / `SHELL` 缺失只影响本地化与偏好，
 * 放进必需集会把这层变成噪声源（容器 CI 里几乎都没有 `LANG`）。
 */
const REQUIRED: Record<ShellPlatform, readonly string[]> = {
  win32: ['PATH', 'PATHEXT', 'SystemRoot', 'COMSPEC', 'TEMP', 'USERPROFILE'],
  darwin: ['PATH', 'HOME'],
  linux: ['PATH', 'HOME'],
}

/** `PATHEXT` 缺失时的标准值（与 Windows 默认一致；libuv 不会替我们补）。 */
export const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL'

/** 环境校验结论（只读报告，不抛错：调用方决定是日志、失败还是忽略）。 */
export interface EnvReport {
  ok: boolean
  platform: ShellPlatform
  /** 缺失或被清空的必需键（原样键名，未按平台归一） */
  missing: string[]
  /** `PATH` 里重复出现的段（重复 = 有人在反复追加） */
  pathDuplicates: string[]
  /** `PATH` 归一后的段数（0 表示 PATH 本身缺失） */
  pathSegments: number
}

/** `process.platform` → 三档平台；未知平台按 POSIX 处理（`;` 与 `PATHEXT` 都不是它的概念）。 */
export function shellPlatformOf(platform: string): ShellPlatform {
  if (platform === 'win32') return 'win32'
  if (platform === 'darwin') return 'darwin'
  return 'linux'
}

/** 环境里的路径分隔符。 */
export function pathSeparatorOf(platform: ShellPlatform): ';' | ':' {
  return platform === 'win32' ? ';' : ':'
}

/**
 * 大小写不敏感地找键：返回环境里**实际存在的那个键名**，找不到返回 null。
 *
 * POSIX 大小写敏感，只认精确键；Windows 上 `Path` / `PATH` 是同一个变量，
 * 不归一就会出现「看起来设了、取出来是空」的双键。
 */
function envKeyOf(env: NodeJS.ProcessEnv, wanted: string, platform: ShellPlatform): string | null {
  if (platform !== 'win32') {
    return Object.prototype.hasOwnProperty.call(env, wanted) ? wanted : null
  }
  const upper = wanted.toUpperCase()
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) return key
  }
  return null
}

/** 读环境值（含平台键名归一）；空串等同于没有。 */
export function envValue(
  env: NodeJS.ProcessEnv,
  wanted: string,
  platform: ShellPlatform = shellPlatformOf(process.platform),
): string | undefined {
  const key = envKeyOf(env, wanted, platform)
  const value = key === null ? undefined : env[key]
  return value === undefined || value === '' ? undefined : value
}

/** 写环境值：优先写回已存在的原键名（Windows 上不制造 `PATH` 副本）。 */
export function setEnvValue(
  env: NodeJS.ProcessEnv,
  wanted: string,
  value: string,
  platform: ShellPlatform = shellPlatformOf(process.platform),
): void {
  env[envKeyOf(env, wanted, platform) ?? wanted] = value
}

/** Windows 段尾的反斜杠归一，但保留盘符根（`C:\` 不能变成 `C:`——那是相对路径）。 */
function stripTrailingSeparator(segment: string): string {
  if (/^[A-Za-z]:[\\/]$/u.test(segment)) return `${segment.slice(0, 2)}\\`
  return segment.replace(/[\\/]+$/u, '')
}

/**
 * 路径变量归一：去引号、去空段、去相对段、保序去重。
 *
 * 只做「无信息损失」的处理：顺序不动（PATH 的先后决定解析结果），
 * 大小写去重只在 Windows 上做（POSIX 下 `/Bin` 与 `/bin` 是两个目录）。
 */
export function normalizePath(value: string, platform: ShellPlatform): string {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const raw of value.split(pathSeparatorOf(platform))) {
    const unquoted = raw
      .trim()
      .replace(/^"(.*)"$/u, '$1')
      .trim()
    if (unquoted === '' || unquoted === '.') continue
    const segment = platform === 'win32' ? stripTrailingSeparator(unquoted) : unquoted
    const dedupeKey = platform === 'win32' ? segment.toLowerCase() : segment
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    kept.push(segment)
  }
  return kept.join(pathSeparatorOf(platform))
}

/**
 * 构造子进程环境：`base` 为底 → 叠加 `patch` → 补齐必需键 → 归一路径变量。
 *
 * `base` 通常是宿主 `process.env`；`patch` 是调用方的增量（执行器的 `DSH_*`、智能体
 * 配置的变量）。补齐只在「缺或空」时发生：调用方显式给了值就以调用方为准。
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  patch: NodeJS.ProcessEnv = {},
  rawPlatform: string = process.platform,
): NodeJS.ProcessEnv {
  const platform = shellPlatformOf(rawPlatform)
  const env: NodeJS.ProcessEnv = { ...base, ...patch }

  for (const key of REQUIRED[platform]) {
    if (envValue(env, key, platform) !== undefined) continue
    const inherited = envValue(base, key, platform)
    if (inherited !== undefined) setEnvValue(env, key, inherited, platform)
  }

  // Windows 上没有 PATHEXT 等于命令解析全线失效；补标准值而不是留空
  if (platform === 'win32' && envValue(env, 'PATHEXT', platform) === undefined) {
    setEnvValue(env, 'PATHEXT', WINDOWS_DEFAULT_PATHEXT, platform)
  }

  for (const key of PATH_KEYS[platform]) {
    const value = envValue(env, key, platform)
    if (value !== undefined) setEnvValue(env, key, normalizePath(value, platform), platform)
  }
  return env
}

/** 在 `base` 上按 `EnvPatch` 增删（键名按平台归一：Windows 上删 `PATH` 等于删 `Path`）。 */
export function applyEnvPatchOn(
  base: NodeJS.ProcessEnv,
  patch: EnvPatch,
  rawPlatform: string = process.platform,
): NodeJS.ProcessEnv {
  const platform = shellPlatformOf(rawPlatform)
  const merged: NodeJS.ProcessEnv = { ...base }
  for (const wanted of patch.unset ?? []) {
    const key = envKeyOf(merged, wanted, platform)
    if (key !== null) delete merged[key]
  }
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    setEnvValue(merged, key, value, platform)
  }
  return merged
}

/**
 * 校验一份环境是否满足「子进程能正常解析命令」的最低要求。
 *
 * 只读、不抛错：启动自检与探针都调它，判定与呈现分开。
 * `ok` 只看必需键是否齐全 —— 重复段会让 PATH 变长但不会让解析失败，只报告不判死。
 */
export function verifyEnv(
  env: NodeJS.ProcessEnv,
  rawPlatform: string = process.platform,
): EnvReport {
  const platform = shellPlatformOf(rawPlatform)
  const missing = REQUIRED[platform].filter((key) => envValue(env, key, platform) === undefined)
  const rawPath = envValue(env, 'PATH', platform) ?? ''
  const separator = pathSeparatorOf(platform)
  const segments = rawPath.split(separator).filter((segment) => segment !== '')
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const segment of segments) {
    const key = platform === 'win32' ? segment.toLowerCase() : segment
    if (seen.has(key)) duplicates.push(segment)
    else seen.add(key)
  }
  return {
    ok: missing.length === 0,
    platform,
    missing,
    pathDuplicates: duplicates,
    pathSegments: seen.size,
  }
}
