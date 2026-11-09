#!/usr/bin/env node
// check-ui-rules.mjs — 守护 shadcn/ui 基线 + 项目覆盖层（docs/specs/SPEC-ui.md）。
// 用法: node scripts/check-ui-rules.mjs
// 退出码: 0 通过 / 1 有违规
//
// 基线（shadcn/ui v4）：
//   1. 只用语义 token 类名（background / foreground / card / popover / primary /
//      secondary / muted / accent / destructive / border / input / ring）+ 项目扩展
//      token（faint-foreground / brand / success / info / warning）
//   2. 零调色板外色值、零 Tailwind 内置色类名
//   3. 无重玻璃（backdrop-blur）
//   4. 圆角只走刻度：任意值圆角仅允许 ≤4px 或 inherit（上游 checkbox/tooltip/scroll-area 用法）
//   5. 字号不写任意 px（唯一豁免：番茄钟计时器）；字重不用 bold
//   6. 圆角基数封顶：--radius ≤ 0.5rem（macOS 小圆角，刻度由 Tailwind 派生）
//
// 覆盖层（docs/specs/SPEC-ui.md）：
//   6. 前景对比度下限：foreground≥12 / muted-foreground≥8 / faint-foreground≥4.5 /
//      brand≥4.5（对 card 与 muted 两个底色；light / dark 两套主题分别校验）
//   7. 表单校验静默失败守卫：`if (!x.trim()) return` 这类「点了没反应」
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const RENDERER = join(ROOT, 'src', 'renderer')
const CSS = join(RENDERER, 'src', 'shell', 'styles', 'global.css')

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

// 调色板：#rrggbb 全部来源都在 global.css 的主题块里（亮色 `:root, .light` 与暗色 `.dark`）
const palette = new Set((css.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase()))
if (palette.size === 0) flag('palette-missing', rel(CSS), '没有解析到任何 #rrggbb token')

const tokenOf = (name) => {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

/**
 * 顶层规则扫描：把 CSS 拆成 { selector, body } 列表。
 * 花括号配对取块体，块内嵌套规则整体归入该块。
 */
const topLevelRules = (source) => {
  const rules = []
  let start = 0
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '{') {
      const selector = source.slice(start, i)
      let depth = 0
      let j = i
      for (; j < source.length; j++) {
        if (source[j] === '{') depth++
        else if (source[j] === '}') {
          depth--
          if (depth === 0) break
        }
      }
      rules.push({ selector, body: source.slice(i + 1, j) })
      i = j + 1
      start = i
      continue
    }
    // 顶层分号（@import / @custom-variant 等）结束当前选择器
    if (ch === '}') {
      i++
      start = i
      continue
    }
    if (ch === ';') {
      i++
      start = i
      continue
    }
    i++
  }
  return rules
}

/** 选择器列表：按逗号拆分（注释已在解析前剥掉） */
const selectorList = (selector) =>
  selector
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

