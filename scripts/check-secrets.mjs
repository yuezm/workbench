#!/usr/bin/env node
// check-secrets.mjs — diff 范围内的密钥扫描（红线：报告规则与位置，绝不打印密文值）。
// 用法: node scripts/check-secrets.mjs [--base <ref>]   (默认 base: master)
// 退出码: 0 干净 / 1 命中疑似密钥 / 2 无法运行
// 说明: 本地轻量替代 gitleaks（未安装）；CI 具备后可替换为 gitleaks detect --redact。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const argBase = (() => {
  const i = process.argv.indexOf('--base')
  return i > -1 ? process.argv[i + 1] : process.env.CONSTRAINTS_BASE || 'master'
})()
const git = (args) => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // 内核拆分这类大改动会让默认 1 MB 溢出（ENOBUFS 被吞成「无法 diff」）
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return null
  }
}
const bail = (msg) => {
  console.error('check-secrets: ' + msg)
  process.exit(2)
}

const top = git(['rev-parse', '--show-toplevel'])?.trim()
if (!top) bail('not inside a git work tree')
process.chdir(top)
const mergeBase = git(['merge-base', argBase, 'HEAD'])?.trim()
if (!mergeBase) bail('no merge base against ' + argBase)
const tracked = git(['diff', '--unified=0', mergeBase, '--'])
if (tracked === null) bail('could not diff against ' + mergeBase)

// 收集「新增行」：{file, line, text}
const added = []
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
    added.push({ file, line: newLineNo, text: line.slice(1) })
    newLineNo++
  } else if (line.startsWith('-')) {
    // 删除行不计入新增
  } else if (line.startsWith(' ')) {
    newLineNo++
  }
}
const untracked = git(['ls-files', '--others', '--exclude-standard'])
if (untracked === null) bail('could not list untracked files')
for (const f of untracked.split('\n').filter(Boolean)) {
  let content = ''
  try {
    content = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  content
    .split('\n')
    .forEach((text, i) => added.push({ file: f.replace(/\\/g, '/'), line: i + 1, text }))
}

// 不扫的路径/二进制
const SKIP =
  /(^|\/)(node_modules|out|dist|release|coverage)\/|\.(png|jpe?g|gif|webp|ico|pdf|lock)$|(^|\/)pnpm-lock\.yaml$|^scripts\/|\.md$|\.test\.|\.spec\./i
const isPlaceholder = (v) =>
  /your|xxxx|example|changeme|placeholder|redacted|fake|dummy|sample|process\.env|undefined|null|<.*>/i.test(
    v,
  )

const RULES = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
]
const GENERIC =
  /(api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret)\s*[:=]\s*['"`]([^'"`]{12,})['"`]/i

const findings = []
for (const { file: f, line, text } of added) {
  if (SKIP.test(f)) continue
  for (const r of RULES) if (r.re.test(text)) findings.push({ rule: r.id, file: f, line })
  const g = text.match(GENERIC)
  if (g && !isPlaceholder(g[2])) findings.push({ rule: 'generic-secret-assignment', file: f, line })
}

if (findings.length === 0) {
  console.log('check-secrets: clean')
  process.exit(0)
}
console.error('check-secrets: ' + findings.length + ' 处疑似密钥（值已隐去）：')
for (const x of findings) console.error(`  [${x.rule}] ${x.file}:${x.line}`)
console.error('\n确认是真凭据请移除并改用环境变量/本机登录态；误报请收窄该行或走例外。')
process.exit(1)
