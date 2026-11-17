/**
 * cron 表达式（纯函数，M6）：解析 / 匹配 / 下一次触发时刻。
 *
 * 支持 5 字段 `分 时 日 月 周`：
 * - `*`、数字、区间 `a-b`、步长（`*` 后接 `/n`）、列表 `a,b,c`；
 * - 日与周同时受限时按 OR（Vixie cron 语义）；周 0/7 都是周日。
 *
 * 时区墙钟：`nextCronTime` 按传入的 IANA 时区求下一次触发；夏令时语义：
 * - 跳过的墙钟时刻（春调缺口）不触发；
 * - 重复的墙钟时刻（秋调重叠）只触发一次——由调用方用 `cronLocalKey` 去重；
 * - 停机错过只补最近一次，由 `kernel/rules` 的 `cronDue` 负责。
 *
 * 不读时钟、不读文件；`after` 与 `timezone` 都由边界传入。
 */

export interface CronParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

export interface CronSpec {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  /** 日字段是否为 `*`（决定 dom/dow 的 AND/OR） */
  domStar: boolean
  /** 周字段是否为 `*` */
  dowStar: boolean
}

/** 最多向后找 4 年（覆盖 2 月 29 日这类低频规则）。 */
const MAX_DAYS = 366 * 4 + 1

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  formatters.set(timezone, created)
  return created
}

function partValue(parts: Intl.DateTimeFormatPart[], type: string): number {
  const map: Record<string, string> = {}
  for (const part of parts) map[part.type] = part.value
  return Number(map[type])
}

/** 某一瞬间在指定时区的墙钟时间（年 / 月 / 日 / 时 / 分）。 */
export function localDateTime(instant: Date, timezone: string): CronParts {
  const parts = formatter(timezone).formatToParts(instant)
  return {
    year: partValue(parts, 'year'),
    month: partValue(parts, 'month'),
    day: partValue(parts, 'day'),
    hour: partValue(parts, 'hour'),
    minute: partValue(parts, 'minute'),
  }
}

/** 墙钟分钟键（用于「重复的墙钟时刻只触发一次」）。 */
export function cronLocalKey(iso: string, timezone: string): string {
  const parts = localDateTime(new Date(iso), timezone)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}

/** 该瞬间相对 UTC 的偏移（毫秒，整分钟取整；历史秒级偏移不影响本地规则）。 */
function offsetMs(instantMs: number, timezone: string): number {
  const local = localDateTime(new Date(instantMs), timezone)
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)
  const offset = localAsUtc - instantMs
  return Math.round(offset / 60_000) * 60_000
}

/**
 * 墙钟时间 → 可能的 UTC 瞬间（夏令时重叠时有两个；缺口时没有）。
 * 只返回真正落在该墙钟的瞬间，按时间升序。
 */
function instantsOfLocal(wall: CronParts, timezone: string): number[] {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  // 采样多个时刻的偏移：夏令时切换前后偏移不同（秋调同一墙钟有两个合法瞬间）。
  const offsets = new Set<number>()
  for (const deltaHours of [-26, -12, -6, -1, 0, 1, 6, 12, 26]) {
    offsets.add(offsetMs(guess + deltaHours * 3_600_000, timezone))
  }
  const hits = new Set<number>()
  for (const offset of offsets) {
    const instant = guess - offset
    const local = localDateTime(new Date(instant), timezone)
    if (
      local.year === wall.year &&
      local.month === wall.month &&
      local.day === wall.day &&
      local.hour === wall.hour &&
      local.minute === wall.minute
    ) {
      hits.add(instant)
    }
  }
  return [...hits].sort((left, right) => left - right)
}

function parseNumber(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return parsed < min || parsed > max ? null : parsed
}

