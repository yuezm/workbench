#!/usr/bin/env node
// check-mutation-scope.mjs — 变异门禁的护栏（`pnpm verify:guards` 的一环）。
//
// 变异测试是真绿还是假绿，取决于三件事，这里逐条守住：
//
// 1. **范围只有一份**：`scripts/mutation-targets.mjs` 是单一来源，`stryker.config.json`
//    的 `mutate` 必须由它展开。两份各写一遍必然漂——历史上排除名单写成 `src/kernel/...`
//    而实际路径是 `packages/core/kernel/src/...`，过滤器一个都没命中，等于没排除。
// 2. **清单不指向不存在的文件**：重命名 / 删文件后没人更新清单，范围会静默变小。
// 3. **门槛不被悄悄下调**：`break` 是「达不到就不许合并」的红线，只许调高。
//
// 退出码：0 = 一致；1 = 不一致（打印差异）。
import { existsSync, readFileSync } from 'node:fs'
import { mutateGlobs, SCAN_EXCLUDE, SCAN_ROOTS } from './mutation-targets.mjs'

/** 变异评分的红线（分数是这个百分数的百分比形式）。 */
const MIN_BREAK_THRESHOLD = 80

const problems = []

const config = JSON.parse(readFileSync('stryker.config.json', 'utf8'))
const expected = mutateGlobs()

const actual = Array.isArray(config.mutate) ? config.mutate : [config.mutate]
const missing = expected.filter((glob) => !actual.includes(glob))
const extra = actual.filter((glob) => !expected.includes(glob))
if (missing.length > 0) problems.push(`stryker.config.json 的 mutate 少了：${missing.join('、')}`)
if (extra.length > 0) problems.push(`stryker.config.json 的 mutate 多了：${extra.join('、')}`)

for (const path of [...SCAN_ROOTS, ...SCAN_EXCLUDE]) {
  if (!existsSync(path))
    problems.push(`变异清单里的路径不存在（改名 / 删除后要同步 mutation-targets.mjs）：${path}`)
}

const breakThreshold = config.thresholds?.break
if (typeof breakThreshold !== 'number' || breakThreshold < MIN_BREAK_THRESHOLD) {
  problems.push(
    `变异门槛 break 不得低于 ${MIN_BREAK_THRESHOLD}（当前 ${String(breakThreshold)}）——` +
      '达不到就补断言，不要降门槛',
  )
}

if (!config.ignoreStatic) {
  problems.push(
    'ignoreStatic 必须为 true：静态变异体（模块级常量）每个都要重跑全量用例，' +
      '实测占变异耗时的 68%；常量改用显式断言钉住（见 docs/testing/TESTING.md）',
  )
}

if (problems.length > 0) {
  console.error('check-mutation-scope: 变异范围/门槛不一致')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  `check-mutation-scope: 范围 ${SCAN_ROOTS.length} 个根目录 / 排除 ${SCAN_EXCLUDE.length} 个文件，` +
    `mutate 条目 ${expected.length}，break ≥ ${MIN_BREAK_THRESHOLD} — 一致`,
)
