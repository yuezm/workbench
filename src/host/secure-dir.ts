/**
 * 数据目录收紧（M36-H）：把 `userData` 从「谁都能读」收到「只有本账号与 SYSTEM」。
 *
 * 目标不是沙箱：同一系统账号下的进程照样能读（见 SPEC-host「安全边界」）。能挡的是
 * 其它系统账号，以及外部工具（例如 Codex 的 Windows 沙箱给用户目录加出来的读权限）。
 *
 * 故意做得「失败不阻断」：改不了 ACL 时记一条日志继续启动——数据可读比「因为权限
 * 收紧失败而打不开应用」更可接受；真正的隔离靠独立账号或容器。
 *
 * 全部外部能力注入（platform / chmod / exec / 日志），因此可在 node 环境单测，
 * 不需要真 Electron 或真 ACL。
 */
import { chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export interface SecureDirDeps {
  platform: NodeJS.Platform
  /** Windows：要授予完全控制权的账号名（取 `USERNAME`；空则跳过） */
  userName: string
  chmodSync(path: string, mode: number): void
  execFileSync(file: string, args: readonly string[]): void
  log(line: string): void
}

export interface SecureDirResult {
  hardened: boolean
  /** 失败原因（给人看）；成功为 null */
  error: string | null
}

const WIN_ACL = (userName: string): string[] => [
  '/inheritance:r',
  '/grant:r',
  `${userName}:(OI)(CI)F`,
  '/grant',
  'SYSTEM:(OI)(CI)F',
]

/**
 * 收紧一个目录（不递归现有子项：`(OI)(CI)` 让新文件继承，旧文件的主体会随下次写入更新；
 * 递归 `icacls /T` 在 node_modules 级别的目录上要几十秒，不值得放在启动路径上）。
 */
export function secureDataDir(
  dir: string,
  overrides: Partial<SecureDirDeps> = {},
): SecureDirResult {
  const deps: SecureDirDeps = {
    platform: process.platform,
    userName: process.env['USERNAME'] ?? process.env['USER'] ?? '',
    chmodSync: (path, mode) => chmodSync(path, mode),
    execFileSync: (file, args) => {
      execFileSync(file, [...args], { stdio: 'ignore' })
    },
    log: (line) => process.stderr.write(`${line}\n`),
    ...overrides,
  }

  try {
    if (deps.platform === 'win32') {
      if (deps.userName === '') {
        deps.log('[secure-dir] 数据目录收紧失败：拿不到当前账号名（USERNAME 为空），已跳过')
        return { hardened: false, error: 'USERNAME 为空' }
      }
      deps.execFileSync('icacls', [dir, ...WIN_ACL(deps.userName)])
      return { hardened: true, error: null }
    }
    deps.chmodSync(dir, 0o700)
    return { hardened: true, error: null }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    deps.log(`[secure-dir] 数据目录收紧失败（已忽略，不影响启动）：${message}`)
    return { hardened: false, error: message }
  }
}