/** 规则块里取 `--name: value;` 的值 */
const tokenIn = (body, name) => {
  const m = body.match(new RegExp(`--${name}:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

// 解析前先剥掉注释，免得注释里的花括号把配对算歪
const rules = topLevelRules(css.replace(/\/\*[\s\S]*?\*\//g, ''))

/**
 * 主题块：亮色写在 `:root, .light`，暗色写在 `.dark`。
 * 两套主题的语义名一致、只有值不同，所以对比度必须各查各的。
 */
const themeBodies = (() => {
  const lightRule = rules.find((rule) => selectorList(rule.selector).includes(':root'))
  const lightSelectors = lightRule ? selectorList(lightRule.selector) : []
  const darkRule = rules.find(
    (rule) =>
      selectorList(rule.selector).length === 1 && selectorList(rule.selector)[0] === '.dark',
  )
  return {
    // 亮色块必须同时挂 `:root` 与 `.light`：少了 `.light` 时 class 切换不到亮色
    light:
      lightSelectors.includes(':root') && lightSelectors.includes('.light')
        ? (lightRule?.body ?? null)
        : null,
    dark: darkRule?.body ?? null,
  }
})()

// ── 基线：圆角基数封顶（刻度由 Tailwind 从 --radius 派生，不再单档手写）─────
const radiusRaw = tokenOf('radius')
if (radiusRaw === null) {
  flag('radius-token-missing', rel(CSS), '--radius')
} else {
  const radiusPx = Number.parseFloat(radiusRaw) * (radiusRaw.includes('rem') ? 16 : 1)
  if (!Number.isNaN(radiusPx) && radiusPx > 8) {
    flag('radius-too-large', rel(CSS), `--radius=${radiusRaw} > 8px`)
  }
}

// ── 覆盖层：前景对比度下限 ────────────────────────────────────────────────
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

const surfaces = ['card', 'muted']
const foreground = [
  { token: 'foreground', min: 12 },
  { token: 'muted-foreground', min: 8 },
  { token: 'faint-foreground', min: 4.5 },
  { token: 'brand', min: 4.5 },
]
// 两套主题分别校验：亮色写在 `:root, .light`，暗色写在 `.dark`，
// 违规信息里带主题名，避免「改了暗色却在亮色上翻车」这类盲区。
for (const [theme, body] of [
  ['light', themeBodies.light],
  ['dark', themeBodies.dark],
]) {
  if (body === null) {
    flag('theme-block-missing', rel(CSS), `${theme} 主题块缺失`)
    continue
  }
  for (const { token, min } of foreground) {
    const fg = tokenIn(body, token)
    if (fg === null || !/^#[0-9a-fA-F]{6}$/.test(fg)) {
      flag('foreground-token-missing', rel(CSS), `--${token} (${theme})`)
      continue
    }
    for (const surface of surfaces) {
      const bg = tokenIn(body, surface)
      if (bg === null) {
        flag('surface-token-missing', rel(CSS), `--${surface} (${theme})`)
        continue
      }
      const ratio = contrast(fg, bg)
      if (ratio < min) {
        flag(
          'contrast-too-low',
          rel(CSS),
          `--${token} on --${surface} (${theme}) = ${ratio.toFixed(2)}:1 < ${min}:1`,
        )
      }
    }
  }
}

// ── 基线：类名规则 ───────────────────────────────────────────────────────
/** 调色板外的 Tailwind 内置色（shadcn 只用语义 token + white/black） */
const BUILTIN_COLOR =
  /\b(?:text|bg|border|ring|ring-offset|from|to|via|fill|stroke|outline|divide|accent|placeholder|caret|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?\b/

/** 静默校验（SPEC-ui §11）：`if (!title.trim()) return` 让点击毫无反馈，禁止 */
const SILENT_GUARD = /if\s*\(\s*![^)]*\.trim\(\)\s*\)\s*return\b/

/** 任意 px 字号：唯一豁免是番茄钟计时器（等宽数字） */
const TYPE_EXEMPT = new Set(['src/renderer/src/apps/pomodoro/components/TimerDisplay.tsx'])
const ARBITRARY_SIZE = /\btext-\[[0-9.]+px\]/
/** 粗体：shadcn 用 medium / semibold，不用 bold */
const BOLD_WEIGHT = /\bfont-(?:bold|extrabold|black)\b/

/**
 * 任意圆角：只允许 ≤4px 或 inherit。
 * 上游 shadcn 用了三种：checkbox `rounded-[4px]`、tooltip `rounded-[2px]`、
 * scroll-area `rounded-[inherit]`；再大就脱离刻度。
 */
const ARBITRARY_RADIUS = /\brounded-\[([^\]]+)\]/g

// ── 基线：语义 token 类名必须真有对应变量 ─────────────────────────────────
// 背景：token 改名（warn→warning、line→border 等）后，源码里残留的旧类名不会报错，
// 只是静默失效（`bg-line` 没有任何背景色）。这类问题 build 与 lint 都发现不了。
// 做法：把 global.css 里定义过的 `--color-*` 变量收集成白名单，源码里出现的
// 「颜色位置 + 语义名」必须命中白名单或 Tailwind 内置色，否则报 orphan-token-utility。
//
// 判定只看「颜色位置」：bg- / ring- / fill- / stroke- / outline- / from- / to- /
// via- / divide- / decoration- / caret- / accent- / shadow- / text- / border-。
// 其中 text-* 与 border-* 的首段也可能是非颜色效用（字号档位、描边方向/样式），
// 用下面的排除表挡掉。
/** 颜色位置的前缀表：这些位置上的名字才可能是颜色 */
const COLOR_SLOT = [
  'bg',
  'ring',
  'fill',
  'stroke',
  'outline',
  'from',
  'to',
  'via',
  'divide',
  'decoration',
  'caret',
  'accent',
  'shadow',
  'text',
  'border',
]
/** Tailwind 自带色与中性色：不是语义 token，由 off-palette-utility 另行拦截 */
const BUILTIN_TOKENS = new Set([
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'white',
  'black',
  'transparent',
  'current',
  'inherit',
])
/** 明确不是颜色的名字（Tailwind 效用），命中即跳过 */
const NON_COLOR_NAMES = new Set([
  // 字号档位
  'xs',
  'sm',
  'base',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '9xl',
  // 阴影尺寸档位（shadow-md / shadow-2xs …）
  '2xs',
  'md',
  'inner',
  // 文本对齐
  'left',
  'center',
  'right',
  'justify',
  'start',
  'end',
  // 描边方向 / 样式 / 宽度
  't',
  'r',
  'b',
  'l',
  'x',
  'y',
  's',
  'e',
  'inline',
  'block',
  'collapse',
  'dashed',
  'dotted',
  'double',
  'hidden',
  'none',
  'solid',
  'y-reverse',
  // 描边与环的宽度修饰（border-2 / ring-4）
  '0',
  '1',
  '2',
  '3',
  '4',
  '8',
  // 分隔线方向
  'y',
  'reverse',
  // 阴影/环偏移与其它非颜色修饰
  'reverse',
  'offset',
  // 文本样式
  'ellipsis',
  'clip',
  'nowrap',
  'balance',
  'pretty',
  // outline 样式
  'outline-none',
  'outline',
  'solid',
  'dashed',
  'dotted',
  'double',
  // 背景定位
  'fixed',
  'local',
  'scroll',
  'clip-border',
  'clip-padding',
  'clip-content',
  'clip-text',
  // 渐变方向（Tailwind v4 仍用 gradient-to-*）
  'gradient-to-b',
  'gradient-to-t',
  'gradient-to-l',
  'gradient-to-r',
  'gradient-to-tl',
  'gradient-to-tr',
  'gradient-to-bl',
  'gradient-to-br',
  'linear-to-b',
  'linear-to-t',
  'linear-to-l',
  'linear-to-r',
  'linear-to-tl',
  'linear-to-tr',
  'linear-to-bl',
  'linear-to-br',
  // CSS 属性名（出现在 transition-[…] 之类任意值里）
  'dashoffset',
  'opacity',
  'transform',
  'color',
  'background',
  'border-color',
  'fill',
  'stroke',
  'width',
  'height',
  'scale',
  'rotate',
  'translate',
  'blur',
])

/** global.css 里 @theme 映射出的 --color-* 变量（即合法的语义 token 名） */
const definedColorTokens = new Set()
for (const m of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) definedColorTokens.add(m[1])

/** 扫一行里的「颜色位置 + 名字」，返回真正可疑的孤儿 token */
const orphanTokensIn = (line) => {
  const found = []
  // 注释行里的说明文字不是类名
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return found
  for (const prefix of COLOR_SLOT) {
    // 位置前缀边界：前面不能是字母或 -（避免把 `hover:text-` 里的 hover 当前缀）
    const re = new RegExp(
      `(?<![a-z0-9-])${prefix}-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![a-z0-9-])`,
      'g',
    )
    for (const m of line.matchAll(re)) {
      const name = m[1]
      // CSS 变量引用（--radix-select-content-available-height 之类）不是类名
      if (name.startsWith('-')) continue
      if (BUILTIN_TOKENS.has(name)) continue
      if (NON_COLOR_NAMES.has(name)) continue
      // 方向/宽度修饰：border-l-warning、border-t-2 → 逐段找颜色段
      const parts = name.split('-')
      if (parts.some((p) => definedColorTokens.has(p))) continue
      // 整名与末段都命中过 → 合法；这里走到说明任一段都不是已知 token
      if (definedColorTokens.has(name) || definedColorTokens.has(parts[parts.length - 1])) continue
      // 全是数字或方向词 → 不是颜色（border-l-2 / border-t-4）
      if (parts.every((p) => /^\d+$/.test(p) || NON_COLOR_NAMES.has(p))) continue
      found.push(m[0])
    }
  }
  return found
}

for (const file of walk(RENDERER)) {
  const path = rel(file)
  const exempt = TYPE_EXEMPT.has(path)
  const source = readFileSync(file, 'utf8')
  source.split('\n').forEach((line, index) => {
    const at = `L${index + 1}: ${line.trim().slice(0, 100)}`
    if (/\brounded-(3xl|4xl)\b/.test(line)) flag('radius-out-of-scale', path, at)
    for (const m of line.matchAll(ARBITRARY_RADIUS)) {
      const value = m[1]
      const px = Number.parseFloat(value)
      if (value !== 'inherit' && (Number.isNaN(px) || px > 4)) {
        flag('radius-out-of-scale', path, at)
      }
    }
    if (line.includes('backdrop-blur')) flag('heavy-glass', path, at)
    for (const hex of line.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) {
      if (!palette.has(hex.toLowerCase())) flag('off-palette-color', path, `${at} ${hex}`)
    }
    if (BUILTIN_COLOR.test(line)) flag('off-palette-utility', path, at)
    if (!exempt && ARBITRARY_SIZE.test(line)) flag('type-arbitrary-size', path, at)
    if (BOLD_WEIGHT.test(line)) flag('type-heavy-weight', path, at)
    if (SILENT_GUARD.test(line)) flag('silent-validation-guard', path, at)
    for (const util of orphanTokensIn(line)) {
      flag('orphan-token-utility', path, `${at} ${util}`)
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
