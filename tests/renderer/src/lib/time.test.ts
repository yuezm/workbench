import { describe, expect, it, vi } from 'vitest'
import { formatLocalDateTime, formatLocalShort } from '@workbench/client-ui-kit/time'

/**
 * 时刻展示口径：内核存 ISO（UTC），界面给人看本机时区。
 *
 * 一律显式传时区断言，不去改测试进程的 TZ：这些用例在 UTC、东八区和西五区
 * 的 CI 上得出同一组期望值，才算真的钉住了「差 8 小时」这类回归。
 */
describe('formatLocalDateTime', () => {
  const ISO = '2026-11-03T00:00:00.000Z'

  it('东八区：UTC 零点 = 当天 08:00', () => {
    expect(formatLocalDateTime(ISO, 'Asia/Shanghai')).toBe('2026-11-03 08:00')
  })

  it('UTC：原样零点，不偏移', () => {
    expect(formatLocalDateTime(ISO, 'UTC')).toBe('2026-11-03 00:00')
  })

  it('西五区：跨到前一天（冬令时 19:00）', () => {
    expect(formatLocalDateTime(ISO, 'America/New_York')).toBe('2026-11-02 19:00')
  })

  it('跨年也要进位：东八区的年初一凌晨来自上一年的最后一天', () => {
    expect(formatLocalDateTime('2026-12-31T23:30:00.000Z', 'Asia/Shanghai')).toBe(
      '2027-01-01 07:30',
    )
  })

  it('省略时刻的日期串按 UTC 零点解析，再换本机时区', () => {
    expect(formatLocalDateTime('2026-01-01', 'Asia/Shanghai')).toBe('2026-01-01 08:00')
  })

  it('不传时区时用本机时区（与显式传 resolvedOptions 一致）', () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(formatLocalDateTime(ISO)).toBe(formatLocalDateTime(ISO, local))
    expect(formatLocalDateTime(ISO)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('空值 / 非法时刻 / 非法时区都原样返回，不编造时刻', () => {
    expect(formatLocalDateTime('')).toBe('')
    expect(formatLocalDateTime('   ')).toBe('   ')
    expect(formatLocalDateTime('不是时间')).toBe('不是时间')
    expect(formatLocalDateTime(ISO, 'Mars/Phobos')).toBe(ISO)
  })

  it('同一时区复用 formatter：连续调用互不干扰', () => {
    expect(formatLocalDateTime(ISO, 'Asia/Shanghai')).toBe('2026-11-03 08:00')
    expect(formatLocalDateTime('2026-11-03T01:05:00.000Z', 'Asia/Shanghai')).toBe(
      '2026-11-03 09:05',
    )
    expect(formatLocalDateTime(ISO, 'Asia/Shanghai')).toBe('2026-11-03 08:00')
  })
})

describe('formatLocalShort', () => {
  it('紧凑写法：月-日 时:分（本机时区）', () => {
    expect(formatLocalShort('2026-11-15T01:00:00.000Z', 'Asia/Shanghai')).toBe('11-15 09:00')
  })

  it('补零：单位数的月 / 日 / 时 / 分都占两格', () => {
    expect(formatLocalShort('2026-01-02T01:03:00.000Z', 'Asia/Shanghai')).toBe('01-02 09:03')
  })

  it('非法输入原样返回', () => {
    expect(formatLocalShort('', 'Asia/Shanghai')).toBe('')
    expect(formatLocalShort('nope', 'Asia/Shanghai')).toBe('nope')
  })
})

describe('残缺分量兜底', () => {
  it('formatter 少给某个分量时补空再补零，不把 undefined 拼进界面', () => {
    // 正常 Intl 一定给全五个分量；这里模拟「某个分量缺席」（如残缺的 polyfill / 裁剪实现），
    // 确认 pick(...) 的 `?? ''` 兜底生效。
    const parts: Intl.DateTimeFormatPart[] = [
      { type: 'year', value: '2026' },
      { type: 'month', value: '11' },
      { type: 'day', value: '03' },
      { type: 'hour', value: '08' },
    ]
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue(parts)
    try {
      // 缺 minute → 空串 → pad 后补 '00'
      expect(formatLocalDateTime('2026-11-03T00:00:00.000Z', 'Asia/Tokyo')).toBe('2026-11-03 08:00')
    } finally {
      spy.mockRestore()
    }
    // 撤销后恢复真实格式化
    expect(formatLocalDateTime('2026-11-03T00:00:00.000Z', 'Asia/Tokyo')).toBe('2026-11-03 09:00')
  })
})
