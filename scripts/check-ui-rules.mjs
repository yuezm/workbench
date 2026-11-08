#!/usr/bin/env node
// check-ui-rules.mjs — 守护 docs/specs/SPEC-ui.md 的硬规则。
// 用法: node scripts/check-ui-rules.mjs
// 退出码: 0 通过 / 1 有违规
//
// 检查六类：
//   1. 圆角越界：rounded-3xl、任意值 rounded-[..px]、非圆形元素用 rounded-full
//   2. 重玻璃：src/renderer 内除弹窗遮罩外不允许 backdrop-blur
//   3. 颜色字面量：tsx 里出现的 #rrggbb 必须在 global.css 的调色板里
//   4. token 体检：圆角刻度未被放大、前景三级对比度达标（含 surface / surface-2）
//   5. 字阶：只允许 page/title/body/action/meta/badge 六档，禁任意 px、裸 text-xs/sm、
//      零散字距与行高覆盖、semibold/bold（页面标题例外）
//   6. 表单校验静默失败：调色板外的 Tailwind 内置色（red-400 之类）与
//      `if (!x.trim()) return` 这类「点了没反应」的静默校验
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const RENDERER = join(ROOT, 'src', 'renderer')
const CSS = join(RENDERER, 'src', 'shell', 'styles', 'global.css')
const DIALOG = 'src/renderer/src/components/ui/dialog.tsx'

const findings = []
const flag = (rule, file, detail) => findings.push({ rule, file, detail })

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(tsx|ts)$/.test(path)) out.push(path)
  }
  return out
}
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

const css = readFileSync(CSS, 'utf8')

// 调色板：#rrggbb 全部来源都在 global.css 的 @theme 块里
const palette = new Set((css.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase()))
if (palette.size === 0) flag('palette-missing', rel(CSS), '没有解析到任何 #rrggbb token')

