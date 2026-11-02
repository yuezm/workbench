#!/usr/bin/env node
/**
 * 生成 Workbench 应用图标与托盘图标
 *
 * 输出：
 *   resources/icon.png      （512×512，应用图标）
 *   resources/icon.ico      （16/24/32/48/64/128/256）
 *   resources/tray.png      （16×16，托盘 1x）
 *   resources/tray@2x.png   （32×32，托盘 2x，高 DPI 用）
 *
 * 纯 Node 实现，不依赖第三方包：自写 PNG 编码（zlib）与 ICO 封装（32bit DIB）。
 *
 * 用法：
 *   node scripts/make-icon.mjs [--out <dir>] [--tray <variant>] [--tray-only]
 *
 * 托盘变体（--tray）：
 *   app     直接复用应用图标（深色超椭圆 + 2×2 磁贴 + 高亮星标），与桌面图标一致（默认）
 *   tiles   紫底 + 2×2 白色磁贴（应用图标核心意象的反色版）
 *   panel   紫底 + 两根白色横条（面板 / 列表意象）
 *   solid   纯色实心底板，不加图形（最克制）
 *   star    紫底 + 白色四角星
 *   tile    紫蓝渐变超椭圆 + 白色四角星（旧版样式，留作对照）
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SIZE = 512
const SS = 4 // 每个输出像素的超采样数（抗锯齿）
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const STAR_IN_ACCENT = true // 高亮磁贴内放四角星品牌标

const TRAY_1X = 16 // 托盘 1x：Windows 100% 缩放下通知区域就是 16px
const TRAY_2X = 32 // 托盘 2x：高 DPI 下使用
const DEFAULT_TRAY_VARIANT = 'app'

/* ---------------------------------------------------------------- 调色板 */

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
]

const INK = hex('#ecebf7')
const FOCUS = hex('#8b7cf7') // 品牌紫
const LONG = hex('#4aa8f7') // 品牌蓝

const BODY_TOP = hex('#22243a')
const BODY_BOTTOM = hex('#0c0d17')

/* ---------------------------------------------------------------- 画布 */

/** 预乘 alpha 的 RGBA 画布 */
class Raster {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.data = new Float32Array(width * height * 4)
  }

  /** 以 straight alpha 叠加一个颜色 */
  blend(x, y, color, alpha) {
    const i = (y * this.width + x) * 4
    const d = this.data
    const inv = 1 - alpha
    d[i] = color[0] * alpha + d[i] * inv
    d[i + 1] = color[1] * alpha + d[i + 1] * inv
    d[i + 2] = color[2] * alpha + d[i + 2] * inv
    d[i + 3] = alpha + d[i + 3] * inv
  }

  /** 面积平均缩放到目标尺寸，返回 straight alpha 的 RGBA8 */
  resize(width, height) {
    const out = new Uint8ClampedArray(width * height * 4)
    const sx = this.width / width
    const sy = this.height / height
    for (let y = 0; y < height; y++) {
      const y0 = y * sy
      const y1 = y0 + sy
      for (let x = 0; x < width; x++) {
        const x0 = x * sx
        const x1 = x0 + sx
        let r = 0
        let g = 0
        let b = 0
        let a = 0
        for (let yy = Math.floor(y0); yy < Math.min(Math.ceil(y1), this.height); yy++) {
          const wy = Math.min(y1, yy + 1) - Math.max(y0, yy)
          for (let xx = Math.floor(x0); xx < Math.min(Math.ceil(x1), this.width); xx++) {
            const wx = Math.min(x1, xx + 1) - Math.max(x0, xx)
            const w = wx * wy
            const i = (yy * this.width + xx) * 4
            r += this.data[i] * w
            g += this.data[i + 1] * w
            b += this.data[i + 2] * w
            a += this.data[i + 3] * w
          }
        }
        const total = sx * sy
        const o = (y * width + x) * 4
        const alpha = a / total
        if (alpha > 0) {
          // r/g/b 是预乘后的 0–255 分量，除以 alpha 即还原成 straight color
          out[o] = r / a
          out[o + 1] = g / a
          out[o + 2] = b / a
        }
        out[o + 3] = alpha * 255
      }
    }
    return { width, height, data: out }
  }
}

