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
  for (const text of content.split('\n')) added.push({ file: f.replace(/\\/g, '/'), text })
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

// 2b. 测试文件被删，或仍在的测试文件里删掉了断言。
for (const f of deleted) if (isTest(f)) flag('test-deleted', f, 'file deleted')
for (const { file, text } of removed) {
  if (isTest(file) && !deleted.includes(file) && /\b(expect|assert|should)\b/.test(text)) {
    flag('assertion-removed', file, text)
  }
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
      else if (dir === 'min' ? n.n < b.n : dir === 'max' ? n.n > b.n : true) {
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
