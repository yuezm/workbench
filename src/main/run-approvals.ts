/**
 * 沙箱提权记录（`run.approvals`，宿主侧只读实现）。
 *
 * 数据只在 dsh 的会话日志里：`<sessionRoot>/<cwd 槽>/<sessionId>/session.v4.jsonl.zstd`
 * 中的 `approval/asked` / `approval/decided` 事件。运行时对这些请求的回答是自动的
 * （dsh 桥接层恒回 `allowed-once`），所以 UI 侧原本完全看不到；这里把日志读出来
 * 拼成一条条记录，**不写库、不进事件流、不改协议**（与 Multica 把 approval 落成
 * 审计事件同一条思路：可以自动放行，但不能无声）。
 *
 * 边界：只读、只在 query 时读、任何读取/解压/解析失败都降级成空数组——
 * 审计缺失不该拖垮任务详情。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { RunApproval } from '../protocol/views'

/** dsh 会话日志的固定文件名（v4 格式） */
const LOG_FILE = 'session.v4.jsonl.zstd'
/** zstd 帧魔数：一个日志文件由多帧首尾相接地追加而成 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 单次解析的文件上限；超过就放弃（审计视图不值得为一个大日志占内存） */
const MAX_FILE_BYTES = 32 * 1024 * 1024
/** 候选帧上限：解压失败的重试次数阀门，防止异常文件把 CPU 拖死 */
const MAX_FRAMES = 4096
/** 返回给 UI 的记录上限 */
export const MAX_APPROVALS = 50
/** 理由文本上限（模型自由文本，展示层只截一段） */
const MAX_REASON_CHARS = 500

/**
 * 解压由多帧拼成的会话日志。
 *
 * Node 的 `zstdDecompressSync` 只吃第一帧，尾随帧会被丢弃，所以这里按魔数切候选
 * 起点逐帧解压：误命中（压缩数据里恰好出现魔数）会解压失败并被跳过，不影响真正的帧。
 */
export function decodeSessionLog(raw: Buffer): string {
  if (raw.length === 0) return ''
  const starts: number[] = [0]
  for (let i = raw.indexOf(ZSTD_MAGIC, 4); i !== -1 && starts.length < MAX_FRAMES;) {
    starts.push(i)
    i = raw.indexOf(ZSTD_MAGIC, i + 4)
  }
  const chunks: Buffer[] = []
  for (const start of starts) {
    try {
      chunks.push(zstdDecompressSync(raw.subarray(start)))
    } catch {
      // 半帧（正在写入）/ 误命中：跳过，下一步继续找后面的帧
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

interface RawApprovalRecord {
  type?: unknown
  time?: unknown
  data?: unknown
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * 把会话日志文本解析成提权记录：`approval/asked` 建条目，`approval/decided` 补结果。
 * 只有 decided 没有 asked 的记录跳过（缺工具与理由，描述不了发生了什么）。
 */
export function parseApprovals(text_: string): RunApproval[] {
  const byId = new Map<string, RunApproval>()
  for (const line of text_.split('\n')) {
    if (!line.includes('"approval/')) continue
    let record: RawApprovalRecord
    try {
      record = JSON.parse(line) as RawApprovalRecord
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const data = record.data as Record<string, unknown> | undefined
    if (typeof data !== 'object' || data === null) continue
    const id = text(data.id)
    if (id === '') continue
    if (record.type === 'approval/asked') {
      const time =
        typeof record.time === 'number' && Number.isFinite(record.time) ? record.time : null
      byId.set(id, {
        id,
        at: time === null ? '' : new Date(time).toISOString(),
        tool: text(data.toolName),
        callId: text(data.callId) === '' ? null : text(data.callId),
        reason: text(data.reason).trim().slice(0, MAX_REASON_CHARS),
        outcome: null,
      })
      continue
    }
    if (record.type === 'approval/decided') {
      const asked = byId.get(id)
      if (asked === undefined) continue
      byId.set(id, { ...asked, outcome: text(data.outcome) === '' ? null : text(data.outcome) })
    }
  }
  return [...byId.values()]
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .slice(0, MAX_APPROVALS)
}

/** 在会话根下按 `<槽>/<sessionId>/session.v4.jsonl.zstd` 找该会话的日志文件。 */
export function locateSessionLog(root: string, sessionId: string): string | null {
  if (sessionId === '') return null
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return null
  }
  for (const slot of entries) {
    const candidate = path.join(root, slot, sessionId, LOG_FILE)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 该槽没有这个会话：继续找下一个
    }
  }
  return null
}

/**
 * 读一个 run 的提权记录；`sessionId` 为空（从未建立会话）时直接返回空。
 * 所有失败都降级成空数组。
 */
export function readRunApprovals(root: string, sessionId: string | null): RunApproval[] {
  if (sessionId === null) return []
  const file = locateSessionLog(root, sessionId)
  if (file === null) return []
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return []
    return parseApprovals(decodeSessionLog(readFileSync(file)))
  } catch {
    return []
  }
}
