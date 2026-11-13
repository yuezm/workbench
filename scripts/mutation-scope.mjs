#!/usr/bin/env node
// mutation-scope.mjs — 圈定变异测试的范围。
//
// 三种范围，按用途分层：
//   1) 改动圈定（MR 门禁层）：只变异「本次改动碰过的模块」，成本 ∝ 改动量；
//   2) 定点复核（迭代层）：显式指定文件；
//   3) 全量扫描（定期层）：--scan，跑一遍内核 + 校验层，拿总分看是否整体退化。
//
// 用法：
//   node scripts/mutation-scope.mjs                     # 工作区改动（已改 + 已暂存 + 未跟踪）
//   node scripts/mutation-scope.mjs <文件>...            # 显式指定文件
//   node scripts/mutation-scope.mjs --scan               # 全量扫描清单
//   node scripts/mutation-scope.mjs --incremental        # 命中增量缓存
//   node scripts/mutation-scope.mjs --base <ref>         # 以 <ref> 为基准算改动（CI 里用这个）
//   MUTATION_BASE=origin/main node scripts/mutation-scope.mjs   # 同上（环境变量写法）
//
// 基准解析顺序：--base → MUTATION_BASE → CI 平台变量（GitLab CI_MERGE_REQUEST_DIFF_BASE_SHA /
// CI_COMMIT_BEFORE_SHA，GitHub GITHUB_BASE_REF）→ 本地工作区。
// CI 里解析不到基准时**直接失败**（exit 2）：范围算不出来就不能放行，否则门禁就是假绿。
//
// 退出码：0 = 无需变异 / 变异测试通过；1 = 变异测试未过阈值或执行失败；2 = 范围不可知。
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SCAN_ROOTS = ['src/kernel', 'src/protocol']
// 纯类型 / 纯常量 / 纯路由：没有运行时分支，变异只会产出噪音
const SCAN_EXCLUDE = [
  'src/kernel/types.ts', // 类型定义
  'src/kernel/decide.ts', // 纯命令路由（规则都在 commands/*）
  'src/kernel/view-spec.ts', // 纯查表
  'src/protocol/entities.ts', // 类型定义
  'src/protocol/facts.ts', // 类型 + 常量
  'src/protocol/commands.ts', // 命令契约
  'src/protocol/inputs.ts',
  'src/protocol/ipc.ts',
  'src/protocol/views.ts',
  'src/protocol/plugins.ts',
  'src/protocol/rules.ts',
  'src/protocol/review.ts',
  'src/protocol/thread.ts',
  'src/protocol/task-comment.ts',
  'src/protocol/receipt-keys.ts',
  'src/protocol/channels.ts',
  'src/protocol/manifest.ts',
  'src/protocol/executor.ts',
  'src/protocol/worker.ts',
  'src/protocol/model-id.ts',
  'src/protocol/plugin-host.ts', // 插件宿主契约校验（IO 边界，mock 会吸收变异）
]

const cliArgs = process.argv.slice(2)
const useIncremental = cliArgs.includes('--incremental')
const useScan = cliArgs.includes('--scan')
const useDryRun = cliArgs.includes('--dry-run')
const baseArgIndex = cliArgs.indexOf('--base')
const cliBase = baseArgIndex >= 0 ? cliArgs[baseArgIndex + 1] : undefined
const explicit = cliArgs.filter(
  (arg) =>
    arg !== '--incremental' &&
    arg !== '--scan' &&
    arg !== '--dry-run' &&
    arg !== '--base' &&
    arg !== cliBase,
)

const git = (gitArgs) => {
  try {
    return execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}

const toLines = (text) =>
  (text ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean)

/** 递归列出目录下的 .ts（跳过测试文件）。 */
const walk = (dir) => {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(full)) out.push(full)
  }
  return out
}

/**
 * 解析变异范围的「基准」——CI 里代码已经提交，工作区是干净的，
 * 只有拿 MR 的目标分支当基准才查得到改动。
 *
 * 解析顺序：显式 --base / MUTATION_BASE → CI 平台变量 → 本地工作区。
 * 解析不到基准且处于 CI → 直接报错（范围不可知就不能放行，否则就是假绿）。
 */