/** 单个字段 → 取值集合；语法非法返回 null。 */
function parseField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>()
  for (const rawPart of field.split(',')) {
    if (rawPart === '') return null
    let body = rawPart
    let step = 1
    const slash = body.indexOf('/')
    if (slash >= 0) {
      const stepText = body.slice(slash + 1)
      if (!/^\d+$/.test(stepText)) return null
      step = Number(stepText)
      if (step < 1) return null
      body = body.slice(0, slash)
    }
    let lo: number
    let hi: number
    if (body === '*') {
      lo = min
      hi = max
    } else if (body.includes('-')) {
      const [left, right, extra] = body.split('-')
      if (extra !== undefined || left === undefined || right === undefined) return null
      const parsedLeft = parseNumber(left, min, max)
      const parsedRight = parseNumber(right, min, max)
      if (parsedLeft === null || parsedRight === null || parsedLeft > parsedRight) return null
      lo = parsedLeft
      hi = parsedRight
    } else {
      const single = parseNumber(body, min, max)
      if (single === null) return null
      if (slash < 0) {
        values.add(single)
        continue
      }
      lo = single
      hi = max
    }
    for (let value = lo; value <= hi; value += step) values.add(value)
  }
  return [...values].sort((left, right) => left - right)
}

/** 解析 5 字段 cron；语法非法返回 null（`decide` 据此整批拒绝规则）。 */
export function parseCron(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minuteText, hourText, domText, monthText, dowText] = fields as [
    string,
    string,
    string,
    string,
    string,
  ]

  const minutes = parseField(minuteText, 0, 59)
  const hours = parseField(hourText, 0, 23)
  const daysOfMonth = parseField(domText, 1, 31)
  const months = parseField(monthText, 1, 12)
  const rawDaysOfWeek = parseField(dowText, 0, 7)
  if (
    minutes === null ||
    hours === null ||
    daysOfMonth === null ||
    months === null ||
    rawDaysOfWeek === null
  ) {
    return null
  }
  // 0 与 7 都是周日：归一后去重
  const daysOfWeek = [...new Set(rawDaysOfWeek.map((value) => (value === 7 ? 0 : value)))].sort(
    (left, right) => left - right,
  )
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domStar: domText.trim() === '*',
    dowStar: dowText.trim() === '*',
  }
}

interface CivilDate {
  year: number
  month: number
  day: number
}

function addDays(date: CivilDate, delta: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + delta))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

/** 日 / 周字段匹配（月由调用方先判断；dom 与 dow 同时受限时 OR）。 */
export function cronDateMatches(spec: CronSpec, day: number, weekday: number): boolean {
  const domMatch = spec.daysOfMonth.includes(day)
  const dowMatch = spec.daysOfWeek.includes(weekday)
  if (spec.domStar && spec.dowStar) return true
  if (spec.domStar) return dowMatch
  if (spec.dowStar) return domMatch
  return domMatch || dowMatch
}

/**
 * 下一次触发时刻（严格晚于 `after`）；找不到返回 null。
 * 按本地日期逐天、再按允许的时 / 分升序找，墙钟缺口自动跳过。
 */
export function nextCronTime(spec: CronSpec, after: string, timezone: string): string | null {
  const afterMs = Date.parse(after)
  if (!Number.isFinite(afterMs)) return null
  // 起点 = after 之后一分钟的本地墙钟；按本地日期逐天扫描
  const start = localDateTime(new Date(afterMs + 60_000), timezone)
  const startDate: CivilDate = { year: start.year, month: start.month, day: start.day }

  for (let offset = 0; offset < MAX_DAYS; offset += 1) {
    const date = addDays(startDate, offset)
    if (!spec.months.includes(date.month)) continue
    if (!cronDateMatches(spec, date.day, weekdayOf(date))) continue
    const startHour = offset === 0 ? start.hour : 0
    const startMinute = offset === 0 ? start.minute : 0
    for (const hour of spec.hours) {
      if (hour < startHour) continue
      for (const minute of spec.minutes) {
        if (hour === startHour && minute < startMinute) continue
        const wall: CronParts = { ...date, hour, minute }
        const hit = instantsOfLocal(wall, timezone).find((instant) => instant > afterMs)
        if (hit !== undefined) return new Date(hit).toISOString()
      }
    }
  }
  return null
}

/** 供测试直接构造：某墙钟时间对应的全部 UTC 瞬间（夏令时重叠有两个）。 */
export function wallClockInstants(wall: CronParts, timezone: string): string[] {
  return instantsOfLocal(wall, timezone).map((instant) => new Date(instant).toISOString())
}

/** 供测试/校验使用：给定年月是否在范围内（避免导出内部实现）。 */
export const CRON_MAX_LOOKAHEAD_DAYS = MAX_DAYS
