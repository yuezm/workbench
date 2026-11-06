import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_APPROVALS,
  decodeSessionLog,
  locateSessionLog,
  parseApprovals,
  readRunApprovals,
} from '../../src/main/run-approvals'
import type { RunApproval } from '../../src/protocol/views'

const ASKED = (id: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'approval/asked',
    seq: 1,
    time: 1793755758879,
    data: { id, toolName: 'pwsh', callId: 'call_1', reason: ' 修 ACL ', ...over },
  })

const DECIDED = (id: string, outcome = 'allowed-once'): string =>
  JSON.stringify({ type: 'approval/decided', seq: 2, time: 1793755758880, data: { id, outcome } })

/** 多帧拼接：模拟 dsh 逐次 flush 追加写入的日志文件 */
const frames = (...texts: string[]): Buffer =>
  Buffer.concat(texts.map((text) => zstdCompressSync(Buffer.from(text, 'utf8'))))

const at = (ms: number): string => new Date(ms).toISOString()

describe('main/run-approvals', () => {
  const dirs: string[] = []
  const tempDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wb-approvals-'))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  describe('decodeSessionLog', () => {
    it('单帧 / 多帧拼接都能还原全文', () => {
      expect(decodeSessionLog(frames('a\nb\n'))).toBe('a\nb\n')
      expect(decodeSessionLog(frames('a\n', 'b\n', 'c\n'))).toBe('a\nb\nc\n')
    })

    it('空文件与非法数据不炸：能解多少算多少', () => {
      expect(decodeSessionLog(Buffer.alloc(0))).toBe('')
      // 没有魔数的裸字节：解不出任何帧
      expect(decodeSessionLog(Buffer.from('not a zstd frame'))).toBe('')
      // 坏帧夹在好帧中间：坏帧跳过，好帧照常解出来
      const broken = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03, 0x04])
      expect(decodeSessionLog(Buffer.concat([frames('ok\n'), broken]))).toBe('ok\n')
    })
  })

  describe('parseApprovals', () => {
    it('asked + decided 按 id 合成一条记录', () => {
      const items = parseApprovals([ASKED('a1'), DECIDED('a1'), ''].join('\n'))
      expect(items).toEqual<RunApproval[]>([
        {
          id: 'a1',
          at: at(1793755758879),
          tool: 'pwsh',
          callId: 'call_1',
          reason: '修 ACL',
          outcome: 'allowed-once',
        },
      ])
    })

    it('只有 asked：结果为 null（未落定）；只有 decided：跳过', () => {
      const items = parseApprovals([ASKED('a1'), DECIDED('orphan')].join('\n'))
      expect(items).toHaveLength(1)
      expect(items[0]?.outcome).toBeNull()
    })

    it('脏行 / 未知类型 / 缺 id / 缺 data 全部忽略', () => {
      const text = [
        'not json',
        '{"type":"approval/asked"}',
        '{"type":"approval/decided","data":{"id":"a1","outcome":"allowed-once"}}',
        '{"type":"approval/asked","data":{}}',
        '{"type":"approval/asked","data":{"id":7}}',
        '{"type":"other","data":{"id":"a2"}}',
        ASKED('good'),
      ].join('\n')
      const items = parseApprovals(text)
      expect(items.map((item) => item.id)).toEqual(['good'])
    })

    it('理由去空白并截断；缺 time / callId / toolName 有兜底', () => {
      const long = 'x'.repeat(900)
      const text = [
        '{"type":"approval/asked","data":{"id":"a1","reason":"  ' + long + '  "}}',
        ASKED('a2', { callId: undefined, toolName: undefined, reason: '' }),
      ].join('\n')
      const items = parseApprovals(text)
      expect(items[0]?.reason).toHaveLength(500)
      expect(items[0]?.at).toBe('')
      expect(items[0]?.tool).toBe('')
      expect(items[0]?.callId).toBeNull()
      expect(items[1]?.reason).toBe('')
    })

    it('JSON 合法但不是对象 / data 不是对象：忽略', () => {
      const text = ['"approval/"', '{"type":"approval/asked","data":"nope"}', ASKED('good')].join(
        '\n',
      )
      expect(parseApprovals(text).map((item) => item.id)).toEqual(['good'])
    })

    it('按时间升序，并且最多返回 MAX_APPROVALS 条', () => {
      const lines: string[] = []
      for (let i = 0; i < MAX_APPROVALS + 5; i += 1) {
        lines.push(ASKED(`a${String(i).padStart(3, '0')}`, undefined))
      }
      const items = parseApprovals(lines.join('\n'))
      expect(items).toHaveLength(MAX_APPROVALS)
      const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      expect(items).toEqual(sorted)
    })
  })

  describe('locateSessionLog / readRunApprovals', () => {
    const plant = (root: string, sessionId: string): string => {
      const dir = path.join(root, '--D-Codes-workbench--', sessionId)
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'session.v4.jsonl.zstd')
      writeFileSync(file, frames(ASKED('a1') + '\n', DECIDED('a1') + '\n'))
      return file
    }

    it('按会话根下的槽目录定位日志文件', () => {
      const root = tempDir()
      const file = plant(root, 'sess-1')
      expect(locateSessionLog(root, 'sess-1')).toBe(file)
      expect(locateSessionLog(root, 'sess-404')).toBeNull()
      expect(locateSessionLog(root, '')).toBeNull()
      expect(locateSessionLog(path.join(root, 'missing'), 'sess-1')).toBeNull()
    })

    it('端到端：解压 + 解析出提权记录', () => {
      const root = tempDir()
      plant(root, 'sess-1')
      expect(readRunApprovals(root, 'sess-1')).toHaveLength(1)
    })

    it('槽下同名的目录不是日志文件：定位返回 null', () => {
      const root = tempDir()
      const slot = path.join(root, '--D-Codes-workbench--', 'sess-dir')
      mkdirSync(path.join(slot, 'session.v4.jsonl.zstd'), { recursive: true })
      expect(locateSessionLog(root, 'sess-dir')).toBeNull()
      // 槽位是文件而不是目录时直接跳过
      const oddRoot = tempDir()
      writeFileSync(path.join(oddRoot, 'not-a-slot'), 'x')
      expect(locateSessionLog(oddRoot, 'sess-1')).toBeNull()
    })

    it('降级：无 sessionId / 找不到文件 / 超大文件 / 坏文件都返回空', () => {
      const root = tempDir()
      expect(readRunApprovals(root, null)).toEqual([])
      expect(readRunApprovals(root, 'nope')).toEqual([])

      const big = plant(root, 'sess-big')
      truncateSync(big, 33 * 1024 * 1024)
      expect(readRunApprovals(root, 'sess-big')).toEqual([])

      const broken = plant(root, 'sess-broken')
      writeFileSync(broken, Buffer.from('garbage'))
      expect(readRunApprovals(root, 'sess-broken')).toEqual([])
    })
  })
})
