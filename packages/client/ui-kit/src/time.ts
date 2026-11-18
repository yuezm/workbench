/**
 * 时间展示：内核与协议里一律存 ISO 8601（UTC），界面给人看的必须是本机时区。
 *
 * 为什么单独一份：原先授权卡与规则表各自写了一遍 pad，任务活动流 / 任务信息 /
 * 服务信息 / 线程笔记干脆直接渲染 ISO 原文——同一台机器上出现两种时刻，
 * 看起来就是「时间差 8 小时」。口径集中在这里，一处改对，界面处处一致。
 *
 * 用 `Intl` 而不是 `Date#getHours()`：只有它能按显式时区格式化，
 * 单测才能钉住「UTC 输入 → 东八区输出」而不用去改测试进程的 TZ。
 */

/** 缓存 formatter：活动流一次渲染几十上百条，重复构造 `Intl.DateTimeFormat` 是白烧 CPU。 */
const formatters = new Map<string, Intl.DateTimeFormat>()

const pad = (value: string): string => String(value).padStart(2, '0')

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  formatters.set(timeZone, created)
  return created
}

interface ClockParts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
}

/**
 * ISO → 本机时区分量。
 *
 * 解析失败（空串、不合法时刻、不合法时区）返回 null：调用方把原值原样吐回去，
 * 界面上看得见「这行数据有问题」，而不是被悄悄换成今天。
 */
function readParts(iso: string, timeZone: string | undefined): ClockParts | null {
  const trimmed = iso.trim()
  if (trimmed === '') return null
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) return null
  const zone =
    timeZone === undefined || timeZone === ''
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : timeZone
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = formatter(zone).formatToParts(new Date(ms))
  } catch {
    // 时区名不合法（RangeError）——与「时刻不合法」同样处理：不编造时刻。
    return null
  }
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return {
    year: pick('year'),
    month: pad(pick('month')),
    day: pad(pick('day')),
    hour: pad(pick('hour')),
    minute: pad(pick('minute')),
  }
}

/**
 * 完整时刻：`YYYY-MM-DD HH:mm`（本机时区）。
 *
 * 验收/复核要看的是「这台机器上几点发生」，所以带年份；秒级不展示
 * （内核时刻精确到毫秒，但界面上一秒的差别没有决策价值）。
 */
export function formatLocalDateTime(iso: string, timeZone?: string): string {
  const parts = readParts(iso, timeZone)
  if (parts === null) return iso
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

/**
 * 紧凑时刻：`MM-DD HH:mm`（本机时区）。
 *
 * 用在「下次触发」这类近未来读数上：省掉年份，一行里还能并排放下规则名。
 */
export function formatLocalShort(iso: string, timeZone?: string): string {
  const parts = readParts(iso, timeZone)
  if (parts === null) return iso
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}
