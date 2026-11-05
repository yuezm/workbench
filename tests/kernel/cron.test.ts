import { describe, expect, it } from 'vitest'
import {
  cronDateMatches,
  cronLocalKey,
  localDateTime,
  nextCronTime,
  parseCron,
  wallClockInstants,
} from '../../src/kernel/cron'

const parse = (expression: string) => {
  const spec = parseCron(expression)
  expect(spec, expression).not.toBeNull()
  return spec as NonNullable<typeof spec>
}

describe('kernel/cron 解析', () => {
  it('通配与数字：0 9 * * *', () => {
    const spec = parse('0 9 * * *')
    expect(spec.minutes).toEqual([0])
    expect(spec.hours).toEqual([9])
    expect(spec.daysOfMonth).toHaveLength(31)
    expect(spec.months).toHaveLength(12)
    expect(spec.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(spec.domStar).toBe(true)
    expect(spec.dowStar).toBe(true)
  })

  it('步长 / 区间 / 列表', () => {
    expect(parse('*/15 * * * *').minutes).toEqual([0, 15, 30, 45])
    expect(parse('5,10-20/5 1-3 * * 1-5').minutes).toEqual([5, 10, 15, 20])
    expect(parse('5,10-20/5 1-3 * * 1-5').hours).toEqual([1, 2, 3])
    expect(parse('5,10-20/5 1-3 * * 1-5').daysOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(parse('0 0 1 1-6/2 *').months).toEqual([1, 3, 5])
  })

  it('周 7 归一为周日', () => {
    expect(parse('0 0 * * 7').daysOfWeek).toEqual([0])
    expect(parse('0 0 * * 0,7').daysOfWeek).toEqual([0])
  })

  it('非法表达式返回 null', () => {
    for (const expression of [
      '',
      '0 9 * *',
      '0 9 * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      '*/0 * * * *',
      'a * * * *',
      '1-0 * * * *',
      '* * * * 1-',
      '1,,2 * * * *',
      '*/x * * * *',
      '1-2-3 * * * *',
    ]) {
      expect(parseCron(expression), expression).toBeNull()
    }
  })

  it('单值带步长：`5/15` = 从 5 开始每 15 分钟到上界', () => {
    expect(parse('5/15 * * * *').minutes).toEqual([5, 20, 35, 50])
  })
})

describe('kernel/cron 日期匹配', () => {
  it('dom 与 dow 同时受限时按 OR', () => {
    const spec = parse('0 0 1 * 1')
    // 2026-01-01 是周四：dom=1 命中
    expect(cronDateMatches(spec, 1, 4)).toBe(true)
    // 2026-01-05 是周一：dow=1 命中
    expect(cronDateMatches(spec, 5, 1)).toBe(true)
    // 2026-01-06 是周二：都不命中
    expect(cronDateMatches(spec, 6, 2)).toBe(false)
  })

  it('只有 dom 受限时只看 dom；只有 dow 受限时只看 dow', () => {
    const domOnly = parse('0 0 1 * *')
    expect(cronDateMatches(domOnly, 1, 3)).toBe(true)
    expect(cronDateMatches(domOnly, 2, 1)).toBe(false)
    const dowOnly = parse('0 0 * * 1')
    expect(cronDateMatches(dowOnly, 2, 1)).toBe(true)
    expect(cronDateMatches(dowOnly, 1, 4)).toBe(false)
  })
})

describe('kernel/cron 下一次触发（时区墙钟）', () => {
  it('UTC：每日 9 点', () => {
    expect(nextCronTime(parse('0 9 * * *'), '2026-01-01T00:00:00.000Z', 'UTC')).toBe(
      '2026-01-01T09:00:00.000Z',
    )
    expect(nextCronTime(parse('0 9 * * *'), '2026-01-01T09:00:00.000Z', 'UTC')).toBe(
      '2026-01-02T09:00:00.000Z',
    )
    expect(nextCronTime(parse('0 9 * * *'), '2026-01-01T08:59:30.000Z', 'UTC')).toBe(
      '2026-01-01T09:00:00.000Z',
    )
  })

  it('Asia/Shanghai：09:00 本地 = 01:00Z', () => {
    expect(nextCronTime(parse('0 9 * * *'), '2026-01-01T00:00:00.000Z', 'Asia/Shanghai')).toBe(
      '2026-01-01T01:00:00.000Z',
    )
    expect(localDateTime(new Date('2026-01-01T01:00:00.000Z'), 'Asia/Shanghai')).toEqual({
      year: 2026,
      month: 1,
      day: 1,
      hour: 9,
      minute: 0,
    })
  })

  it('America/New_York 春调：02:30 当天不存在，顺延到次日', () => {
    // 2026-03-08 02:00 → 03:00 本地跳变
    expect(nextCronTime(parse('30 2 * * *'), '2026-03-08T05:00:00.000Z', 'America/New_York')).toBe(
      '2026-03-09T06:30:00.000Z',
    )
  })

  it('America/New_York 秋调：01:30 出现两次，next 从第一次之后跳到次日', () => {
    // 2026-11-01 01:30 EDT = 05:30Z；同一墙钟还有 06:30Z
    const instants = wallClockInstants(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      'America/New_York',
    )
    expect(instants).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'])
    expect(nextCronTime(parse('30 1 * * *'), '2026-11-01T04:00:00.000Z', 'America/New_York')).toBe(
      '2026-11-01T05:30:00.000Z',
    )
    // 第一次触发后（baseline=05:30Z）：下一次是次日 01:30 EST = 06:30Z+1d
    expect(nextCronTime(parse('30 1 * * *'), '2026-11-01T05:30:00.000Z', 'America/New_York')).toBe(
      '2026-11-02T06:30:00.000Z',
    )
  })

  it('墙钟键按本地时间生成', () => {
    expect(cronLocalKey('2026-01-01T01:00:00.000Z', 'Asia/Shanghai')).toBe('2026-01-01 09:00')
    expect(cronLocalKey('2026-01-01T09:00:00.000Z', 'UTC')).toBe('2026-01-01 09:00')
  })

  it('after 不是合法 ISO → null', () => {
    expect(nextCronTime(parse('0 9 * * *'), 'not-a-date', 'UTC')).toBeNull()
  })

  it('跨月 / 按日跳过：12 月 31 日', () => {
    expect(nextCronTime(parse('0 0 31 12 *'), '2026-11-01T00:00:00.000Z', 'UTC')).toBe(
      '2026-12-31T00:00:00.000Z',
    )
  })
})