/* ---------------------------------------------------------------- 图形 */

/**
 * 超椭圆（macOS 图标的连续曲率方块）覆盖率。
 * 边界满足 |x/a|^n + |y/a|^n = 1，用梯度把隐式函数归一化成近似距离。
 */
function superellipseCoverage(px, py, cx, cy, a, n) {
  const dx = (px - cx) / a
  const dy = (py - cy) / a
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax > 1 || ay > 1) return 0 // 一定在形外
  const ax2 = ax * ax
  const ay2 = ay * ay
  const sum = n === 5 ? ax2 * ax2 * ax + ay2 * ay2 * ay : Math.pow(ax, n) + Math.pow(ay, n)
  const f = Math.pow(sum, 1 / n)
  const denom = n === 5 ? f * f * f * f : Math.pow(sum, (n - 1) / n)
  const gx = ((n === 5 ? ax2 * ax2 : Math.pow(ax, n - 1)) * Math.sign(dx)) / denom
  const gy = ((n === 5 ? ay2 * ay2 : Math.pow(ay, n - 1)) * Math.sign(dy)) / denom
  const grad = Math.hypot(gx, gy) || 1
  // (f - 1) 是归一化尺度下的距离，乘回 a 换算成像素
  const dist = ((f - 1) / grad) * a
  return Math.min(1, Math.max(0, 0.5 - dist))
}

/** 圆角矩形覆盖率 */
function roundedBoxCoverage(px, py, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r)
  const cy = Math.min(Math.max(py, y0 + r), y1 - r)
  const dist = Math.hypot(px - cx, py - cy) - r
  return Math.min(1, Math.max(0, 0.5 - dist))
}

/** 圆角矩形描边覆盖率（外框减去内框） */
function roundedBoxRingCoverage(px, py, x0, y0, x1, y1, r, stroke) {
  const outer = roundedBoxCoverage(px, py, x0, y0, x1, y1, r)
  const inner = roundedBoxCoverage(
    px,
    py,
    x0 + stroke,
    y0 + stroke,
    x1 - stroke,
    y1 - stroke,
    Math.max(0, r - stroke),
  )
  return Math.max(0, outer - inner)
}

/** 把颜色按 t∈[0,1] 在两个颜色间插值 */
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** 径向辉光强度 */
function glow(x, y, cx, cy, radius) {
  const d = Math.hypot(x - cx, y - cy) / radius
  if (d >= 1) return 0
  const k = 1 - d
  return k * k
}

/**
 * 把形状刷到画布上
 * @param coverage (x, y) => 0..1
 * @param color (x, y) => [r, g, b]，straight alpha 由 alpha 参数承担
 * @param alpha 额外的不透明度系数
 */
function paint(raster, coverage, color, alpha = 1) {
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const cov = coverage(x + 0.5, y + 0.5)
      if (cov <= 0) continue
      raster.blend(x, y, color(x + 0.5, y + 0.5), cov * alpha)
    }
  }
}

/* ---------------------------------------------------------------- 品牌标 */

/**
 * 应用内品牌标（四角星）的路径，24×24 视口：
 * M12 2c.6 4.8 3.2 7.4 8 8-4.8.6-7.4 3.2-8 8-.6-4.8-3.2-7.4-8-8 4.8-.6 7.4-3.2 8-8z
 */
const STAR_SEGMENTS = [
  [
    [12, 2],
    [12.6, 6.8],
    [15.2, 9.4],
    [20, 10],
  ],
  [
    [20, 10],
    [15.2, 10.6],
    [12.6, 13.2],
    [12, 18],
  ],
  [
    [12, 18],
    [11.4, 13.2],
    [8.8, 10.6],
    [4, 10],
  ],
  [
    [4, 10],
    [8.8, 9.4],
    [11.4, 6.8],
    [12, 2],
  ],
]

/** 把品牌标采样成闭合多边形 */
function starPolygon(steps = 24) {
  const points = []
  for (const [p0, c1, c2, p3] of STAR_SEGMENTS) {
    for (let i = 0; i < steps; i++) {
      const t = i / steps
      const u = 1 - t
      const x =
        u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0]
      const y =
        u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1]
      points.push([x, y])
    }
  }
  return points
}

