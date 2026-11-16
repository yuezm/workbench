/**
 * 插件 secret 的加密原件（服务器形态）：数据目录里一把主密钥 + AES-256-GCM。
 *
 * 取代 Electron 的 `safeStorage`：那个 API 的能力来自操作系统钥匙串，离开桌面应用就没有了。
 * 常驻服务的等价物是「一把只有服务账号能读的主密钥文件」：
 *
 * - 密钥 32 字节随机，落在 `<dataDir>/secret.key`，创建时 `0600`（Windows 上目录 ACL 由
 *   `host/secure-dir.ts` 收到「本账号 + SYSTEM」，见启动日志）；
 * - 密文格式 `v1.<iv>.<tag>.<ciphertext>`，每段 base64url：带版本前缀是为了以后换算法时
 *   能识别老密文而不是把它当坏数据；
 * - 解密失败只抛错，**不把明文/密文写进错误文案**（调用方按「该键不可用」降级）。
 *
 * 有意不做密钥派生：主密钥本来就是 32 字节随机数，scrypt 只会增加启动成本而不增加强度。
 * 换机/删 `secret.key` 会让已存的 secret 失效——这是「不可恢复但可重填」的失败，重填即可。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { SecretCipher } from '../host/plugins/settings'

/** 主密钥字节数（AES-256） */
export const KEY_BYTES = 32
/** 密钥文件名（与 `token`、`ai-workflow.db` 同级） */
export const KEY_FILE = 'secret.key'
/** 密文版本前缀 */
export const CIPHER_VERSION = 'v1'
/** GCM 推荐的 IV 长度 */
export const IV_BYTES = 12
/** GCM tag 长度 */
export const TAG_BYTES = 16

const base64url = (buffer: Buffer): string => buffer.toString('base64url')
const fromBase64url = (text: string): Buffer => Buffer.from(text, 'base64url')

/** 用给定密钥加密；纯函数，测试可直接断言往返与格式。 */
export function encryptWithKey(key: Buffer, plain: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [CIPHER_VERSION, base64url(iv), base64url(tag), base64url(ciphertext)].join('.')
}

/** 用给定密钥解密；格式/版本/tag 任一不符都抛错（文案不含内容）。 */
export function decryptWithKey(key: Buffer, payload: string): string {
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) {
    throw new Error('密文格式不受支持')
  }
  const iv = fromBase64url(parts[1] ?? '')
  const tag = fromBase64url(parts[2] ?? '')
  const ciphertext = fromBase64url(parts[3] ?? '')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('密文格式不受支持')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export interface KeyIO {
  exists?: (file: string) => boolean
  read?: (file: string) => Buffer
  write?: (file: string, data: Buffer) => void
  chmod?: (file: string, mode: number) => void
  mkdir?: (dir: string) => void
  random?: (size: number) => Buffer
}

/**
 * 读主密钥；不存在就生成一把。
 *
 * 生成直接落盘（`mode: 0600`）而不是「写临时文件再 rename」：主密钥是进程独占的，
 * 启动期不存在并发写者；代价是进程若正好崩在写入中间会留下一个短文件——下次启动
 * 读到长度不对就重新生成（旧密文解不开，重填 secret 即可），不会把空文件当密钥用。
 */
export function loadOrCreateKey(file: string, io: KeyIO = {}): Buffer {
  const exists = io.exists ?? existsSync
  const read = io.read ?? ((target: string) => readFileSync(target))
  const write =
    io.write ??
    ((target: string, data: Buffer) => {
      // 先写再 chmod：文件不存在时 chmod 会 ENOENT（桌面时代 safeStorage 不需要自己建文件，
      // 这个顺序问题只有在服务器形态第一次运行时才暴露）。
      writeFileSync(target, data, { mode: 0o600 })
      try {
        chmodSync(target, 0o600)
      } catch {
        // 某些文件系统（FAT / 部分容器卷）不支持改权限：写入时已带 mode，尽力而为
      }
    })
  const mkdir = io.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true }))
  const random = io.random ?? ((size: number) => randomBytes(size))

  if (exists(file)) {
    const current = read(file)
    if (current.length === KEY_BYTES) return current
    // 空文件/被截断：重新生成（旧密文解不开，属可恢复失败，重填 secret 即可）
  }
  mkdir(path.dirname(file))
  const key = random(KEY_BYTES)
  write(file, key)
  return key
}

export interface LocalCipherOptions {
  /** 主密钥路径（缺省 `<dataDir>/secret.key`） */
  keyFile: string
  /** 密钥 IO 注入（测试用） */
  io?: KeyIO
  /** 日志：密钥不可用时留一行（不含任何密钥内容） */
  log?: (line: string) => void
}

export interface LocalCipher extends SecretCipher {
  /** 主密钥文件路径（设置页显示「密钥在哪」用） */
  readonly keyFile: string
}

/**
 * 懒加载的主密钥加密：第一次用到才读盘。
 *
 * 为什么懒：启动路径上不该因为「数据目录暂时不可写」就起不来——工作台不存 secret 也能跑，
 * 只有真的要写 secret 时才必须给出可读的失败。
 */
export function createLocalCipher(options: LocalCipherOptions): LocalCipher {
  let key: Buffer | null = null
  let logged = false
  const log = options.log ?? ((): void => undefined)

  const ensure = (): Buffer => {
    if (key !== null) return key
    try {
      key = loadOrCreateKey(options.keyFile, options.io)
      return key
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 同一个原因只记一次：available() 之后紧跟 encrypt() 时不该刷两条一样的日志
      if (!logged) {
        logged = true
        log(`插件密钥不可用（${options.keyFile}）：${message}`)
      }
      throw new Error(`插件密钥不可用：${message}`, { cause: error })
    }
  }

  return {
    keyFile: options.keyFile,
    available: () => {
      try {
        ensure()
        return true
      } catch {
        return false
      }
    },
    encrypt: (plain) => encryptWithKey(ensure(), plain),
    decrypt: (cipher) => decryptWithKey(ensure(), cipher),
  }
}