const tokenOf = (name) => {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

// 圆角刻度：只允许收紧，不允许悄悄放大
const RADIUS_CAP = { sm: 4, md: 6, lg: 8, xl: 10, '2xl': 12 }
for (const [name, cap] of Object.entries(RADIUS_CAP)) {
  const raw = tokenOf(`radius-${name}`)
  const px = raw === null ? null : Number.parseFloat(raw)
  if (px === null || Number.isNaN(px)) flag('radius-token-missing', rel(CSS), `--radius-${name}`)
  else if (px > cap) flag('radius-too-large', rel(CSS), `--radius-${name}=${raw} > ${cap}px`)
}

// 前景对比度：ink ≥12、ink-dim ≥8、ink-faint ≥4.5（对 surface 与 surface-2）
const hexToRgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

const surfaces = ['surface', 'surface-2']
const foreground = [
  { token: 'ink', min: 12 },
  { token: 'ink-dim', min: 8 },
  { token: 'ink-faint', min: 4.5 },
]
for (const { token, min } of foreground) {
  const fg = tokenOf(`color-${token}`)
  if (fg === null || !/^#[0-9a-fA-F]{6}$/.test(fg)) {
    flag('foreground-token-missing', rel(CSS), `--color-${token}`)
    continue
  }
  for (const surface of surfaces) {
    const bg = tokenOf(`color-${surface}`)
    if (bg === null) {
      flag('surface-token-missing', rel(CSS), `--color-${surface}`)
      continue
    }
    const ratio = contrast(fg, bg)
    if (ratio < min) {
      flag(
        'contrast-too-low',
        rel(CSS),
        `--color-${token} on ${surface} = ${ratio.toFixed(2)}:1 < ${min}:1`,
      )
    }
  }
}

// 圆形白名单：圆点、开关滑块、线段端点。矩形块不允许 rounded-full
const CIRCLE_HINTS = ['size-', 'h-0.5', 'w-9', 'blur-']
const HEX = /#[0-9a-fA-F]{3,8}\b/g

// 字阶：六档固定值，行高成对；组件只许引用语义档
const TYPE_SCALE = { page: 15, title: 14, body: 13, action: 13, meta: 11, badge: 10 }
for (const [name, px] of Object.entries(TYPE_SCALE)) {
  const size = tokenOf(`text-${name}`)
  const height = tokenOf(`text-${name}--line-height`)
  if (size === null) flag('type-token-missing', rel(CSS), `--text-${name}`)
  else if (Number.parseFloat(size) !== px) {
    flag('type-token-drift', rel(CSS), `--text-${name}=${size}，应为 ${px}px`)
  }
  if (height === null) flag('type-token-missing', rel(CSS), `--text-${name}--line-height`)
}

/** 显示型大字与计时数字字距：只在番茄钟计时器里出现 */
const TYPE_EXEMPT = new Set(['src/renderer/src/apps/pomodoro/components/TimerDisplay.tsx'])
/** 页面标题是唯一允许 semibold 的位置 */
const WEIGHT_EXEMPT = new Set(['src/renderer/src/apps/ai-workflow/AiWorkflowPage.tsx'])
const RAW_SIZE = /\btext-(?:xs|sm|base|lg|xl|2xl|3xl)\b/
const ARBITRARY_SIZE = /\btext-\[[0-9.]+px\]/
const TRACKING = /\btracking-(?!normal)\S+/
const LEADING = /\bleading-(?:relaxed|snug|tight|loose)\b/
const HEAVY_WEIGHT = /\bfont-(?:semibold|bold)\b/

for (const file of walk(RENDERER)) {
  const path = rel(file)
  const exempt = TYPE_EXEMPT.has(path)
  const source = readFileSync(file, 'utf8')
  source.split('\n').forEach((line, index) => {
    const at = `L${index + 1}: ${line.trim().slice(0, 100)}`
    if (RAW_SIZE.test(line)) flag('type-raw-size', path, at)
    if (!exempt && ARBITRARY_SIZE.test(line)) flag('type-arbitrary-size', path, at)
    if (!exempt && TRACKING.test(line)) flag('type-tracking', path, at)
    if (LEADING.test(line)) flag('type-leading', path, at)
    if (HEAVY_WEIGHT.test(line) && !WEIGHT_EXEMPT.has(path)) flag('type-heavy-weight', path, at)
  })
}

// 调色板外的 Tailwind 内置色（SPEC-ui §2：只用 token 类名）。`white` / `black` 不算
// 调色板外色值：SPEC 明确允许 `bg-white/[0.06]` 这类描边与遮罩。
const BUILTIN_COLOR =
  /\b(?:text|bg|border|ring|ring-offset|from|to|via|fill|stroke|outline|divide|accent|placeholder|caret|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/

// 静默校验（SPEC-ui §11）：`if (!title.trim()) return` 让点击毫无反馈，禁止
const SILENT_GUARD = /if\s*\(\s*![^)]*\.trim\(\)\s*\)\s*return\b/

for (const file of walk(RENDERER)) {
  const path = rel(file)
  const source = readFileSync(file, 'utf8')
  source.split('\n').forEach((line, index) => {
    if (/\brounded-(3xl)\b/.test(line) || /\brounded-\[[^\]]*\]/.test(line)) {
      flag('radius-out-of-scale', path, `L${index + 1}: ${line.trim().slice(0, 100)}`)
    }
    if (line.includes('rounded-full') && !CIRCLE_HINTS.some((hint) => line.includes(hint))) {
      flag('radius-full-on-box', path, `L${index + 1}: ${line.trim().slice(0, 100)}`)
    }
    if (line.includes('backdrop-blur') && path !== DIALOG) {
      flag('heavy-glass', path, `L${index + 1}: ${line.trim().slice(0, 100)}`)
    }
    for (const hex of line.match(HEX) ?? []) {
      if (!palette.has(hex.toLowerCase())) {
        flag('off-palette-color', path, `L${index + 1}: ${hex}`)
      }
    }
    if (BUILTIN_COLOR.test(line)) {
      flag('off-palette-utility', path, `L${index + 1}: ${line.trim().slice(0, 100)}`)
    }
    if (SILENT_GUARD.test(line)) {
      flag('silent-validation-guard', path, `L${index + 1}: ${line.trim().slice(0, 100)}`)
    }
  })
}

if (findings.length === 0) {
  console.log('check-ui-rules: clean')
  process.exit(0)
}
console.error(`check-ui-rules: ${findings.length} 处违反 SPEC-ui.md：`)
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.detail}`)
console.error('\n规则见 docs/specs/SPEC-ui.md；改样式，不改规则。')
process.exit(1)
