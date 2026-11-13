/**
 * 界面几何审计（人工验收前的「对齐 / 溢出 / 遮挡」自动检查）。
 *
 * 由来：`check:ui` 只做静态类名检查（圆角、色值、对比度、字阶），**看不见布局结果**；
 * 「这一行图标和文字没对齐」「弹窗被裁掉一半」「两栏左边缘差 2px」这类问题只能靠人眼，
 * 于是反复漏到人工验收。这里把「人眼能看出的几何错」变成可复现的断言。
 *
 * 判据（只保留**明确是缺陷**的几类，避免把设计选择当 bug）：
 *
 * - `h-scroll`       文档出现横向滚动（整页宽于视口）
 * - `offscreen`      元素越出视口，且祖先链里没有可滚动容器（滚也看不到）
 * - `clipped`        元素被 `overflow:hidden|clip` 祖先裁掉（祖先该方向不可滚动）
 * - `row-misaligned` 横向 flex + `align-items:center` 的行里，子元素垂直中心线不一致
 * - `overlap`        两个可交互元素互相遮挡（点不到 / 点错）
 * - `text-overflow`  文本撑出容器（`overflow:visible` 时会压到相邻元素上）
 * - `tiny-target`    可交互元素小于 24×24（点不准）
 *
 * 审计脚本以**字符串**形式注入页面：`tsconfig.node.json` 的 `lib` 不含 DOM，
 * 写成 TS 回调会因 `document` / `getComputedStyle` 未定义而类型报错（仓库既有做法见
 * `tests/e2e/agent-dialog.spec.ts` 的尺寸断言）。
 */
import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type GeometryKind =
  | 'h-scroll'
  | 'offscreen'
  | 'clipped'
  | 'row-misaligned'
  | 'overlap'
  | 'text-overflow'
  | 'tiny-target'

export interface GeometryFinding {
  kind: GeometryKind
  /** 出问题的元素（tag.class[aria-label] 路径 + 文本片段），直接能定位 */
  selector: string
  detail: string
}

/** 一屏审计结果：场景名 + 该场景下的全部几何问题 */
export interface GeometryScene {
  label: string
  findings: GeometryFinding[]
}

