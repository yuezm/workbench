#!/usr/bin/env node
/**
 * e2e 红检（缺陷注入）：验证「这条 e2e 真的会红」。
 *
 * 为什么需要它：Stryker 只能变异被测源码、再跑单测（vitest/jest 一类 runner），
 * `tests/e2e/*.spec.ts` 靠 Playwright 起真实 Electron，没有任何变异测试器能驱动它。
 * 于是「e2e 全绿」这件事本身不被证明——断言写歪、选择器写成恒真、等错元素，
 * 都会得到一片绿。唯一能回答「它会不会红」的办法：**把已知缺陷塞回代码里，看它是否失败**。
 *
 * 每个用例 = 一处「已知修复」的反向替换 + 一条应当因此失败的 spec：
 *   1. 断点：`find` 在被改文件里必须恰好出现一次（否则它已经不是原来的缺陷点，用例要重写）；
 *   2. 注入：把 `find` 换成 `replace`（保持可编译：不用 `if (false)` 这类会让 TS/打包报错的写法）；
 *   3. 构建：`pnpm run build:compile`（e2e 跑的是 out/，不重建等于没注入）；
 *   4. 断言：跑该 spec，**必须非 0 退出**。0 = 这条 e2e 已经失效（假绿），红检失败；
 *   5. 还原：无论成败都写回原文（按读取时的字节还原，不依赖 git，不吃掉工作区里的本地改动）。
 *
 * 用法：
 *   node scripts/e2e-redcheck.mjs                 # 跑全部用例（会反复构建，分钟级）
 *   node scripts/e2e-redcheck.mjs --case webhook   # 只跑一条（id 前缀匹配）
 *   node scripts/e2e-redcheck.mjs --dry-run       # 只校验断点，不注入、不构建（秒级，可进 CI）
 *   node scripts/e2e-redcheck.mjs --list          # 列出用例
 *   node scripts/e2e-redcheck.mjs --no-build      # 复用当前 out/（改源码后自己先构建）
 *
 * 退出码：0 = 全部用例都被抓到（或 dry-run 断点全部有效）；1 = 有 spec 没红 / 断点失效 / 构建失败。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * 用例清单：`find` 是**修复后**的代码形态，`replace` 是把它改回缺陷。
 * 每条都要写清楚「注入的是什么缺陷、为什么这条 e2e 应该抓到」——它同时是这份清单的文档。
 */
const CASES = [
  {
    id: 'pomodoro-clamp',
    spec: 'tests/e2e/pomodoro.spec.ts',
    file: 'src/renderer/src/apps/pomodoro/timer/machine.ts',
    find: 'return Math.min(range.max, Math.max(range.min, value))',
    replace: 'return Math.max(range.min, value)',
    defect: '配置钳制丢上界：专注时长填 999 不再被压回 120',
    why: 'e2e 断言「999 → 120」，钳制一破就必须红',
  },
  {
    id: 'approval-dup-guard',
    spec: 'tests/e2e/approval.spec.ts',
    file: 'src/kernel/scopes/cards.ts',
    find: "if (card.status !== 'open') {",
    replace: "if (String(card.status) === 'never-answered') {",
    defect: '去掉「卡片已回答或已关闭」的重复回答守卫',
    why: 'e2e 断言第二次 card.answer 被拒且事实计数不变，守卫一破就必须红',
  },
  {
    id: 'webhook-signature',
    spec: 'tests/e2e/webhook.spec.ts',
    file: 'src/plugins/sources/webhook/index.ts',
    find: 'if (!net.verifyHmacSha256(config.secret, `${timestamp}.${request.body}`, matched[1])) {',
    // 注入形态必须仍然编译得过（`typecheck` 是 `build:compile` 的一部分）：
    // 用「验签失败 且 签名头长得离谱」代替「验签失败」，等于把验签短路，同时不留下未使用的变量。
    replace:
      'if (!net.verifyHmacSha256(config.secret, `${timestamp}.${request.body}`, matched[1]) && matched[0].length > 1_000_000) {',
    defect: 'HMAC 验签被短路（错签名的 POST 也放行）',
    why: 'e2e 断言错签名回 401 且零事件，验签一破就必须红',
  },
]

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const valueOf = (name) => {
  const index = args.indexOf(`--${name}`)
  return index > -1 ? args[index + 1] : undefined
}