const resolveBase = () => {
  if (cliBase) return { ref: cliBase, source: '--base' }
  if (process.env.MUTATION_BASE) return { ref: process.env.MUTATION_BASE, source: 'MUTATION_BASE' }
  // GitLab MR 流水线：目标分支的提交
  if (process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA) {
    return {
      ref: process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA,
      source: 'CI_MERGE_REQUEST_DIFF_BASE_SHA',
    }
  }
  // GitLab 普通流水线：上一次提交
  const before = process.env.CI_COMMIT_BEFORE_SHA
  if (before && !/^0+$/.test(before)) {
    return { ref: before, source: 'CI_COMMIT_BEFORE_SHA' }
  }
  // GitHub Actions：PR 的目标分支
  if (process.env.GITHUB_BASE_REF) {
    return { ref: `origin/${process.env.GITHUB_BASE_REF}`, source: 'GITHUB_BASE_REF' }
  }
  return null
}

const changed = new Set(explicit)
let scopeSource = '显式指定'

if (useScan) {
  scopeSource = '扫描清单'
  for (const root of SCAN_ROOTS) {
    if (!existsSync(root)) continue
    for (const file of walk(root)) changed.add(file.replace(/\\/g, '/'))
  }
} else if (explicit.length === 0) {
  const base = resolveBase()
  if (base) {
    scopeSource = `基准 ${base.ref}（${base.source}）`
    const diff = git(['diff', '--name-only', `${base.ref}...HEAD`])
    if (diff === null) {
      console.error(
        `mutation-scope: 无法与基准 ${base.ref} 比较（ref 不存在或历史不完整）。` +
          '浅克隆要先 fetch：GitHub Actions 用 actions/checkout 的 fetch-depth: 0，GitLab 用 GIT_DEPTH: 0。',
      )
      process.exit(2)
    }
    for (const file of toLines(diff)) changed.add(file)
  } else if (process.env.CI) {
    console.error(
      'mutation-scope: CI 里解析不到基准 ref，无法确定变异范围——不放行。' +
        '请传 --base <目标分支> 或设 MUTATION_BASE（GitLab 用 CI_MERGE_REQUEST_DIFF_BASE_SHA，GitHub 用 GITHUB_BASE_REF）。',
    )
    process.exit(2)
  } else {
    scopeSource = '工作区改动'
    for (const gitArgs of [
      ['diff', '--name-only', 'HEAD'], // 工作区已改 + 已暂存
      ['ls-files', '--others', '--exclude-standard'], // 未跟踪
    ]) {
      for (const file of toLines(git(gitArgs))) changed.add(file)
    }
  }
}

const targets = [...changed]
  .filter((file) => file.endsWith('.ts'))
  .filter((file) => !/\.(test|spec)\.ts$/.test(file))
  // 「值得做变异测试的代码集合」= (src/kernel ∪ src/protocol) − 排除名单
  // src/host、src/renderer、src/main 不在内：IO 密集，变异大多被 mock 吸收，噪音大于信号。
  .filter((file) => SCAN_ROOTS.some((root) => file.startsWith(root + '/')))
  .filter((file) => !SCAN_EXCLUDE.includes(file))
  .sort()

if (targets.length === 0) {
  console.log('mutation-scope: 范围内没有可变异的产品代码（' + scopeSource + '）——跳过变异测试')
  process.exit(0)
}

const missing = targets.filter((file) => !existsSync(file))
if (missing.length > 0) {
  console.error('mutation-scope: 以下文件不存在：' + missing.join('、'))
  process.exit(1)
}

const strykerArgs = ['run', '--mutate', targets.join(',')]
if (useIncremental) strykerArgs.push('--incremental')

console.log(
  'mutation-scope: ' +
    (useScan ? '全量扫描 ' : '定点范围 ') +
    targets.length +
    ' 个文件' +
    (useIncremental ? '（增量）' : '') +
    '｜范围来源：' +
    scopeSource,
)
console.log('mutation-scope: ' + targets.join('、'))

if (useDryRun) {
  console.log('mutation-scope: --dry-run，只打印范围不执行')
  process.exit(0)
}
// 优先用项目内的可执行文件：直接 `node scripts/...` 运行时 PATH 里没有 node_modules/.bin
const localBin = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'stryker.cmd' : 'stryker',
)
const command = existsSync(localBin) ? localBin : 'stryker'
const result = spawnSync(command, strykerArgs, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