const AUDIT_SCRIPT = String.raw`
(() => {
  const issues = []

  const describe = (el) => {
    if (!el) return '<unknown>'
    const parts = []
    let cur = el
    let depth = 0
    while (cur && cur.nodeType === 1 && depth < 4) {
      let s = cur.tagName.toLowerCase()
      const cls = (cur.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)
      if (cls.length > 0) s += '.' + cls.slice(0, 3).join('.')
      const aria = cur.getAttribute('aria-label')
      if (aria) s += '[aria-label="' + aria.slice(0, 24) + '"]'
      else if (cur.getAttribute('role')) s += '[role="' + cur.getAttribute('role') + '"]'
      parts.unshift(s)
      cur = cur.parentElement
      depth += 1
    }
    const own = (el.textContent || '').trim().replace(/\s+/g, ' ')
    return parts.join(' > ') + (own ? ' "' + own.slice(0, 30) + '"' : '')
  }

  const push = (kind, el, detail) => issues.push({ kind, selector: describe(el), detail })
  const round = (n) => Math.round(n * 10) / 10

  const vw = window.innerWidth
  const vh = window.innerHeight
  const docEl = document.documentElement

  const isVisible = (el) => {
    const st = getComputedStyle(el)
    if (st.display === 'none' || st.visibility === 'hidden') return false
    if (Number(st.opacity || '1') < 0.05) return false
    const r = el.getBoundingClientRect()
    return r.width > 0.5 && r.height > 0.5
  }

  /** 祖先链里是否有可滚动容器（能滚到就不算越出视口） */
  const hasScrollableAncestor = (el) => {
    let cur = el.parentElement
    while (cur && cur !== docEl) {
      const st = getComputedStyle(cur)
      const scrollable = /(auto|scroll|overlay)/.test(st.overflowX + ' ' + st.overflowY)
      if (scrollable) return true
      cur = cur.parentElement
    }
    return false
  }

  /**
   * 最近的裁剪祖先（overflow hidden / clip）。
   * position:fixed 的元素不被祖先裁剪，遇到即停；overflow:auto|scroll 的内容能滚到，不算裁。
   */
  const clippingAncestor = (el) => {
    let cur = el.parentElement
    while (cur && cur !== document.body && cur !== docEl) {
      const st = getComputedStyle(cur)
      if (st.position === 'fixed') return null
      // 祖先链上先遇到可滚动容器就停：内容滚得到，不算被裁（页面里大量
      // overflow-hidden 外壳套着可滚动内容区，不先判滚动会把正常滚出视口的内容全报成裁切）
      if (/(auto|scroll|overlay)/.test(st.overflowX + ' ' + st.overflowY)) return null
      const hiddenX = /(hidden|clip)/.test(st.overflowX)
      const hiddenY = /(hidden|clip)/.test(st.overflowY)
      if (hiddenX || hiddenY) return { el: cur, hiddenX, hiddenY, st }
      cur = cur.parentElement
    }
    return null
  }

  const hasDirectText = (el) => {
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && (node.nodeValue || '').trim() !== '') return true
    }
    return false
  }

  const isSvgInner = (el) => el.namespaceURI === 'http://www.w3.org/2000/svg'

  // 1) 整页横向滚动：任何一屏出现都是布局缺陷
  if (docEl.scrollWidth > vw + 1) {
    push('h-scroll', docEl, '文档 scrollWidth ' + docEl.scrollWidth + ' > 视口 ' + vw)
  }

  const all = Array.from(document.body.querySelectorAll('*'))
  for (const el of all) {
    if (isSvgInner(el)) continue
    if (!isVisible(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const st = getComputedStyle(el)
    // 全屏遮罩（modal overlay）本来就覆盖视口，不参与越界判定
    const fullscreen = r.width >= vw - 1 && r.height >= vh - 1
    if (fullscreen) continue

    // 2) 越出视口且滚不到
    if (!hasScrollableAncestor(el)) {
      if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) {
        push(
          'offscreen',
          el,
          '矩形 (' + round(r.left) + ',' + round(r.top) + ',' + round(r.right) + ',' + round(r.bottom) +
            ') 越出视口 ' + vw + 'x' + vh,
        )
        continue
      }
    }

    // 3) 被裁剪祖先切掉
    const clip = clippingAncestor(el)
    if (clip) {
      const cr = clip.el.getBoundingClientRect()
      // 走到这里说明祖先链上没有可滚动容器（clippingAncestor 提前返回了），
      // 因此 hidden / clip 方向的溢出就是「用户滚不到、也点不到」的裁切
      const truncating = st.textOverflow === 'ellipsis' && /nowrap/.test(st.whiteSpace)
      const overRight = r.right - cr.right
      const overLeft = cr.left - r.left
      const overBottom = r.bottom - cr.bottom
      const overTop = cr.top - r.top
      const badX = clip.hiddenX && !truncating && (overRight > 1.5 || overLeft > 1.5)
      const badY = clip.hiddenY && (overBottom > 1.5 || overTop > 1.5)
      if (badX || badY) {
        push(
          'clipped',
          el,
          '超出裁剪祖先 ' + describe(clip.el).slice(0, 70) +
            '（右 ' + round(overRight) + ' 左 ' + round(overLeft) +
            ' 下 ' + round(overBottom) + ' 上 ' + round(overTop) + '）',
        )
      }
    }

    // 4) 文本撑出容器（不裁切的容器会把文字压到相邻元素上）
    if (
      hasDirectText(el) &&
      el.scrollWidth > el.clientWidth + 1 &&
      st.overflowX === 'visible' &&
      el.clientWidth > 0
    ) {
      push(
        'text-overflow',
        el,
        'scrollWidth ' + el.scrollWidth + ' > clientWidth ' + el.clientWidth,
      )
    }
  }

  // 5) 居中行里的子元素中心线不一致（「图标和文字没对齐」的机器判据）
  for (const el of all) {
    if (!isVisible(el)) continue
    const st = getComputedStyle(el)
    if (st.display !== 'flex') continue
    if (st.flexDirection !== 'row' && st.flexDirection !== 'row-reverse') continue
    if (st.alignItems !== 'center') continue
    const kids = []
    for (const kid of el.children) {
      if (!isVisible(kid)) continue
      const ks = getComputedStyle(kid)
      if (ks.position === 'absolute' || ks.position === 'fixed') continue
      if (ks.alignSelf !== 'auto' && ks.alignSelf !== 'center') continue
      const kr = kid.getBoundingClientRect()
      if (kr.width < 4 || kr.height < 4) continue
      kids.push({ el: kid, center: kr.top + kr.height / 2, height: kr.height })
    }
    if (kids.length < 2) continue
    const centers = kids.map((k) => k.center)
    const spread = Math.max.apply(null, centers) - Math.min.apply(null, centers)
    if (spread > 1.5) {
      const worst = kids.reduce((a, b) => (Math.abs(b.center - kids[0].center) > Math.abs(a.center - kids[0].center) ? b : a))
      push(
        'row-misaligned',
        el,
        '子元素垂直中心线相差 ' + round(spread) + 'px（' +
          kids.map((k) => round(k.center)).join(' / ') + '）；最偏 ' + describe(worst.el).slice(0, 70),
      )
    }
  }

  // 6) 可交互元素互相遮挡 / 太小点不到
  const INTERACTIVE = 'button,[role="button"],a[href],input,select,textarea'
  /** 原生隐藏控件（复选框 / 单选 / 隐藏域）不是点击目标：真实点击目标是它们的 label 或外壳 */
  const NATIVE_SKIP = /^(checkbox|radio|hidden)$/
  const targets = Array.from(document.querySelectorAll(INTERACTIVE)).filter((el) => {
    if (!isVisible(el)) return false
    // 无障碍隐藏的镜像控件（如 Radix Select 的原生 select）不参与
    if (el.closest('[aria-hidden="true"]')) return false
    const st = getComputedStyle(el)
    if (st.pointerEvents === 'none') return false
    if (el.tagName === 'INPUT' && NATIVE_SKIP.test((el.getAttribute('type') || 'text').toLowerCase())) {
      return false
    }
    const r = el.getBoundingClientRect()
    // 1x1 之类的量测桩 / 视觉隐藏控件
    if (r.width < 4 || r.height < 4) return false
    return true
  })
  const rects = targets.map((el) => ({ el, r: el.getBoundingClientRect() }))
  /**
   * 只比较「都在文档流里」的元素：自身或任一祖先被绝对/固定定位，说明它是浮层里的元素
   * （hover 操作条、下拉菜单、弹窗），压在父行上属于设计，不参与遮挡判定。
   */
  const inFlow = (el) => {
    let cur = el
    while (cur && cur !== document.body) {
      const position = getComputedStyle(cur).position
      if (position === 'absolute' || position === 'fixed') return false
      cur = cur.parentElement
    }
    return true
  }

  for (const item of rects) {
    const { el, r } = item
    const tooNarrow = r.width < 20
    const tooShort = r.height < 20
    if (tooNarrow || tooShort) {
      push('tiny-target', el, '点击目标 ' + round(r.width) + 'x' + round(r.height) + '（< 20）')
    }
  }

  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i]
      const b = rects[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      if (!inFlow(a.el) || !inFlow(b.el)) continue
      const overlapW = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const overlapH = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      if (overlapW <= 1 || overlapH <= 1) continue
      const overlapArea = overlapW * overlapH
      const minArea = Math.min(a.r.width * a.r.height, b.r.width * b.r.height)
      if (minArea <= 0) continue
      if (overlapArea / minArea < 0.5) continue
      push(
        'overlap',
        a.el,
        '与 ' + describe(b.el).slice(0, 70) + ' 重叠 ' + round((overlapArea / minArea) * 100) + '%',
      )
    }
  }

  return issues
})()
`

