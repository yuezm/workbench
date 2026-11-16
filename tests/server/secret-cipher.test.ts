// @vitest-environment node
/**
 * 插件 secret 的加密原件：AES-256-GCM + 数据目录里的一把主密钥。
 *
 * 断言口径：往返一致、密文带版本前缀、任何篡改都抛错且文案不含内容；
 * 密钥文件不存在时生成 32 字节，空文件（上次崩在写入中间）重新生成。
 */
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CIPHER_VERSION,
  IV_BYTES,
  KEY_BYTES,
  KEY_FILE,
  decryptWithKey,
  encryptWithKey,
  loadOrCreateKey,
  createLocalCipher,
} from '../../src/server/secret-cipher'

const KEY = Buffer.alloc(KEY_BYTES, 7)
const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('encryptWithKey / decryptWithKey', () => {
  it('往返一致，且每次 IV 不同（同一明文两次密文不一样）', () => {
    const a = encryptWithKey(KEY, 'hello 世界')
    const b = encryptWithKey(KEY, 'hello 世界')
    expect(a).not.toBe(b)
    expect(decryptWithKey(KEY, a)).toBe('hello 世界')
    expect(decryptWithKey(KEY, b)).toBe('hello 世界')
  })

  it('格式：v1.<iv>.<tag>.<ciphertext>，四段且版本正确', () => {
    const parts = encryptWithKey(KEY, 'x').split('.')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe(CIPHER_VERSION)
    expect(Buffer.from(parts[1] ?? '', 'base64url')).toHaveLength(IV_BYTES)
  })

  it('篡改密文 / 版本 / IV 长度都抛错，且文案不回显内容', () => {
    const good = encryptWithKey(KEY, 'secret-value')
    const parts = good.split('.')
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('evil').toString('base64url')].join(
      '.',
    )
    expect(() => decryptWithKey(KEY, tampered)).toThrow(/密文|校验|unable|bad/u)
    expect(() => decryptWithKey(KEY, 'v2.a.b.c')).toThrow('密文格式不受支持')
    expect(() => decryptWithKey(KEY, 'v1.short.short.short')).toThrow('密文格式不受支持')
    expect(() => decryptWithKey(KEY, 'garbage')).toThrow('密文格式不受支持')
    // 错密钥：GCM tag 校验失败
    expect(() => decryptWithKey(Buffer.alloc(KEY_BYTES, 8), good)).toThrow()
  })
})

describe('loadOrCreateKey', () => {
  const memoryIo = (initial?: Buffer) => {
    const files = new Map<string, Buffer>()
    if (initial !== undefined) files.set('/data/secret.key', initial)
    return {
      files,
      io: {
        exists: (file: string) => files.has(file),
        read: (file: string) => files.get(file) ?? Buffer.alloc(0),
        write: (file: string, data: Buffer) => {
          files.set(file, data)
        },
        chmod: vi.fn(),
        mkdir: vi.fn(),
      },
    }
  }

  it('文件不存在：生成 32 字节随机密钥并落盘', () => {
    const { files, io } = memoryIo()
    const key = loadOrCreateKey('/data/secret.key', io)
    expect(key).toHaveLength(KEY_BYTES)
    expect(files.get('/data/secret.key')).toEqual(key)
  })

  it('已存在的合法密钥：原样读回，不覆盖', () => {
    const { io } = memoryIo(KEY)
    expect(loadOrCreateKey('/data/secret.key', io)).toEqual(KEY)
  })

  it('空文件 / 长度不对：重新生成（上次崩在写入中间）', () => {
    const { files, io } = memoryIo(Buffer.alloc(0))
    const key = loadOrCreateKey('/data/secret.key', io)
    expect(key).toHaveLength(KEY_BYTES)
    expect(files.get('/data/secret.key')).toEqual(key)
  })
})

describe('loadOrCreateKey（真 fs）', () => {
  it('默认写入器：目录不存在就建，密钥落盘且可再次读回', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wb-key-'))
    created.push(dir)
    const file = path.join(dir, 'nested', KEY_FILE)
    const key = loadOrCreateKey(file)
    expect(key).toHaveLength(KEY_BYTES)
    expect(existsSync(file)).toBe(true)
    expect(loadOrCreateKey(file)).toEqual(key)
  })
})

describe('createLocalCipher', () => {
  const io = () => {
    const files = new Map<string, Buffer>()
    return {
      files,
      io: {
        exists: (file: string) => files.has(file),
        read: (file: string) => files.get(file) ?? Buffer.alloc(0),
        write: (file: string, data: Buffer) => {
          files.set(file, data)
        },
        mkdir: () => undefined,
      },
    }
  }

  it('懒加载：第一次用到才读盘；可用性与往返一致', () => {
    const { io: keyIo } = io()
    const cipher = createLocalCipher({ keyFile: '/data/secret.key', io: keyIo })
    expect(cipher.available()).toBe(true)
    const encrypted = cipher.encrypt('plugin-secret')
    expect(cipher.decrypt(encrypted)).toBe('plugin-secret')
    expect(cipher.keyFile).toBe('/data/secret.key')
  })

  it('密钥不可用：available=false，encrypt 抛可读错误并记日志（不含内容）', () => {
    const log = vi.fn()
    const cipher = createLocalCipher({
      keyFile: '/data/secret.key',
      io: {
        exists: () => true,
        read: () => {
          throw new Error('EACCES')
        },
        write: () => undefined,
        mkdir: () => undefined,
      },
      log,
    })
    expect(cipher.available()).toBe(false)
    expect(() => cipher.encrypt('x')).toThrow(/插件密钥不可用/u)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0])).not.toContain('x')
  })

  it('解密失败（换密钥后）：抛错，调用方按该键不可用降级', () => {
    const cipher = createLocalCipher({ keyFile: '/data/secret.key', io: io().io })
    const other = createLocalCipher({ keyFile: '/data/other.key', io: io().io })
    expect(() => other.decrypt(cipher.encrypt('v'))).toThrow()
  })
})