/** 扫描线填充多边形，返回 1 字节/像素的掩膜 */
function rasterizePolygon(points, width, height) {
  const mask = new Uint8Array(width * height)
  const edges = points.map(([x0, y0], i) => {
    const [x1, y1] = points[(i + 1) % points.length]
    return [x0, y0, x1, y1]
  })
  for (let y = 0; y < height; y++) {
    const sy = y + 0.5
    const crossings = []
    for (const [x0, y0, x1, y1] of edges) {
      if (y0 === y1) continue
      const lo = Math.min(y0, y1)
      const hi = Math.max(y0, y1)
      if (sy < lo || sy >= hi) continue
      crossings.push(x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0))
    }
    crossings.sort((a, b) => a - b)
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.ceil(crossings[i] - 0.5))
      const to = Math.min(width - 1, Math.floor(crossings[i + 1] - 0.5))
      for (let x = from; x <= to; x++) mask[y * width + x] = 1
    }
  }
  return mask
}

/** 把四角星多边形按比例缩放并居中到画布上 */
function starPolygonAt(width, height, span) {
  const scale = span / 16 // 星形在源视口里横跨 16 个单位
  const polygon = starPolygon().map(([px, py]) => [
    width / 2 + (px - 12) * scale,
    height / 2 + (py - 10) * scale,
  ])
  return polygon
}

/** 把多边形掩膜刷到画布上 */
function paintPolygon(raster, polygon, color, alpha = 1) {
  const W = raster.width
  const mask = rasterizePolygon(polygon, W, W)
  paint(
    raster,
    (x, y) => mask[Math.floor(y) * W + Math.floor(x)],
    () => color,
    alpha,
  )
}

/* ---------------------------------------------------------------- 场景 */

/**
 * 仪表盘磁贴：超椭圆深色主体 + 极光辉光 + 2×2 圆角磁贴，
 * 右下角磁贴为品牌紫→蓝渐变（对应当前选中的 app）。
 */
function renderScene(size) {
  const W = size * SS
  const raster = new Raster(W, W)

  // 主体：超椭圆 + 垂直渐变 + 极光
  const bodyColor = (x, y) => {
    const t = y / W
    const base = mix(BODY_TOP, BODY_BOTTOM, t * t)
    const warm = glow(x, y, W * 0.28, W * 0.22, W * 0.62)
    const cool = glow(x, y, W * 0.82, W * 0.86, W * 0.58)
    return [
      Math.min(255, base[0] + FOCUS[0] * warm * 0.32 + LONG[0] * cool * 0.16),
      Math.min(255, base[1] + FOCUS[1] * warm * 0.32 + LONG[1] * cool * 0.16),
      Math.min(255, base[2] + FOCUS[2] * warm * 0.32 + LONG[2] * cool * 0.16),
    ]
  }
  paint(raster, (x, y) => superellipseCoverage(x, y, W / 2, W / 2, W / 2, 5), bodyColor)

  // 磁贴网格：2×2，右下为高亮渐变
  const margin = 0.185
  const gap = 0.048
  const tile = (1 - margin * 2 - gap) / 2
  const radius = tile * 0.24
  const cells = [
    { col: 0, row: 0 },
    { col: 1, row: 0 },
    { col: 0, row: 1 },
    { col: 1, row: 1, accent: true },
  ]

  for (const cell of cells) {
    const x0 = (margin + cell.col * (tile + gap)) * W
    const y0 = (margin + cell.row * (tile + gap)) * W
    const x1 = x0 + tile * W
    const y1 = y0 + tile * W
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2

    if (cell.accent) {
      // 高亮磁贴外圈的柔光
      paint(
        raster,
        (x, y) => {
          const d = Math.hypot(x - cx, y - cy) / (tile * W * 0.95)
          return d >= 1 ? 0 : (1 - d) * (1 - d) * 0.22
        },
        () => FOCUS,
      )
    }

    const coverage = (x, y) => roundedBoxCoverage(x, y, x0, y0, x1, y1, radius * W)
    if (cell.accent) {
      const gradient = (x, y) =>
        mix(FOCUS, LONG, Math.min(1, Math.max(0, (x - x0 + (y - y0)) / ((x1 - x0) * 2))))
      paint(raster, coverage, gradient)

      if (STAR_IN_ACCENT) {
        // 高亮磁贴内的四角星品牌标
        const scale = (tile * W * 0.46) / 16
        const scx = cx
        const scy = cy
        const polygon = starPolygon().map(([px, py]) => [
          scx + (px - 12) * scale,
          scy + (py - 10) * scale,
        ])
        const mask = rasterizePolygon(polygon, W, W)
        paint(
          raster,
          (x, y) => mask[Math.floor(y) * W + Math.floor(x)],
          () => INK,
          0.92,
        )
      }
    } else {
      paint(raster, coverage, () => INK, 0.12)
    }
  }

  // 内描边：玻璃质感的高光边
  paint(
    raster,
    (x, y) => {
      const outer = superellipseCoverage(x, y, W / 2, W / 2, W / 2, 5)
      const inner = superellipseCoverage(x, y, W / 2, W / 2, W / 2 - 1.5 * SS, 5)
      return Math.max(0, outer - inner)
    },
    () => INK,
    0.1,
  )

  return raster.resize(size, size)
}