/** 等两帧，让入场动画 / 布局收敛后再量（`animate-rise` 期间量出来的是中间态） */
const SETTLE_SCRIPT = String.raw`
new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
})
`

/**
 * 审计器自检探针：四个**已知缺陷**的最小复现（居中行错位 / 被裁切 / 按钮重叠 / 点击目标过小）。
 *
 * 用页面自己的 CSS 引擎渲染，所以量的就是真几何。审计结果为空时，先跑探针——
 * 「零问题」必须能区分「界面干净」与「检测逻辑失效」，否则这条用例就是新的假绿来源。
 */
export const GEOMETRY_PROBE_SCRIPT = String.raw`
(() => {
  document.getElementById('__audit_probe')?.remove()
  const host = document.createElement('div')
  host.id = '__audit_probe'
  host.setAttribute(
    'style',
    'position:relative;z-index:2147483647;background:#fff;padding:4px;display:flex;flex-direction:column;gap:4px',
  )
  host.innerHTML = [
    // 居中行里一个子元素被推低 8px → row-misaligned
    '<div style="display:flex;align-items:center;gap:4px">',
    '<span style="display:block;width:20px;height:20px;background:#111"></span>',
    '<span style="display:block;width:20px;height:20px;margin-top:8px;background:#222"></span>',
    '</div>',
    // overflow:hidden 容器里 80px 高的子元素 → clipped
    '<div style="width:80px;height:30px;overflow:hidden">',
    '<div style="width:20px;height:80px;background:#333"></div>',
    '</div>',
    // 两个 60x30 按钮错位 40px → 重叠 66% → overlap
    '<div style="display:flex">',
    '<button type="button" style="width:60px;height:30px">A</button>',
    '<button type="button" style="width:60px;height:30px;margin-left:-40px">B</button>',
    '</div>',
    // 12x12 按钮 → tiny-target
    '<button type="button" style="width:12px;height:12px">x</button>',
  ].join('')
  // 插到最前面：保证探针在视口内（放 body 末尾会被挤到视口外，量不到重叠）
  document.body.prepend(host)
  return true
})()
`

