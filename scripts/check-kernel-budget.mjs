/**
 * 内核行数预算（M37）：拆两层之后，「内核膨胀」要有一个当场能判定的读数。
 *
 * 预算（写进 ARCHITECTURE 验收表）：
 * - `src/kernel/core/**` 合计 ≤ 2000 行（真正的纯基础：类型 / 常量 / cron / 下次唤醒）；
 * - `src/kernel/scopes/**` 里**单个文件** ≤ 900 行（域可以多文件，但一个文件不许长成巨石）；
 * - `src/kernel/decide.ts` ≤ 220 行（只做表驱动分派）。
 *
 * 只数非空行（去掉注释与空行会掩盖「注释比代码多」的文件，这里不区分：行数就是维护成本）。
 * 超限 exit 1；`pnpm check:fast` 已接入。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const KERNEL = join(ROOT, 'src', 'kernel')
const CORE = join(KERNEL, 'core')
const SCOPES = join(KERNEL, 'scopes')
const DECIDE = join(KERNEL, 'decide.ts')

const CORE_BUDGET = 2_000
const SCOPE_FILE_BUDGET = 900
const DECIDE_BUDGET = 220

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

const lines = (file) => readFileSync(file, 'utf8').split('\n').length

const coreFiles = walk(CORE)
const scopeFiles = walk(SCOPES)
const coreLines = coreFiles.reduce((sum, file) => sum + lines(file), 0)
const decideLines = lines(DECIDE)

const problems = []
if (coreLines > CORE_BUDGET) problems.push(`core/ 合计 ${coreLines} 行，超过预算 ${CORE_BUDGET}`)
for (const file of scopeFiles) {
  const count = lines(file)
  if (count > SCOPE_FILE_BUDGET) {
    problems.push(`${relative(ROOT, file)} ${count} 行，超过单文件预算 ${SCOPE_FILE_BUDGET}`)
  }
}
if (decideLines > DECIDE_BUDGET)
  problems.push(`decide.ts ${decideLines} 行，超过预算 ${DECIDE_BUDGET}`)

console.log(`kernel-budget: core ${coreLines}/${CORE_BUDGET} 行（${coreFiles.length} 文件）`)
console.log(`kernel-budget: decide.ts ${decideLines}/${DECIDE_BUDGET} 行`)
const largest = scopeFiles
  .map((file) => ({ file: relative(ROOT, file), lines: lines(file) }))
  .sort((a, b) => b.lines - a.lines)
  .slice(0, 5)
for (const entry of largest)
  console.log(`kernel-budget: scopes 最大 ${entry.file} ${entry.lines}/${SCOPE_FILE_BUDGET}`)

if (problems.length > 0) {
  console.error('\nkernel-budget: 超预算：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
