#!/usr/bin/env node
// check-diff-coverage.mjs — 改动行覆盖率门禁（默认 ≥90%，可用 MIN_DIFF_COVERAGE 覆盖）。
// 前置：先跑 `pnpm test:coverage` 生成 coverage/coverage-final.json。
// 用法: node scripts/check-diff-coverage.mjs [--base <ref>]
// 退出码: 0 达标 / 1 未达标 / 2 无法运行（无覆盖率数据、无 merge base 等）
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const argBase = (() => {
  const i = process.argv.indexOf('--base')
  return i > -1 ? process.argv[i + 1] : process.env.CONSTRAINTS_BASE || 'master'
})()
const THRESHOLD = Number(process.env.MIN_DIFF_COVERAGE || 90)
const git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
}
const bail = (msg) => {
  console.error('check-diff-coverage: ' + msg)
  process.exit(2)
}

const top = git(['rev-parse', '--show-toplevel'])?.trim()
if (!top) bail('not inside a git work tree')
process.chdir(top)
const topAbs = path.resolve(top)

let cov
try {
  cov = JSON.parse(readFileSync(path.join(topAbs, 'coverage', 'coverage-final.json'), 'utf8'))
} catch {
  bail('缺少 coverage/coverage-final.json，先运行 `pnpm test:coverage`')
}

// 覆盖率数据：相对路径 -> 语句起始行集合（带计数）
const stmtByFile = new Map()
for (const [absKey, data] of Object.entries(cov)) {
  const rel = path.relative(topAbs, path.resolve(absKey)).replace(/\\/g, '/')
  const stmts = new Map()
  for (const [id, s] of Object.entries(data.statementMap || {})) {
    const line = s?.start?.line
    if (typeof line === 'number') stmts.set(line, (data.s?.[id] ?? 0) > 0)
  }
  stmtByFile.set(rel, stmts)
}

const mergeBase = git(['merge-base', argBase, 'HEAD'])?.trim()
if (!mergeBase) bail('no merge base against ' + argBase)
const tracked = git(['diff', '--unified=0', mergeBase, '--'])
if (tracked === null) bail('could not diff against ' + mergeBase)

// 每个文件的新增行号集合
const addedLines = new Map()
const addLine = (f, n) => {
  if (!addedLines.has(f)) addedLines.set(f, new Set())
  addedLines.get(f).add(n)
}
const pathOf = (s) => s.replace(/^[ab]\//, '')
let file = ''
let oldFile = ''
let inHeader = false
let newLineNo = 0
for (const line of tracked.split('\n')) {
  if (line.startsWith('diff ')) inHeader = true
  else if (line.startsWith('@@')) {
    inHeader = false
    const m = line.match(/\+(\d+)/)
    newLineNo = m ? Number(m[1]) : 0
  } else if (inHeader) {
    if (line.startsWith('--- ')) oldFile = pathOf(line.slice(4))
    else if (line.startsWith('+++ ')) {
      const nf = pathOf(line.slice(4))
      file = nf === '/dev/null' ? oldFile : nf
    }
  } else if (line.startsWith('+')) {
    addLine(file, newLineNo)
    newLineNo++
  } else if (line.startsWith(' ')) {
    newLineNo++
  }
}

const untracked = git(['ls-files', '--others', '--exclude-standard'])
if (untracked === null) bail('could not list untracked files')
for (const f of untracked.split('\n').filter(Boolean)) {
  const rel = f.replace(/\\/g, '/')
  let content = ''
  try {
    content = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  const n = content.split('\n').length
  for (let i = 1; i <= n; i++) addLine(rel, i)
}

const isSource = (f) => /^src\/.*\.(ts|tsx)$/.test(f) && !/\.(test|spec)\./.test(f)
// 纯类型文件没有可执行语句，不做覆盖率要求。
const isTypeOnly = (f) => /(^|\/)(types\.ts|.*\.d\.ts)$/.test(f)

let total = 0
let covered = 0
const perFile = []
const notCovered = []
for (const [f, lines] of addedLines) {
  if (!isSource(f) || isTypeOnly(f)) continue
  const stmts = stmtByFile.get(f)
  if (!stmts) {
    notCovered.push(f)
    continue
  }
  let t = 0
  let c = 0
  for (const ln of lines) {
    if (stmts.has(ln)) {
      t++
      if (stmts.get(ln)) c++
    }
  }
  if (t === 0) continue
  total += t
  covered += c
  perFile.push({ file: f, changed: t, covered: c })
}

// 改动的源码文件完全没进覆盖率数据 = 没有任何测试导入过它，视为未测。
if (notCovered.length > 0) {
  console.error('check-diff-coverage: 以下改动源码文件未纳入覆盖率（没有任何测试导入）：')
  for (const f of notCovered) console.error('  - ' + f)
  console.error('请补测试覆盖，或将纯类型文件按约定命名（types.ts / *.d.ts）。')
  process.exit(1)
}

if (total === 0) {
  console.log('check-diff-coverage: 无改动的可执行源码行，跳过')
  process.exit(0)
}

const pct = (covered / total) * 100
for (const x of perFile) {
  const p = (x.covered / x.changed) * 100
  console.log(`  - ${x.file}: ${x.covered}/${x.changed} = ${p.toFixed(1)}%`)
}
console.log(
  `check-diff-coverage: 改动行合计 ${covered}/${total} = ${pct.toFixed(2)}%（门槛 ${THRESHOLD}%）`,
)

if (pct + 1e-9 >= THRESHOLD) process.exit(0)
console.error(`check-diff-coverage: 未达标，需 ≥${THRESHOLD}%`)
process.exit(1)