/* ---------------------------------------------------------------- 托盘 */

/**
 * 托盘只有 16px，复杂图形一定会糊：渐变、细描边、凹曲线都会退化。
 * 所以统一走「实色底 + 一两个大留白图形」的路子，保证 16px 下轮廓依旧干净。
 */

/** 托盘底板：圆角方块（比超椭圆更硬朗，16px 下轮廓更利落） */
function paintTrayPlate(raster, color = FOCUS) {
  const W = raster.width
  paint(
    raster,
    (x, y) => roundedBoxCoverage(x, y, W * 0.03, W * 0.03, W * 0.97, W * 0.97, W * 0.24),
    () => color,
  )
}

/** 变体：直接复用应用图标场景，保证托盘与桌面图标一致 */
function renderTrayApp(size) {
  return renderScene(size)
}

/** 变体：紫底 + 2×2 白色磁贴（应用图标核心意象的反色版） */
function renderTrayTiles(size) {
  const W = size * SS
  const raster = new Raster(W, W)
  paintTrayPlate(raster)
  const margin = W * 0.215
  const gap = W * 0.075
  const tile = (W - margin * 2 - gap) / 2
  const radius = tile * 0.3
  for (const [col, row] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const x0 = margin + col * (tile + gap)
    const y0 = margin + row * (tile + gap)
    paint(
      raster,
      (x, y) => roundedBoxCoverage(x, y, x0, y0, x0 + tile, y0 + tile, radius),
      () => INK,
      0.97,
    )
  }
  return raster.resize(size, size)
}

/** 变体：紫底 + 两根白色横条（面板 / 列表意象） */
function renderTrayPanel(size) {
  const W = size * SS
  const raster = new Raster(W, W)
  paintTrayPlate(raster)
  const barW = W * 0.5
  const barH = W * 0.125
  const gap = W * 0.145
  const x0 = (W - barW) / 2
  for (const row of [0, 1]) {
    const y0 = (W - (barH * 2 + gap)) / 2 + row * (barH + gap)
    paint(
      raster,
      (x, y) => roundedBoxCoverage(x, y, x0, y0, x0 + barW, y0 + barH, barH / 2),
      () => INK,
      0.97,
    )
  }
  return raster.resize(size, size)
}

/** 变体：纯色实心底板，不加图形（最克制） */
function renderTraySolid(size) {
  const W = size * SS
  const raster = new Raster(W, W)
  paintTrayPlate(raster)
  return raster.resize(size, size)
}

/** 变体：紫底 + 白色四角星（保留品牌标，但放大到能读出星形） */
function renderTrayStar(size) {
  const W = size * SS
  const raster = new Raster(W, W)
  paintTrayPlate(raster)
  paintPolygon(raster, starPolygonAt(W, W, W * 0.58), INK, 0.97)
  return raster.resize(size, size)
}

/** 变体：紫蓝渐变超椭圆 + 白色四角星（旧版托盘样式，留作对照） */
function renderTrayTile(size) {
  const W = size * SS
  const raster = new Raster(W, W)
  paint(
    raster,
    (x, y) => superellipseCoverage(x, y, W / 2, W / 2, W / 2, 5),
    (x, y) => mix(FOCUS, LONG, (x + y) / (2 * W)),
  )
  paintPolygon(raster, starPolygonAt(W, W, W * 0.44), INK, 0.95)
  return raster.resize(size, size)
}

