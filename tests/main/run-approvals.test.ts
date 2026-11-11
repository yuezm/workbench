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
      // 坏帧夹在好帧后面：好帧照常解出来，坏帧后不再有可解内容
      const broken = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03, 0x04])
      expect(decodeSessionLog(Buffer.concat([frames('ok\n'), broken]))).toBe('ok\n')
    })

    it('毫秒级畸形帧：魔数截断 / 缺 block 头 / 保留 block / 缺校验和都只丢该帧', () => {
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
      // 只有魔数：后面没有描述符
      expect(decodeSessionLog(magic)).toBe('')
      // 描述符要求 window descriptor 与 frame content size，数据只到描述符
      expect(decodeSessionLog(Buffer.concat([magic, Buffer.from([0x00])]))).toBe('')
      // 描述符与 FCS 齐了，block 头不足 3 字节
      expect(decodeSessionLog(Buffer.from([...magic, 0x20, 0x00, 0x00, 0x00]))).toBe('')
      // blockType=3 是保留值：整帧作废
      expect(decodeSessionLog(Buffer.from([...magic, 0x20, 0x00, 0x06, 0x00, 0x00]))).toBe('')
      // 声明了校验和但末尾没有 4 字节：帧不完整
      expect(decodeSessionLog(Buffer.from([...magic, 0x24, 0x00, 0x01, 0x00, 0x00]))).toBe('')
      // 完整帧在前、畸形帧在后：完整帧照常解出来
      expect(
        decodeSessionLog(Buffer.concat([frames('ok\n'), Buffer.from([...magic, 0x20, 0x00])])),
      ).toBe('ok\n')
    })

    it('大量帧（真实日志是逐次 flush 追加的）逐帧不乱序、不漏帧', () => {
      // 回归：Electron 的 Node 24 会对「起点到末尾」一次解出所有后续帧，
      // 旧实现按魔数每个起点解一次会变成 O(n²)（1MB 日志解出 1GB）。
      const texts = Array.from({ length: 400 }, (_, i) => `line ${i}\n`)
      expect(decodeSessionLog(frames(...texts))).toBe(texts.join(''))
    })

    it('帧头带显式 content size（≥256 字节）与多 block 的大帧都能解出来', () => {
      // 小帧走单字节 FCS；≥256 字节的单段帧改成 2 字节 FCS（fcsFlag 1/2），必须按尺寸跳过
      const medium = 'x'.repeat(300)
      expect(decodeSessionLog(frames(medium))).toBe(medium)

      // 300KB 近似随机的日志：压缩后是一个多 block 帧（只有最后一块 lastBlock=1）
      const seed = { value: 12345 }
      const noise = Buffer.alloc(300_000)
      for (let i = 0; i < noise.length; i += 1) {
        seed.value = (seed.value * 1103515245 + 12345) >>> 0
        noise[i] = 32 + ((seed.value >>> 24) % 95) // 可打印 ASCII：UTF-8 往返无损
      }
      const big = zstdCompressSync(noise)
      expect(decodeSessionLog(big)).toBe(noise.toString('utf8'))
    })

    it('解压总量超过上限：提前停止，保留已解出的部分', () => {
      // 单个 33MB 的可压缩帧（压缩后几十字节）：两帧就把 64MB 预算撑爆
      const chunk = 'a'.repeat(33 * 1024 * 1024)
      const out = decodeSessionLog(frames(chunk, chunk))
      expect(out.length).toBe(chunk.length)
      expect(out.startsWith('aaa')).toBe(true)
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

    it('含 approval/ 前缀但 JSON 非法的行：解析失败被跳过（不炸）', () => {
      const text = ['{"type":"approval/asked", broken', ASKED('good')].join('\n')
      expect(parseApprovals(text).map((item) => item.id)).toEqual(['good'])
    })

    it('approval/ 前缀下的未知子类型（非 asked/decided）：不计入记录', () => {
      const text = ['{"type":"approval/other","data":{"id":"x"}}', ASKED('good')].join('\n')
      expect(parseApprovals(text).map((item) => item.id)).toEqual(['good'])
    })

    it('decided 的 outcome 为空串：归一到 null（不是空字符串）', () => {
      const items = parseApprovals([ASKED('a1'), DECIDED('a1', '')].join('\n'))
      expect(items).toHaveLength(1)
      expect(items[0]?.outcome).toBeNull()
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

    it('端到端：解压 + 解析出提权记录', async () => {
      const root = tempDir()
      plant(root, 'sess-1')
      expect(await readRunApprovals(root, 'sess-1')).toHaveLength(1)
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

    it('降级：无 sessionId / 找不到文件 / 超大文件 / 坏文件都返回空', async () => {
      const root = tempDir()
      expect(await readRunApprovals(root, null)).toEqual([])
      expect(await readRunApprovals(root, 'nope')).toEqual([])

      const big = plant(root, 'sess-big')
      truncateSync(big, 33 * 1024 * 1024)
      expect(await readRunApprovals(root, 'sess-big')).toEqual([])

      const broken = plant(root, 'sess-broken')
      writeFileSync(broken, Buffer.from('garbage'))
      expect(await readRunApprovals(root, 'sess-broken')).toEqual([])
    })
  })
})