const DRY = flag('dry-run')
const NO_BUILD = flag('no-build')
const wanted = valueOf('case')

if (flag('list')) {
  for (const item of CASES) {
    console.log(
      `${item.id}\n  spec: ${item.spec}\n  缺陷: ${item.defect}\n  为什么该红: ${item.why}`,
    )
  }
  process.exit(0)
}

/** e2e 在 Electron 宿主里跑要先清掉继承的 ELECTRON_RUN_AS_NODE，否则 Electron 以 Node 模式启动。 */
const childEnv = { ...process.env }
delete childEnv.ELECTRON_RUN_AS_NODE

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: true, env: childEnv })
  return result.status ?? 1
}

/** 断点必须唯一：出现 0 次（锚点漂了）或多次（改错地方）都直接判失败，不猜。 */
function checkAnchor(item) {
  const text = readFileSync(item.file, 'utf8')
  const hits = text.split(item.find).length - 1
  if (hits !== 1) {
    return { ok: false, text, reason: `${item.file} 里 \`find\` 命中 ${hits} 处（必须恰好 1 处）` }
  }
  return { ok: true, text, reason: '' }
}

const selected = wanted === undefined ? CASES : CASES.filter((item) => item.id.startsWith(wanted))
if (selected.length === 0) {
  console.error(`红检: 没有匹配 --case ${wanted} 的用例（--list 看全部）`)
  process.exit(1)
}

// 1) 先把断点全部校验完：锚点漂了就不该开始构建（失败要快、要准）
const prepared = []
for (const item of selected) {
  const anchor = checkAnchor(item)
  if (!anchor.ok) {
    console.error(`红检: 断点失效 [${item.id}] ${anchor.reason}`)
    process.exit(1)
  }
  prepared.push({ item, original: anchor.text })
}
console.log(`红检: ${prepared.length} 条用例，断点全部有效`)

if (DRY) {
  for (const { item } of prepared) console.log(`  ✓ ${item.id} → ${item.spec}`)
  process.exit(0)
}

let failed = 0
for (const { item, original } of prepared) {
  console.log(`\n=== 红检 [${item.id}] ${item.defect}`)
  console.log(`    注入 ${item.file}\n    期望 ${item.spec} 失败（${item.why}）`)
  const mutated = original.replace(item.find, item.replace)
  try {
    writeFileSync(item.file, mutated)
    if (!NO_BUILD) {
      const buildStatus = run('pnpm', ['run', 'build:compile'])
      if (buildStatus !== 0) {
        console.error(
          `红检: [${item.id}] 构建失败（退出 ${buildStatus}），注入不可信，判该用例未通过`,
        )
        failed += 1
        continue
      }
    }
    const specStatus = run('pnpm', ['exec', 'playwright', 'test', item.spec, '--reporter=line'])
    if (specStatus === 0) {
      console.error(`红检: [${item.id}] 假绿——缺陷注入了，${item.spec} 仍然全绿`)
      failed += 1
    } else {
      console.log(`红检: [${item.id}] 通过（spec 退出 ${specStatus}）`)
    }
  } finally {
    // 按读取时的内容还原：不吃掉工作区里的本地改动，也不依赖 git 状态
    writeFileSync(item.file, original)
    console.log(`    已还原 ${item.file}`)
  }
}

if (!NO_BUILD) {
  // 还原之后再构建一次，让 out/ 回到与 src/ 一致的状态（否则下次手跑 e2e 会带着注入跑）
  console.log('\n红检: 还原后重建 out/')
  const status = run('pnpm', ['run', 'build:compile'])
  if (status !== 0) {
    console.error(`红检: 还原后构建失败（退出 ${status}）`)
    process.exit(1)
  }
}

if (failed > 0) {
  console.error(`\n红检: ${failed} 条用例没被 e2e 抓到——对应的 spec 需要补断言或换判据`)
  process.exit(1)
}
console.log(`\n红检: ${prepared.length} 条用例全部被抓到（e2e 断言有效）`)
