#!/usr/bin/env node
// floor-guard.mjs — diff 范围内守护 CONSTRAINTS.md 的 Floor。
// 用法: node scripts/floor-guard.mjs [--base <ref>]   (默认 base: master)
// 退出码: 0 干净 / 1 至少一处 floor 违规（应阻断）/ 2 无法运行（无 merge base、非 git 仓库）
// 来源: 基于 constraint-driven-development 的 references/floor-guard.md 参考实现裁剪，
//       仅保留本仓库需要的模式；contract 保持不变（exit 0/1/2、只报规则与位置、不报密文值）。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const argBase = (() => {
  const i = process.argv.indexOf('--base')
  return i > -1 ? process.argv[i + 1] : process.env.CONSTRAINTS_BASE || 'master'
})()

const git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}
const bail = (msg) => {
  console.error('floor-guard: ' + msg)
  process.exit(2)
}

const top = git(['rev-parse', '--show-toplevel'])?.trim()
if (!top) bail('not inside a git work tree')
process.chdir(top)

const mergeBase = git(['merge-base', argBase, 'HEAD'])?.trim()
if (!mergeBase) bail('no merge base against ' + argBase)

const tracked = git(['diff', '--unified=0', mergeBase, '--'])
if (tracked === null) bail('could not diff against ' + mergeBase)