/** 对一个已渲染的界面做一次几何审计 */
export async function auditGeometry(page: Page): Promise<GeometryFinding[]> {
  await page.evaluate(SETTLE_SCRIPT)
  return (await page.evaluate(AUDIT_SCRIPT)) as GeometryFinding[]
}

/** 把审计结果排成可直接贴进缺陷单的多行文本（空数组 = 通过） */
export function formatFindings(findings: readonly GeometryFinding[]): string {
  return findings.map((item) => `- [${item.kind}] ${item.selector}\n  ${item.detail}`).join('\n')
}

/** 写 Markdown 报告：`pnpm e2e` 失败时也能直接打开看是哪一屏哪一行 */
export function writeGeometryReport(scenes: readonly GeometryScene[], file: string): void {
  const lines: string[] = ['# 界面几何审计', '']
  const total = scenes.reduce((sum, scene) => sum + scene.findings.length, 0)
  lines.push(`场景 ${scenes.length} 个，问题 ${total} 条。`, '')
  lines.push('| 场景 | 问题数 |', '| --- | --- |')
  for (const scene of scenes) lines.push(`| ${scene.label} | ${scene.findings.length} |`)
  lines.push('')
  for (const scene of scenes) {
    if (scene.findings.length === 0) continue
    lines.push(`## ${scene.label}`, '', formatFindings(scene.findings), '')
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, lines.join('\n'), 'utf8')
}

/** 报告落点：一次性产物放 `.scratch/`（已 git 忽略） */
export const GEOMETRY_REPORT_PATH = path.join('.scratch', 'acceptance', 'ui-geometry.md')
