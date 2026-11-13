import { afterEach } from 'vitest'

/**
 * Radix 基座在 jsdom 下需要的浏览器 API 垫片。
 *
 * - ResizeObserver：Radix Select 用它量触发器尺寸（jsdom 不实现）。
 * - Pointer Capture：Radix 打开/关闭下拉时调用 setPointerCapture 等（jsdom 不实现）。
 * - scrollIntoView：Radix 打开下拉后把高亮项滚进视口（jsdom 不实现）。
 *
 * 只补缺失的实现，不覆盖 jsdom 已有的行为。
 *
 * 本 setup 也被 `// @vitest-environment node` 的用例加载（内核/宿主/插件层），
 * 那类环境没有 DOM，必须先判断环境再碰 Element。
 */
const hasDom = typeof globalThis.Element !== 'undefined'

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

if (hasDom && typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}

if (hasDom && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}

/**
 * RTL 与 jest-dom 只在 DOM 环境里装：node 用例（内核 / 协议 / 宿主 / 插件 / 纯 model）
 * 占全部用例文件的一半以上，每个文件冷启动都白装一遍 RTL 是纯浪费。
 */
if (hasDom) {
  await import('@testing-library/jest-dom/vitest')
  const { cleanup } = await import('@testing-library/react')
  afterEach(() => cleanup())
}