const TRAY_RENDERERS = {
  app: renderTrayApp,
  tiles: renderTrayTiles,
  panel: renderTrayPanel,
  solid: renderTraySolid,
  star: renderTrayStar,
  tile: renderTrayTile,
}

export const TRAY_VARIANTS = Object.keys(TRAY_RENDERERS)

/** 按变体名渲染托盘图标，返回 straight alpha 的 RGBA8 图像 */
export function renderTray(variant, size) {
  const renderer = TRAY_RENDERERS[variant]
  if (!renderer) {
    throw new Error(`未知托盘图标变体：${variant}（可用：${TRAY_VARIANTS.join(', ')}）`)
  }
  return renderer(size)
}

/* ---------------------------------------------------------------- PNG */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    Buffer.from(data.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------------------------------------------------------------- ICO */

/** 把 RGBA 图像打包成 32bit DIB（ICO 条目格式） */
function encodeDib({ width, height, data }) {
  const header = Buffer.alloc(40)
  const xorSize = width * height * 4
  const maskStride = Math.ceil(width / 32) * 4
  const andSize = maskStride * height
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(width, 4)
  header.writeInt32LE(height * 2, 8) // XOR + AND 高度
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16) // BI_RGB
  header.writeUInt32LE(xorSize + andSize, 20)
  header.writeInt32LE(2835, 24)
  header.writeInt32LE(2835, 28)
  header.writeUInt32LE(0, 32)
  header.writeUInt32LE(0, 36)

  const xor = Buffer.alloc(xorSize)
  const mask = Buffer.alloc(andSize)
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4
    const dst = y * width * 4
    for (let x = 0; x < width; x++) {
      const s = src + x * 4
      const d = dst + x * 4
      xor[d] = data[s + 2]
      xor[d + 1] = data[s + 1]
      xor[d + 2] = data[s]
      xor[d + 3] = data[s + 3]
      if (data[s + 3] < 128) {
        const bit = maskStride * y + (x >> 3)
        mask[bit] |= 0x80 >> (x & 7)
      }
    }
  }
  return Buffer.concat([header, xor, mask])
}

function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = []
  const payloads = []
  let offset = 6 + images.length * 16
  for (const image of images) {
    const dib = encodeDib(image)
    const entry = Buffer.alloc(16)
    entry[0] = image.width >= 256 ? 0 : image.width
    entry[1] = image.height >= 256 ? 0 : image.height
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(dib.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += dib.length
    entries.push(entry)
    payloads.push(dib)
  }
  return Buffer.concat([header, ...entries, ...payloads])
}

/* ---------------------------------------------------------------- 入口 */

function parseArgs(argv) {
  const options = {
    out: resolve(ROOT, 'resources'),
    variant: DEFAULT_TRAY_VARIANT,
    trayOnly: false,
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') options.out = resolve(process.cwd(), argv[++i])
    else if (argv[i] === '--tray') options.variant = argv[++i]
    else if (argv[i] === '--tray-only') options.trayOnly = true
  }
  return options
}

function main(argv) {
  const options = parseArgs(argv)
  mkdirSync(options.out, { recursive: true })

  if (!options.trayOnly) {
    const pngPath = resolve(options.out, 'icon.png')
    writeFileSync(pngPath, encodePng(renderScene(SIZE)))
    console.log('wrote', pngPath)

    const icoPath = resolve(options.out, 'icon.ico')
    writeFileSync(icoPath, encodeIco(ICO_SIZES.map((size) => renderScene(size))))
    console.log('wrote', icoPath)
  }

  const trayPath = resolve(options.out, 'tray.png')
  writeFileSync(trayPath, encodePng(renderTray(options.variant, TRAY_1X)))
  console.log('wrote', trayPath, `(${options.variant} @${TRAY_1X}px)`)

  const tray2xPath = resolve(options.out, 'tray@2x.png')
  writeFileSync(tray2xPath, encodePng(renderTray(options.variant, TRAY_2X)))
  console.log('wrote', tray2xPath, `(${options.variant} @${TRAY_2X}px)`)
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main(process.argv.slice(2))
