// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { STAGE_KINDS, stageKindOf } from '../../../../../../src/protocol/entities'
import { STAGE_KIND_META } from '../../../../../../src/renderer/src/apps/ai-workflow/model/stage-kinds'

/**
 * 阶段类别的配色表（M18）。
 *
 * 只锁「类名」而不锁具体色值：色值在 `global.css` 的 token 里，`pnpm check:ui` 负责
 * 语义 token 与对比度；这里守住「四个类别都有颜色、且只用语义 token 类名」。
 */

describe('STAGE_KIND_META', () => {
  it('四个类别都有文案、圆点、文字色与徽标底', () => {
    for (const kind of STAGE_KINDS) {
      const meta = STAGE_KIND_META[kind]
      expect(meta.label, `${kind} 缺文案`).not.toBe('')
      expect(meta.dot).toMatch(/^bg-/)
      expect(meta.text).toMatch(/^text-/)
      expect(meta.chip).toMatch(/^bg-/)
    }
  })

  it('类别文案与协议口径一致', () => {
    expect(STAGE_KIND_META.pending.label).toBe('未开始')
    expect(STAGE_KIND_META.active.label).toBe('进行中')
    expect(STAGE_KIND_META.done.label).toBe('已完成')
    expect(STAGE_KIND_META.closed.label).toBe('已关闭')
  })

  it('四类颜色互不相同：未开始=弱前景、进行中=brand、已完成=success、已关闭=destructive 圆点', () => {
    expect(STAGE_KIND_META.pending.dot).toBe('bg-muted-foreground')
    expect(STAGE_KIND_META.pending.text).toBe('text-muted-foreground')
    expect(STAGE_KIND_META.active.dot).toBe('bg-brand')
    expect(STAGE_KIND_META.active.text).toBe('text-brand')
    expect(STAGE_KIND_META.done.dot).toBe('bg-success')
    expect(STAGE_KIND_META.done.text).toBe('text-success')
    // 已关闭：圆点用 destructive，文字退到最弱一级（「不做了」不是「做完了」）
    expect(STAGE_KIND_META.closed.dot).toBe('bg-destructive')
    expect(STAGE_KIND_META.closed.text).toBe('text-muted-foreground')
    // 徽标底是同色低透明度，四类各不相同
    expect(new Set(STAGE_KINDS.map((kind) => STAGE_KIND_META[kind].chip)).size).toBe(4)
  })

  it('类名与协议算出的类别对得上：内置按键取，自己添加的一律进行中', () => {
    expect(STAGE_KIND_META[stageKindOf({ builtin: 'todo' })]).toBe(STAGE_KIND_META.pending)
    expect(STAGE_KIND_META[stageKindOf({ builtin: 'blocked' })]).toBe(STAGE_KIND_META.active)
    expect(STAGE_KIND_META[stageKindOf({ builtin: 'done' })]).toBe(STAGE_KIND_META.done)
    expect(STAGE_KIND_META[stageKindOf({ builtin: 'cancelled' })]).toBe(STAGE_KIND_META.closed)
    expect(STAGE_KIND_META[stageKindOf({ builtin: null })]).toBe(STAGE_KIND_META.active)
  })
})
