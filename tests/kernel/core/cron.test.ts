// @vitest-environment node
import fc, { type Arbitrary } from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  cronDateMatches,
  cronLocalKey,
  localDateTime,
  nextCronTime,
  parseCron,
  wallClockInstants,
} from '../../../src/kernel/core/cron'

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

// —— 性质测试（fast-check）：机器穷举的不变量 ————————————————————————————————
//
// 示例用例是人挑的边界；性质测试随机生成合法 cron 表达式与时刻，断言内核不变量：
// ① 解析结果每个字段都落在自己的取值域内；
// ② 下一次触发严格晚于 after，且返回瞬间的本地墙钟确实命中该规则；
// ③ 返回的就是「after 之后最早命中的那一刻」——用独立逐分钟穷举的预言机核对；
// ④ 步长 / 区间 / 周 0-7 归一等解析语义与展开后的显式写法等价。
//
// 固定种子：同一份输入永远给出同一条反例，门禁可复现（不会时红时绿）；
// 想换一批输入用环境变量 FC_SEED 覆盖。

const PROPERTY_SEED = Number(process.env.FC_SEED ?? 20261113)
const PROPERTY_RUNS = 100

const TIMEZONES = [
  'UTC',
  'Asia/Shanghai',
  'America/New_York',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
] as const

const intText = (min: number, max: number): Arbitrary<string> =>
  fc.integer({ min, max }).map(String)

const rangeText = (min: number, max: number): Arbitrary<string> =>
  fc
    .tuple(fc.integer({ min, max }), fc.integer({ min, max }))
    .map(([left, right]) => (left <= right ? `${left}-${right}` : `${right}-${left}`))

const rangeStepText = (min: number, max: number): Arbitrary<string> =>
  fc
    .tuple(fc.integer({ min, max }), fc.integer({ min, max }), fc.integer({ min: 1, max: 10 }))
    .map(([left, right, step]) => {
      const lo = Math.min(left, right)
      const hi = Math.max(left, right)
      return `${lo}-${hi}/${step}`
    })

const stepText = (max: number): Arbitrary<string> =>
  fc.integer({ min: 1, max }).map((step) => `*/${step}`)

/** 单个 cron 字段的合法写法（通配 / 单值 / 区间 / 区间步长 / 步长 / 列表）。 */
const fieldArb = (min: number, max: number): Arbitrary<string> =>
  fc.oneof(
    fc.constant('*'),
    intText(min, max),
    rangeText(min, max),
    rangeStepText(min, max),
    stepText(max),
    fc
      .array(fc.oneof(intText(min, max), rangeText(min, max), rangeStepText(min, max)), {
        minLength: 1,
        maxLength: 3,
      })
      .map((parts) => parts.join(',')),
  )

const cronExprArb: Arbitrary<string> = fc
  .tuple(fieldArb(0, 59), fieldArb(0, 23), fieldArb(1, 31), fieldArb(1, 12), fieldArb(0, 7))
  .map(([minute, hour, dom, month, dow]) => `${minute} ${hour} ${dom} ${month} ${dow}`)

/** 每日固定时刻的规则：三天内必命中一次，用于「最早命中」穷举核对。 */
const dailyExprArb: Arbitrary<string> = fc
  .tuple(fc.integer({ min: 0, max: 59 }), fc.integer({ min: 0, max: 23 }))
  .map(([minute, hour]) => `${minute} ${hour} * * *`)

const afterIsoArb: Arbitrary<string> = fc
  .date({
    min: new Date('2020-01-01T00:00:00.000Z'),
    max: new Date('2027-12-31T00:00:00.000Z'),
    // fast-check v4 默认会生成 Invalid Date（noInvalidDate 默认 false），这里要的是合法时刻
    noInvalidDate: true,
  })
  .map((date) => date.toISOString())

/**
 * 分钟对齐的时刻：`after` 恰好等于某个墙钟分钟。
 * 随机毫秒的时刻几乎撞不上「after 正好是命中时刻」这条边界，
 * 而这条边界正是 `instant > afterMs` 与 `instant >= afterMs` 的分水岭。
 */
