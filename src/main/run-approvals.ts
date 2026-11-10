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
import { readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { RunApproval } from '../protocol/views'

/** dsh 会话日志的固定文件名（v4 格式） */
const LOG_FILE = 'session.v4.jsonl.zstd'
/** zstd 帧魔数（小端）：一个日志文件由多帧首尾相接地追加而成 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const
/** 单次解析的文件上限；超过就放弃（审计视图不值得为一个大日志占内存） */
const MAX_FILE_BYTES = 32 * 1024 * 1024
/** 解压后文本上限：坏帧 / 异常输入不能把宿主内存拖垮 */
const MAX_DECODED_BYTES = 64 * 1024 * 1024
/** 返回给 UI 的记录上限 */
export const MAX_APPROVALS = 50
/** 理由文本上限（模型自由文本，展示层只截一段） */
const MAX_REASON_CHARS = 500

/**
 * 按 zstd 帧结构切出每帧的压缩长度（RFC 8878）。
 *
 * 必须自己算帧边界，不能只看魔数：压缩数据内部会偶然出现同样的 4 字节（实测 1MB 日志里
 * 魔数命中 705 次恰好都是真实帧，但这不是可依赖的保证）。更要命的是不同 Node 版本对
 * `zstdDecompressSync(尾部缓冲)` 的语义不同——Node 22 只解第一帧，Electron 的 Node 24
 * 会把「从这里到文件末尾」的所有帧都解出来，于是按魔数对每个起点解一次会变成 O(n²)：
 * 705 帧累积解出 1GB 垃圾、耗时 1.5s，把主进程堆和事件循环一起拖死。
 *
 * 切出精确边界后每帧单独解压，两版本行为一致（1MB 日志 705 帧约 26ms）。
 * 遇到半帧 / 坏帧（block 越界）即停止，保留前面已解析的完整帧。
 */
function frameLengths(raw: Buffer): number[] {
  const lengths: number[] = []
  let pos = 0
  while (pos + 4 <= raw.length) {
    if (
      raw[pos] !== ZSTD_MAGIC[0] ||
      raw[pos + 1] !== ZSTD_MAGIC[1] ||
      raw[pos + 2] !== ZSTD_MAGIC[2] ||
      raw[pos + 3] !== ZSTD_MAGIC[3]
    ) {
      break
    }
    let p = pos + 4
    if (p >= raw.length) break
    const descriptor = raw[p]
    p += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const hasChecksum = (descriptor >> 2) & 1
    const dictIdFlag = descriptor & 3
    if (!singleSegment) p += 1 // window descriptor
    p += [0, 1, 2, 4][dictIdFlag] // dictionary id
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    p += fcsSize
    if (p > raw.length) break
    let ok = true
    for (;;) {
      if (p + 3 > raw.length) {
        ok = false
        break
      }
      const header = raw[p] | (raw[p + 1] << 8) | (raw[p + 2] << 16)
      p += 3
      const lastBlock = header & 1
      const blockType = (header >> 1) & 3
      const blockSize = header >> 3
      if (blockType === 3) {
        ok = false // reserved：不是合法帧
        break
      }
      p += blockType === 1 ? 1 : blockSize // RLE 固定 1 字节，其余按 blockSize
      if (p > raw.length) {
        ok = false
        break
      }
      if (lastBlock) break
    }
    if (!ok) break
    if (hasChecksum) p += 4
    if (p > raw.length) break
    lengths.push(p - pos)
    pos = p
  }
  return lengths
}

/**
 * 解压由多帧拼成的会话日志。
 *
 * 逐帧单解（输入恰好一帧），跨 Node 版本行为一致；坏帧跳过，不拖垮调用方。
 * 解压总量超过 `MAX_DECODED_BYTES` 时提前停止，返回已解出的部分。
 */
export function decodeSessionLog(raw: Buffer): string {
  if (raw.length === 0) return ''
  const chunks: Buffer[] = []
  let decoded = 0
  let offset = 0
  for (const length of frameLengths(raw)) {
    try {
      const out = zstdDecompressSync(raw.subarray(offset, offset + length))
      decoded += out.length
      if (decoded > MAX_DECODED_BYTES) break
      chunks.push(out)
    } catch {
      // 单个坏帧跳过，不影响其它完整帧
    }
    offset += length
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
 * 所有失败都降级成空数组。读文件与解压都是异步的：这条视图会在每个 `run.` 事实到来时
 * 被重取，同步阻塞主进程事件循环会把整个窗口的 IPC 一起卡住。
 */
export async function readRunApprovals(
  root: string,
  sessionId: string | null,
): Promise<RunApproval[]> {
  if (sessionId === null) return []
  const file = locateSessionLog(root, sessionId)
  if (file === null) return []
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return []
    return parseApprovals(decodeSessionLog(await readFile(file)))
  } catch {
    return []
  }
}
