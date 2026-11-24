// base-ref.mjs — 门禁脚本共用的 diff 基线解析（floor-guard / check-secrets / check-diff-coverage）。
//
// 为什么需要它：三个脚本原先各自写死一个分支名（两个 `master`、一个 `main`）。仓库的活跃分支是
// `main`，`master` 停在 2026-11-12 就没再动过，于是 `merge-base` 退到一个月的旧提交，diff 范围
// 把期间**已经推送过**的历史全算进来——pre-push 时把早已上线的删除（`tests/kernel/cards.test.ts`，
// 提交 d5a94be）当成本次放松报红，真正的新增放松被埋在噪音里。基线该跟着仓库实际默认分支走，
// 不该写死名字。
//
// 解析顺序：
//   1. `--base <ref>`            显式指定，最可控
//   2. `CONSTRAINTS_BASE`        环境变量写法
//   3. `origin/HEAD`             远端默认分支（`git remote set-head origin -a` 维护，改名自动跟）
//   4. 常见分支探测              origin/main → origin/master → main → master
// 全都不成立返回 null，由调用方按「无法运行」处理（exit 2），不放行。
import { execFileSync } from 'node:child_process'

const git = (args) => {
  try {
    return (
      execFileSync('git', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1024 * 1024,
      }).trim() || null
    )
  } catch {
    return null
  }
}

const exists = (ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null

/** 候选分支：按「远端跟踪分支优先」排序，本地分支名只作最后兜底 */
const CANDIDATES = ['origin/main', 'origin/master', 'main', 'master']

/**
 * @param {string[]} [argv] 用于读 `--base`，默认 `process.argv`
 * @returns {{ ref: string, source: string } | null}
 */
export const resolveBase = (argv = process.argv) => {
  const i = argv.indexOf('--base')
  if (i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
    return { ref: argv[i + 1], source: '--base' }
  }
  if (process.env.CONSTRAINTS_BASE) {
    return { ref: process.env.CONSTRAINTS_BASE, source: 'CONSTRAINTS_BASE' }
  }
  const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (head !== null && exists(head)) return { ref: head, source: 'origin/HEAD' }
  for (const ref of CANDIDATES) {
    if (exists(ref)) return { ref, source: 'probe' }
  }
  return null
}

/** 解析失败时的统一文案 */
export const BASE_MISSING_HINT =
  '无法确定 diff 基线：传 --base <ref>、设 CONSTRAINTS_BASE，或先 `git fetch origin` 并 `git remote set-head origin -a`'