const alignedAfterIsoArb: Arbitrary<string> = fc
  .date({
    min: new Date('2020-01-01T00:00:00.000Z'),
    max: new Date('2027-12-31T00:00:00.000Z'),
    noInvalidDate: true,
  })
  .map((date) => new Date(Math.floor(date.getTime() / 60_000) * 60_000).toISOString())

const timezoneArb = fc.constantFrom(...TIMEZONES)

/** 墙钟分钟 → 星期几（0 = 周日）；与内核算法一致但独立实现，避免同源错误。 */
const weekdayOfWall = (year: number, month: number, day: number): number =>
  new Date(Date.UTC(year, month - 1, day)).getUTCDay()

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** 墙钟 +1 分钟（朴素民用时间，不涉及时区规则）。 */
const wallPlusMinute = (wall: WallClock): WallClock => {
  const shifted = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) + 60_000,
  )
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

/**
 * 独立预言机：逐分钟扫墙钟，找出 after 之后最早命中的瞬间。
 * 与内核「按天 → 按时 → 按分」的扫描是两条独立路径，结果必须一致。
 */
const bruteForceNext = (
  spec: NonNullable<ReturnType<typeof parseCron>>,
  afterIso: string,
  timezone: string,
  maxMinutes: number,
): string | null => {
  const afterMs = Date.parse(afterIso)
  let wall = localDateTime(new Date(afterMs + 60_000), timezone)
  for (let step = 0; step < maxMinutes; step += 1) {
    const dateHit =
      spec.months.includes(wall.month) &&
      cronDateMatches(spec, wall.day, weekdayOfWall(wall.year, wall.month, wall.day))
    if (dateHit && spec.hours.includes(wall.hour) && spec.minutes.includes(wall.minute)) {
      const hit = wallClockInstants(wall, timezone)
        .map((iso) => Date.parse(iso))
        .filter((ms) => ms > afterMs)
        .sort((left, right) => left - right)[0]
      if (hit !== undefined) return new Date(hit).toISOString()
    }
    wall = wallPlusMinute(wall)
  }
  return null
}

