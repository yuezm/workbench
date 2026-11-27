#!/usr/bin/env node
/**
 * doc-lint.mjs — 文档结构与冗余体检器（零依赖）
 *
 * 用法:
 *   node tools/doc-lint.mjs [docsDir=docs] [--json] [--max-lines=300] [--max-cell=80]
 *
 * 退出码: 0 无 error；1 有 error；2 路径不存在
 *
 * 设计约束:
 * - 只读，不改文件。
 * - 每个判定对应一条可执行规则（见 docs/README.md 的「文档规则」表）。
 * - 行数按正文算（不含 frontmatter）；索引类文件按自身预算判。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flags = new Map(
  argv
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.split('=')
      return [k.replace(/^--/, ''), v ?? 'true']
    }),
)
const ROOT = resolve(argv.find((a) => !a.startsWith('--')) ?? 'docs')
const JSON_OUT = flags.has('json')

const BUDGET = {
  maxLines: Number(flags.get('max-lines') ?? 300),
  maxBytes: 40 * 1024,
  maxLine: Number(flags.get('max-line') ?? 120),
  hardLine: 200,
  maxCell: Number(flags.get('max-cell') ?? 80),
  indexLines: 120,
}

const META_TALK = [
  '值得注意的是',
  '综上所述',
  '不难看出',
  '需要强调',
  '从某种意义上',
  '换言之',
  '换句话说',
  '也就是说',
  '本节将',
  '本文中',
  '本节介绍',
  '本文介绍',
  '下面介绍',
  '接下来我们',
  '如上所述',
  '如前所述',
  '总而言之',
  '简而言之',
]
const VAGUE = ['适当', '尽量', '尽可能', '视情况', '酌情', '必要时应', '等等等']
const REQUIRED_FM = ['type', 'status', 'owner', 'updated']
const TYPES = new Set([
  'tutorial',
  'how-to',
  'reference',
  'explanation',
  'spec',
  'plan',
  'adr',
  'review',
  'history',
  'index',
])
const STATUS = new Set(['draft', 'active', 'deprecated', 'archived'])

const findings = []
const add = (level, rule, file, line, msg) => findings.push({ level, rule, file, line, msg })

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.isFile() && e.name.endsWith('.md')) acc.push(p)
  }
  return acc
}

if (!existsSync(ROOT)) {
  console.error(`no such dir: ${ROOT}`)
  process.exit(2)
}

const files = walk(ROOT)
const h2Owners = new Map()
const paragraphOwners = new Map()

for (const abs of files) {
  const rel = relative(ROOT, abs).replaceAll('\\', '/')
  const raw = readFileSync(abs, 'utf8')
  const lines = raw.split('\n')
  const bytes = statSync(abs).size

  // ---------- frontmatter ----------
  let fm = null
  let bodyStart = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) {
      fm = {}
      bodyStart = end + 1
      for (const l of lines.slice(1, end)) {
        const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l)
        if (m) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
      }
    }
  }
  if (!fm) add('error', 'fm-missing', rel, 1, '缺少 YAML frontmatter（type/status/owner/updated）')
  else {
    for (const k of REQUIRED_FM)
      if (!fm[k]) add('error', 'fm-field-missing', rel, 1, `frontmatter 缺 ${k}`)
    if (fm.type && !TYPES.has(fm.type))
      add('error', 'fm-type-invalid', rel, 1, `type=${fm.type} 不在 ${[...TYPES].join('|')}`)
    if (fm.status && !STATUS.has(fm.status))
      add('error', 'fm-status-invalid', rel, 1, `status=${fm.status} 不在 ${[...STATUS].join('|')}`)
    if (fm.updated && !/^\d{4}-\d{2}-\d{2}$/.test(fm.updated))
      add('warn', 'fm-date-format', rel, 1, `updated=${fm.updated} 非 YYYY-MM-DD`)
  }

  // ---------- 体积（正文行，不含 frontmatter）----------
  const bodyLines = lines.length - bodyStart
  if (bodyLines > BUDGET.maxLines)
    add('error', 'size-lines', rel, bodyStart + 1, `正文 ${bodyLines} 行 > 预算 ${BUDGET.maxLines}`)
  if (bytes > BUDGET.maxBytes)
    add(
      'warn',
      'size-bytes',
      rel,
      1,
      `${(bytes / 1024).toFixed(0)}KB > 预算 ${BUDGET.maxBytes / 1024}KB`,
    )
  if (fm?.type === 'index' && lines.length > BUDGET.indexLines) {
    add(
      'error',
      'index-too-long',
      rel,
      1,
      `索引 ${lines.length} 行 > ${BUDGET.indexLines}，读者找不到东西`,
    )
  }

  // ---------- 行扫描（跳过代码块）----------
  let inFence = false
  let prevLevel = 0
  const h1 = []
  const body = []
  lines.forEach((l, i) => {
    if (i < bodyStart) return
    if (/^\s*(```|~~~)/.test(l)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    body.push(l)

    const m = /^(#{1,6})\s+(.*)$/.exec(l)
    if (m) {
      const level = m[1].length
      if (level === 1) h1.push(i + 1)
      if (level > 1 && prevLevel && level > prevLevel + 1)
        add('warn', 'heading-jump', rel, i + 1, `h${prevLevel} → h${level} 跳级`)
      if (level === 2) {
        const t = m[2].trim()
        if (!h2Owners.has(t)) h2Owners.set(t, [])
        h2Owners.get(t).push(rel)
      }
      prevLevel = level
      return
    }

    if (l.length > BUDGET.hardLine)
      add('error', 'line-too-long', rel, i + 1, `${l.length} 字符 > ${BUDGET.hardLine}`)
    else if (l.length > BUDGET.maxLine)
      add('warn', 'line-long', rel, i + 1, `${l.length} 字符 > ${BUDGET.maxLine}`)

    const isTable = l.trimStart().startsWith('|')
    if (isTable) {
      const cells = l.split('|').slice(1, -1)
      const worst = cells.reduce((a, b) => (b.length > a.length ? b : a), '')
      if (worst.length > BUDGET.maxCell)
        add('error', 'cell-too-long', rel, i + 1, `单元格 ${worst.length} 字符 > ${BUDGET.maxCell}`)
      if (cells.filter((c) => c.trim().length > 0).length > 6)
        add('warn', 'table-too-wide', rel, i + 1, `${cells.length} 列，宽表难读`)
      return
    }

    // 词表：索引/规则元文档本身要写这些词当反例，跳过
    if (fm?.type !== 'index') {
      for (const w of META_TALK)
        if (l.includes(w)) add('warn', 'meta-talk', rel, i + 1, `元话语「${w}」`)
      for (const w of VAGUE)
        if (l.includes(w)) add('warn', 'vague-word', rel, i + 1, `模糊词「${w}」`)
    }
  })

  if (h1.length === 0) add('error', 'h1-missing', rel, 1, '没有 H1')
  if (h1.length > 1)
    add('error', 'h1-multi', rel, h1[1], `H1 出现 ${h1.length} 次（第 ${h1.join(', ')} 行）`)

  // ---------- 跨文件逐字重复段落（抄录真相源的气味）----------
  let fence = false
  for (const p of body) {
    if (/^\s*(```|~~~)/.test(p)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const t = p.trim()
    if (t.length < 120) continue
    if (t.startsWith('|') || /^[-*+>]/.test(t) || /^\d+\./.test(t)) continue
    if (!paragraphOwners.has(t)) paragraphOwners.set(t, [])
    paragraphOwners.get(t).push(rel)
  }

  // ---------- 链接 ----------
  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g
  let mm
  while ((mm = linkRe.exec(raw)) !== null) {
    const target = mm[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const clean = target.split('#')[0]
    if (!clean) continue
    const p = resolve(dirname(abs), clean)
    if (!existsSync(p)) {
      const ln = raw.slice(0, mm.index).split('\n').length
      add('error', 'link-broken', rel, ln, `链接目标不存在: ${target}`)
    }
  }

  // ---------- 生命周期 ----------
  if (fm?.type === 'plan' && fm?.status === 'archived' && !/[\\/]archive[\\/]/.test(abs)) {
    add('warn', 'archive-misplaced', rel, 1, 'plan 标 archived 但不在 archive/ 下')
  }
  if (fm?.status === 'active' && /[\\/]archive[\\/]/.test(abs)) {
    add('error', 'archive-mismatch', rel, 1, '在 archive/ 下但 status=active')
  }
}

for (const [title, owners] of h2Owners) {
  const uniq = [...new Set(owners)]
  if (uniq.length >= 3)
    add(
      'warn',
      'heading-duplicate',
      uniq[0],
      0,
      `标题「${title}」在 ${uniq.length} 个文件复用: ${uniq.slice(0, 4).join(', ')}`,
    )
}
for (const [text, owners] of paragraphOwners) {
  const uniq = [...new Set(owners)]
  if (uniq.length >= 2) {
    add(
      'warn',
      'dup-paragraph',
      uniq[1],
      0,
      `同一段落逐字出现在 ${uniq.join(' / ')}：${text.slice(0, 60)}…`,
    )
  }
}

if (!existsSync(join(ROOT, 'README.md')))
  add('error', 'index-missing', 'README.md', 0, 'docs/README.md 不存在：没有唯一入口')

const errors = findings.filter((f) => f.level === 'error')
const warns = findings.filter((f) => f.level === 'warn')
const byRule = new Map()
for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1)

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        root: ROOT,
        files: files.length,
        errors: errors.length,
        warns: warns.length,
        byRule: Object.fromEntries([...byRule].sort((a, b) => b[1] - a[1])),
        findings,
      },
      null,
      2,
    ),
  )
} else {
  console.log(`docs 根: ${ROOT}  文件: ${files.length}`)
  console.log(`error ${errors.length} / warn ${warns.length}\n按规则:`)
  for (const [r, n] of [...byRule].sort((a, b) => b[1] - a[1]))
    console.log(`  ${r.padEnd(20)} ${n}`)
  console.log('\n明细:')
  for (const f of [...errors, ...warns].slice(0, 60))
    console.log(`  [${f.level}] ${f.file}:${f.line} ${f.rule} — ${f.msg}`)
  if (findings.length > 60) console.log(`  … 共 ${findings.length} 条，--json 看全量`)
}
process.exitCode = errors.length > 0 ? 1 : 0
