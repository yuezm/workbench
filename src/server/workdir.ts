/**
 * 默认工作目录（宿主侧解析，装配根注入 `sdk.paths.cwd`）。
 *
 * 优先级：运行时表单里的 `workdir`（内核记进 `run.cwd`）> `WORKBENCH_WORKDIR` 环境变量 >
 * `~/.workbench`。解析结果是绝对路径，并在启动时确保目录存在——执行器拿到的 cwd
 * 必须可用，否则 `spawn` 直接 ENOENT。
 *
 * 为什么要有它：evaluator 里原本的兜底是主进程 `process.cwd()`，开发时恰好是仓库根，
 * 打包后却可能是安装目录或系统目录；agent 在这个目录里读写的代价太大。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'

/** 覆盖默认目录的环境变量名 */
export const WORKDIR_ENV = 'WORKBENCH_WORKDIR'
/** 未配置时的默认目录名（落在用户主目录下） */
export const DEFAULT_WORKDIR_NAME = '.workbench'

export interface WorkdirInput {
  /** 环境变量来源（生产传 `process.env`） */
  env: NodeJS.ProcessEnv
  /** 用户主目录（生产传 `app.getPath('home')`） */
  home: string
  /** 兜底目录：解析相对路径、以及建目录失败时使用 */
  fallback: string
}

/** 展开 `~` 前缀；`~user/` 这类形式不认（原样返回，交给 `path.resolve` 判相对）。 */
export function expandHome(raw: string, home: string): string {
  if (raw === '~') return home
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2))
  return raw
}

/**
 * 解析默认工作目录并确保它存在。
 *
 * 相对路径按 `fallback` 解析（与 `path.resolve` 一致）；目录建不出来时降级到
 * `fallback`，且把原因交给 `log`——宁可退化也不能让所有运行起不来。
 */
export function resolveWorkdir(
  input: WorkdirInput,
  log: (line: string) => void = () => {},
): string {
  const raw = (input.env[WORKDIR_ENV] ?? '').trim()
  const wanted =
    raw === '' ? path.join(input.home, DEFAULT_WORKDIR_NAME) : expandHome(raw, input.home)
  const resolved = path.resolve(input.fallback, wanted)
  try {
    mkdirSync(resolved, { recursive: true })
    return resolved
  } catch (error) {
    log(
      `默认工作目录不可用（${resolved}）：${error instanceof Error ? error.message : String(error)}；` +
        `退回 ${input.fallback}`,
    )
    return input.fallback
  }
}