describe('kernel/cron 性质（fast-check 随机生成）', () => {
  it('合法表达式：每个字段的解析结果都落在自己的取值域内', () => {
    fc.assert(
      fc.property(cronExprArb, (expression) => {
        const spec = parseCron(expression)
        expect(spec, expression).not.toBeNull()
        const parsed = spec as NonNullable<typeof spec>
        expect(parsed.minutes.length, expression).toBeGreaterThan(0)
        expect(parsed.hours.length, expression).toBeGreaterThan(0)
        expect(parsed.daysOfMonth.length, expression).toBeGreaterThan(0)
        expect(parsed.months.length, expression).toBeGreaterThan(0)
        expect(parsed.daysOfWeek.length, expression).toBeGreaterThan(0)
        expect(
          parsed.minutes.every((v) => v >= 0 && v <= 59),
          expression,
        ).toBe(true)
        expect(
          parsed.hours.every((v) => v >= 0 && v <= 23),
          expression,
        ).toBe(true)
        expect(
          parsed.daysOfMonth.every((v) => v >= 1 && v <= 31),
          expression,
        ).toBe(true)
        expect(
          parsed.months.every((v) => v >= 1 && v <= 12),
          expression,
        ).toBe(true)
        expect(
          parsed.daysOfWeek.every((v) => v >= 0 && v <= 6),
          expression,
        ).toBe(true)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('下一次触发：严格晚于 after，且返回瞬间的本地墙钟确实命中规则', () => {
    fc.assert(
      fc.property(cronExprArb, afterIsoArb, timezoneArb, (expression, afterIso, timezone) => {
        const spec = parseCron(expression)
        expect(spec, expression).not.toBeNull()
        const parsed = spec as NonNullable<typeof spec>
        const next = nextCronTime(parsed, afterIso, timezone)
        if (next === null) return
        const label = `${expression} @ ${afterIso} ${timezone}`
        expect(Date.parse(next), label).toBeGreaterThan(Date.parse(afterIso))
        const wall = localDateTime(new Date(next), timezone)
        expect(parsed.minutes, label).toContain(wall.minute)
        expect(parsed.hours, label).toContain(wall.hour)
        expect(parsed.months, label).toContain(wall.month)
        expect(
          cronDateMatches(parsed, wall.day, weekdayOfWall(wall.year, wall.month, wall.day)),
          label,
        ).toBe(true)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('下一次触发：after 恰好是命中时刻时，返回的是再下一个（不返回自己）', () => {
    fc.assert(
      fc.property(
        cronExprArb,
        alignedAfterIsoArb,
        timezoneArb,
        (expression, afterIso, timezone) => {
          const spec = parseCron(expression)
          expect(spec, expression).not.toBeNull()
          const parsed = spec as NonNullable<typeof spec>
          const label = `${expression} @ ${afterIso} ${timezone}`
          const first = nextCronTime(parsed, afterIso, timezone)
          if (first === null) return
          // first 是从 after 出发命中的时刻；若它自身已是命中点，
          // 再从它出发必须得到更晚的时刻，不能把同一个瞬间再返回一次。
          const second = nextCronTime(parsed, first, timezone)
          expect(second, label).not.toBeNull()
          expect(Date.parse(second as string), label).toBeGreaterThan(Date.parse(first))
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('下一次触发：就是 after 之后最早命中的那一刻（独立逐分钟穷举核对）', () => {
    fc.assert(
      fc.property(dailyExprArb, afterIsoArb, timezoneArb, (expression, afterIso, timezone) => {
        const spec = parseCron(expression)
        expect(spec, expression).not.toBeNull()
        const parsed = spec as NonNullable<typeof spec>
        const label = `${expression} @ ${afterIso} ${timezone}`
        const expected = bruteForceNext(parsed, afterIso, timezone, 60 * 72)
        expect(expected, label).not.toBeNull()
        expect(nextCronTime(parsed, afterIso, timezone), label).toBe(expected)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('步长语义：`*/n` 与展开后的显式列表等价', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 59 }), (step) => {
        const explicit = Array.from({ length: Math.ceil(60 / step) }, (_, index) => index * step)
        const stepped = parseCron(`*/${step} * * * *`)
        const expanded = parseCron(`${explicit.join(',')} * * * *`)
        expect(stepped, `*/${step}`).not.toBeNull()
        expect(expanded, `*/${step}`).not.toBeNull()
        expect((stepped as NonNullable<typeof stepped>).minutes).toEqual(
          (expanded as NonNullable<typeof expanded>).minutes,
        )
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('解析：各字段取值必须升序且互不重复', () => {
    fc.assert(
      fc.property(cronExprArb, (expression) => {
        const spec = parseCron(expression)
        expect(spec, expression).not.toBeNull()
        const parsed = spec as NonNullable<typeof spec>
        const fields = [
          ['minutes', parsed.minutes],
          ['hours', parsed.hours],
          ['daysOfMonth', parsed.daysOfMonth],
          ['months', parsed.months],
          ['daysOfWeek', parsed.daysOfWeek],
        ] as const
        for (const [name, values] of fields) {
          const label = `${expression} ${name}`
          expect(values, label).toEqual([...values].sort((left, right) => left - right))
          expect(new Set(values).size, label).toBe(values.length)
        }
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('解析：domStar / dowStar 只在字段字面是 * 时成立', () => {
    fc.assert(
      fc.property(cronExprArb, (expression) => {
        const spec = parseCron(expression)
        expect(spec, expression).not.toBeNull()
        const parsed = spec as NonNullable<typeof spec>
        const fields = expression.trim().split(/\s+/)
        // `*/2`、`1-5` 这类写法都**不是**通配：日 / 周的 AND-OR 语义据此切换
        expect(parsed.domStar, expression).toBe(fields[2] === '*')
        expect(parsed.dowStar, expression).toBe(fields[4] === '*')
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('解析：字段里混入非数字字符一律拒绝', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('1a', '12x', '1.5', '1-', '3/'),
        fc.integer({ min: 0, max: 59 }),
        (broken, minute) => {
          const expression = `${minute} ${broken} * * *`
          expect(parseCron(expression), expression).toBeNull()
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('解析：越界的字段值一律拒绝', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 60, max: 99 }),
        fc.integer({ min: 24, max: 99 }),
        fc.integer({ min: 32, max: 99 }),
        fc.integer({ min: 13, max: 99 }),
        fc.integer({ min: 8, max: 99 }),
        (minute, hour, dom, month, dow) => {
          expect(parseCron(`${minute} * * * *`), 'minute').toBeNull()
          expect(parseCron(`* ${hour} * * *`), 'hour').toBeNull()
          expect(parseCron(`* * ${dom} * *`), 'dom').toBeNull()
          expect(parseCron(`* * * ${month} *`), 'month').toBeNull()
          expect(parseCron(`* * * * ${dow}`), 'dow').toBeNull()
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('夏令时重叠日：同一墙钟的全部瞬间按时间升序，且本地墙钟一致', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 59 }), (minute) => {
        // 2026-11-01 是 America/New_York 的秋调日：01:00~02:00 出现两次
        const wall = { year: 2026, month: 11, day: 1, hour: 1, minute }
        const instants = wallClockInstants(wall, 'America/New_York')
        expect(instants).toHaveLength(2)
        expect(instants).toEqual([...instants].sort())
        for (const iso of instants) {
          expect(localDateTime(new Date(iso), 'America/New_York')).toEqual(wall)
        }
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('夏令时缺口日：不存在的墙钟没有任何瞬间', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 59 }), (minute) => {
        // 2026-03-08 是 America/New_York 的春调日：02:00~03:00 直接跳过去
        const wall = { year: 2026, month: 3, day: 8, hour: 2, minute }
        expect(wallClockInstants(wall, 'America/New_York')).toHaveLength(0)
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('夏令时切换日：非重叠墙钟恰好只有一个瞬间（不多不少）', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        (hour, minute) => {
          // 秋调日（2026-11-01）：只有 01:00~01:59 出现两次，其余墙钟各一次
          if (hour === 1) return
          const autumn = { year: 2026, month: 11, day: 1, hour, minute }
          expect(wallClockInstants(autumn, 'America/New_York')).toHaveLength(1)
          // 春调日（2026-03-08）：02:00~02:59 不存在，其余墙钟各一次
          if (hour === 2) return
          const spring = { year: 2026, month: 3, day: 8, hour, minute }
          expect(wallClockInstants(spring, 'America/New_York')).toHaveLength(1)
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('周字段 0 与 7 归一为同一个周日', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 23 }),
        (minute, hour) => {
          const sunday = parseCron(`${minute} ${hour} * * 0`)
          const alsoSunday = parseCron(`${minute} ${hour} * * 7`)
          expect(sunday, '0').not.toBeNull()
          expect(alsoSunday, '7').not.toBeNull()
          expect((sunday as NonNullable<typeof sunday>).daysOfWeek).toEqual(
            (alsoSunday as NonNullable<typeof alsoSunday>).daysOfWeek,
          )
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })

  it('日 / 周语义：两者都受限时按 OR，任一为 * 时只看另一个', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.array(fc.integer({ min: 1, max: 31 }), { minLength: 1, maxLength: 3 }),
        fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 3 }),
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: 0, max: 6 }),
        (domStar, dowStar, daysOfMonth, daysOfWeek, day, weekday) => {
          const spec = {
            minutes: [0],
            hours: [0],
            daysOfMonth,
            months: [1],
            daysOfWeek,
            domStar,
            dowStar,
          }
          const domMatch = daysOfMonth.includes(day)
          const dowMatch = daysOfWeek.includes(weekday)
          const expected =
            domStar && dowStar
              ? true
              : domStar
                ? dowMatch
                : dowStar
                  ? domMatch
                  : domMatch || dowMatch
          expect(cronDateMatches(spec, day, weekday)).toBe(expected)
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    )
  })
})