// 解析 git diff：--- / +++ 仅在 diff 行到首个 @@ 之间的头部区识别，hunk 内一律当内容。
const added = []
const removed = []
const deleted = []
const addedPaths = new Set()
const pathOf = (s) => s.replace(/^[ab]\//, '')
let file = ''
let oldFile = ''
let inHeader = false
for (const line of tracked.split('\n')) {
  if (line.startsWith('diff ')) inHeader = true
  else if (line.startsWith('@@')) inHeader = false
  else if (inHeader) {
    if (line.startsWith('--- ')) oldFile = pathOf(line.slice(4))
    else if (line.startsWith('+++ ')) {
      const newFile = pathOf(line.slice(4))
      file = newFile === '/dev/null' ? oldFile : newFile
      if (newFile === '/dev/null') deleted.push(file)
      else addedPaths.add(newFile)
    }
  } else if (line.startsWith('+')) added.push({ file, text: line.slice(1) })
  else if (line.startsWith('-')) removed.push({ file, text: line.slice(1) })
}

// 未跟踪文件：git diff 看不到，整文件视为新增行（直接读文件，避免 /dev/null 在 Windows 上的兼容问题）。
const untracked = git(['ls-files', '--others', '--exclude-standard'])
if (untracked === null) bail('could not list untracked files')
for (const f of untracked.split('\n').filter(Boolean)) {
  let content = ''
  try {
    content = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  const normalized = f.replace(/\\/g, '/')
  // 未跟踪的新文件同样是「新增路径」（迁移判定要用到）
  addedPaths.add(normalized)
  for (const text of content.split('\n')) added.push({ file: normalized, text })
}

const findings = []
const flag = (rule, f, text) => findings.push({ rule, file: f, text: text.trim().slice(0, 120) })
const isTest = (f) => /\.(test|spec)\.|_test\.|test_/.test(f)
const isConstraints = (f) => /CONSTRAINTS\.md$/.test(f)

// 1. 关闭检查器的注释（本仓库生态：TS/ESLint/istanbul）。后续可扩展。
const SUPPRESSIONS =
  /@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|# *noqa|# *type: *ignore|istanbul ignore|nosemgrep|gitleaks:allow|Stryker disable/
// 4. 未完成的工作。
const STUBS =
  /throw new (Error|NotImplemented).*[Nn]ot implemented|catch\s*\(\w*\)\s*\{\s*\}|catch\s*\{\s*\}|\bTODO\b|\bpass\s*# *stub/
// 2. 被放松的测试。
const SKIPS = /\.(skip|todo)\b|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|t\.Skip\(/

for (const { file, text } of added) {
  // 守卫脚本自身、以及 CONSTRAINTS.md 正文（会合法地引用 @ts-ignore 等字样）不算违规。
  if (file.startsWith('scripts/')) continue
  if (isConstraints(file)) {
    if (/^\| *(W|E)\d+ *\|/.test(text.trim())) flag('new-exception', file, text)
    continue
  }
  if (SUPPRESSIONS.test(text)) flag('silenced-checker', file, text)
  if (STUBS.test(text)) flag('unfinished-work', file, text)
  if (SKIPS.test(text)) flag('test-made-easier', file, text)
}

// 2b. 测试文件被删，或仍在的测试文件里断言净减少。
// 契约迁移（v1 → v2 重写测试）会删掉旧断言、同时补上新断言；只有「同文件断言净减少」
// 才是真正的放松。被测源码也一起删除时，删除其测试不算放松（死代码清理）。
const deletedSet = new Set(deleted)
const sourceOf = (f) =>
  f.replace(/\.(test|spec)\.(ts|tsx)$/, '.$2').replace(/_test\.(go|py)$/, '.$1')
// 测试与源码同构镜像：源码在 src/<layer>/、测试在 tests/<layer>/ 时，删测试的「被测源码」
// 不在同目录。两处都查，才能识别「源码与其测试一起删除」= 死代码清理，而不是放松门槛。
const sourceCandidates = (f) => {
  const candidates = [sourceOf(f)]
  if (f.startsWith('tests/')) {
    candidates.push('src/' + f.slice('tests/'.length).replace(/\.(test|spec)\.(ts|tsx)$/, '.$2'))
  }
  return candidates
}
// 测试搬家（src/**.test.ts → tests/**.test.ts）：旧路径删除 + 新路径新增 = 迁移，不是删测试。
// git 有时识别不出 rename（相似度阈值），此时会退化成 delete + add，用路径对应关系兜底。
// 显式登记的「按层搬家」（T16 计划表）：旧测试的行为在新位置重写，断言同等覆盖。
const RELOCATED_TESTS = {
  // T14b：repository 聊天 SQL 用例 → 宿主聊天执行链用例（IPC/scheduler/投影）
  'tests/main/ai-workflow/repository.chat.test.ts': 'tests/host/chat.test.ts',
  // T16：main 层用例按层搬家（读路径收口后 host 已有等价覆盖）
  'tests/main/ai-workflow/ipc.test.ts': 'tests/host/ipc.test.ts',
  // repository 补充用例（runs / 负载 / 聊天投影）→ 投影视图与 IPC 用例
  'tests/main/ai-workflow/repository.extra.test.ts': 'tests/host/ipc.test.ts',
  // M5：旧 ai-workflow RPC 表用例 → 三动词命令路由 / 幂等 / 宿主视图用例
  'tests/host/ipc.test.ts': 'tests/host/commands.test.ts',
  'tests/main/index.test.ts': 'tests/host/boot.test.ts',
  // M3：执行器插件化后按层搬家（T5 登记，新位置行为等价覆盖）
  'tests/main/ai-workflow/runtime/dsh.test.ts': 'tests/plugins/executors/dsh/dsh.test.ts',
  'tests/main/ai-workflow/runtime/detect.test.ts': 'tests/plugins/executors/dsh/detect.test.ts',
  'tests/main/ai-workflow/runtime/registry.test.ts': 'tests/plugins/registry.test.ts',
  'tests/main/ai-workflow/runtime/executor-port.test.ts':
    'tests/plugins/executors/dsh/port.test.ts',
  'tests/main/ai-workflow/runtime/process.test.ts': 'tests/host/process.test.ts',
  'tests/main/ai-workflow/runtime/executable.test.ts': 'tests/host/executable.test.ts',
}
const migratedCounterpart = (f) => {
  const relocated = RELOCATED_TESTS[f]
  if (relocated !== undefined && addedPaths.has(relocated)) return relocated
  const strip = (p) => p.replace(/^(src|tests)\//, '')
  for (const g of addedPaths) {
    if (strip(g) === strip(f)) return g
  }
  return null
}
// 断言搬家（M27）：被测组件本身瘦身（运行时表单只留连接、执行配置移到智能体表单），
// 迁走的断言由另一个测试文件承接。这里登记「谁承接」，只有承接方的断言净增覆盖得住
// 迁出方的净减才算迁移；承接方没涨，照样按「断言净减少」阻断。
const ASSERTION_MIGRATIONS = {
  // 运行时表单精简：模型 / 思考强度 / 并发 / 权限 / 工作目录 的用例搬到智能体表单
  'tests/renderer/src/apps/ai-workflow/components/RuntimeDialog.test.tsx':
    'tests/renderer/src/apps/ai-workflow/components/AgentDialog.test.tsx',
}
for (const f of deleted) {
  if (!isTest(f)) continue
  if (sourceCandidates(f).some((source) => deletedSet.has(source))) continue
  if (migratedCounterpart(f)) continue
  flag('test-deleted', f, 'file deleted')
}
const assertionRe = /\b(expect|assert|should)\b/
const countBy = (list) => {
  const counts = new Map()
  for (const { file, text } of list) {
    if (!isTest(file) || !assertionRe.test(text)) continue
    counts.set(file, (counts.get(file) ?? 0) + 1)
  }
  return counts
}
const removedAssertions = countBy(removed)
const addedAssertions = countBy(added)
for (const [file, removedCount] of removedAssertions) {
  if (deletedSet.has(file)) continue
  const addedCount = addedAssertions.get(file) ?? 0
  if (removedCount <= addedCount) continue
  const counterpart = ASSERTION_MIGRATIONS[file]
  const movedIn = counterpart
    ? Math.max(
        0,
        (addedAssertions.get(counterpart) ?? 0) - (removedAssertions.get(counterpart) ?? 0),
      )
    : 0
  if (counterpart !== undefined && removedCount <= addedCount + movedIn) continue
  flag('assertion-removed', file, `assertions ${removedCount} -> ${addedCount}`)
}

// 1b/2c. CONSTRAINTS.md 的规则被放松或删除（与参考实现一致的阈值方向判定）。
const ruleKey = (t) => {
  const s = t.trim()
  if (s.startsWith('|'))
    return (
      s
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)[0] ?? ''
    )
  if (/^[-*] /.test(s)) return s.slice(2).split(':')[0].trim()
  return null
}
const isException = (t) => /^\| *(W|E)\d+ *\|/.test(t.trim())
const MIN_BEFORE = /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop)\s*$/
const MAX_BEFORE =
  /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed)\s*$/
const MIN_AFTER = /^\s*\S*\s*(or more|or higher|must not fall|must not drop)/
const MAX_AFTER = /^\s*\S*\s*(or less|or lower|must not grow|must not exceed)/
const thresholds = (t) => {
  const out = []
  const re = /\d+(?:\.\d+)?/g
  let m
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase()
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase()
    const dir =
      MIN_BEFORE.test(before) || MIN_AFTER.test(after)
        ? 'min'
        : MAX_BEFORE.test(before) || MAX_AFTER.test(after)
          ? 'max'
          : null
    out.push({ n: Number(m[0]), dir })
  }
  return out
}
const removedRules = removed.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null)
const addedRules = added.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null)
for (const r of removedRules) {
  const a = addedRules.find((x) => ruleKey(x.text) === ruleKey(r.text))
  if (!a) {
    if (!isException(r.text)) flag('rule-removed', r.file, r.text)
    continue
  }
  const before = thresholds(r.text)
  const after = thresholds(a.text)
  let verdict = null
  for (const dir of ['min', 'max', null]) {
    const was = before.filter((x) => x.dir === dir)
    const now = after.filter((x) => x.dir === dir)
    was.forEach((b, i) => {
      const n = now[i]
      if (verdict) return
      if (!n) verdict = 'threshold-removed'
      else if (n.n === b.n) return
      else if (dir === 'min' ? n.n < b.n : dir === 'max' ? n.n > b.n : n.n < b.n) {
        // 无方向标注的指标（如覆盖率四元组）按「不得下降」判定：提高不算放松
        verdict = dir ? 'threshold-loosened' : 'threshold-changed'
      }
    })
  }
  if (verdict) flag(verdict, r.file, r.text + '  ->  ' + a.text)
}

if (findings.length === 0) {
  console.log('floor-guard: clean')
  process.exit(0)
}
console.error('floor-guard: ' + findings.length + ' floor violation(s):')
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`)
console.error('\n每条都是「降低门槛」的动作。修代码，或走已登记的例外。')
process.exit(1)
