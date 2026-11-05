// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginManifest } from '../../../src/protocol/manifest'
import type { PluginSetting } from '../../../src/protocol/plugins'
import {
  createPluginSecrets,
  resolvePluginConfig,
  type PluginSecrets,
  type SecretCipher,
} from '../../../src/host/plugins/settings'

/**
 * 插件 secret 存储与配置合并（M7 D3/D5）。
 *
 * `plugin_secrets` 由 `host/schema.ts` 建表（非投影表）；这里用内存库按契约 DDL 自建，
 * 只验证本模块的读写、加密接口与「值不泄漏」，不重复 schema 用例。
 */

const PLUGIN_SECRETS_DDL = `
CREATE TABLE IF NOT EXISTS plugin_secrets (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_cipher TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);`

/** 假加密：只做可逆编码，断言「落库的是密文、读回的是明文」。 */
function fakeCipher(overrides: Partial<SecretCipher> = {}): SecretCipher {
  return {
    available: () => true,
    encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (cipher) => {
      if (!cipher.startsWith('enc:')) throw new Error('unknown cipher')
      return Buffer.from(cipher.slice(4), 'base64').toString('utf8')
    },
    ...overrides,
  }
}

let db: DatabaseSync

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(PLUGIN_SECRETS_DDL)
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

const rowsOf = (): Array<{
  pluginId: string
  key: string
  valueCipher: string
  updatedAt: string
}> =>
  (
    db
      .prepare(
        'SELECT plugin_id, key, value_cipher, updated_at FROM plugin_secrets ORDER BY plugin_id, key',
      )
      .all() as unknown as Array<{
      plugin_id: string
      key: string
      value_cipher: string
      updated_at: string
    }>
  ).map((row) => ({
    pluginId: row.plugin_id,
    key: row.key,
    valueCipher: row.value_cipher,
    updatedAt: row.updated_at,
  }))

function makeSecrets(
  overrides: { cipher?: SecretCipher; now?: () => string; log?: (line: string) => void } = {},
): PluginSecrets {
  return createPluginSecrets({
    db,
    cipher: overrides.cipher ?? fakeCipher(),
    now: overrides.now ?? (() => '2026-11-05T00:00:00.000Z'),
    log: overrides.log ?? (() => undefined),
  })
}

describe('createPluginSecrets 读写', () => {
  it('写入后按插件隔离：listSecretKeys 升序、hasSecret、readSecrets 往返明文', () => {
    const secrets = makeSecrets()
    secrets.setSecret('webhook', 'secret', 'top-secret')
    secrets.setSecret('webhook', 'altSecret', 'another')
    secrets.setSecret('other-plugin', 'secret', 'other-value')

    expect(secrets.listSecretKeys('webhook')).toEqual(['altSecret', 'secret'])
    expect(secrets.hasSecret('webhook', 'secret')).toBe(true)
    expect(secrets.hasSecret('webhook', 'missing')).toBe(false)
    expect(secrets.readSecrets('webhook')).toEqual({ altSecret: 'another', secret: 'top-secret' })
    expect(secrets.listSecretKeys('unknown')).toEqual([])
    expect(secrets.readSecrets('unknown')).toEqual({})
  })

  it('落库的是密文（不含明文），updated_at 由注入时钟决定', () => {
    const secrets = makeSecrets({ now: () => '2026-11-05T01:02:03.000Z' })
    secrets.setSecret('webhook', 'secret', 'top-secret')

    const rows = rowsOf()
    expect(rows).toHaveLength(1)
    expect(rows[0].valueCipher).not.toContain('top-secret')
    expect(rows[0].valueCipher.startsWith('enc:')).toBe(true)
    expect(rows[0].updatedAt).toBe('2026-11-05T01:02:03.000Z')
  })

  it('重复写入覆盖旧值并更新时间（不新增行）', () => {
    const now = vi.fn(() => '2026-11-05T00:00:00.000Z')
    const secrets = makeSecrets({ now })
    secrets.setSecret('webhook', 'secret', 'first')
    now.mockReturnValue('2026-11-06T00:00:00.000Z')
    secrets.setSecret('webhook', 'secret', 'second')

    expect(rowsOf()).toHaveLength(1)
    expect(rowsOf()[0].updatedAt).toBe('2026-11-06T00:00:00.000Z')
    expect(secrets.readSecrets('webhook')).toEqual({ secret: 'second' })
  })

  it('removeSecret 删除单键，不存在的键静默成功', () => {
    const secrets = makeSecrets()
    secrets.setSecret('webhook', 'secret', 'x')
    secrets.setSecret('webhook', 'altSecret', 'y')

    secrets.removeSecret('webhook', 'secret')
    secrets.removeSecret('webhook', 'ghost')
    expect(secrets.listSecretKeys('webhook')).toEqual(['altSecret'])
    expect(secrets.hasSecret('webhook', 'secret')).toBe(false)
  })

  it('cipher 不可用：拒绝写入（unsupported 口径），不落明文', () => {
    const secrets = makeSecrets({ cipher: fakeCipher({ available: () => false }) })
    expect(() => secrets.setSecret('webhook', 'secret', 'top-secret')).toThrow(
      /secret_cipher_unavailable/,
    )
    expect(rowsOf()).toEqual([])
  })

  it('加密抛错：日志不含明文，抛 secret_encrypt_failed', () => {
    const log = vi.fn()
    const secrets = makeSecrets({
      cipher: fakeCipher({
        encrypt: () => {
          throw new Error('safeStorage 不可用')
        },
      }),
      log,
    })
    expect(() => secrets.setSecret('webhook', 'secret', 'top-secret')).toThrow(
      /secret_encrypt_failed: secret/,
    )
    expect(log).toHaveBeenCalledWith(expect.stringContaining('secret 加密失败（secret）'))
    for (const call of log.mock.calls) expect(String(call[0])).not.toContain('top-secret')
    expect(rowsOf()).toEqual([])
  })

  it('解密失败只跳过该键并记日志（不泄漏密文），其它键照常可用', () => {
    const log = vi.fn()
    const secrets = makeSecrets({
      cipher: fakeCipher({
        decrypt: (cipher) => {
          if (cipher === 'broken-cipher') throw new Error('密钥失效')
          return fakeCipher().decrypt(cipher)
        },
      }),
      log,
    })
    secrets.setSecret('webhook', 'good', 'ok-value')
    db.prepare(
      'INSERT INTO plugin_secrets (plugin_id, key, value_cipher, updated_at) VALUES (?, ?, ?, ?)',
    ).run('webhook', 'broken', 'broken-cipher', '2026-11-05T00:00:00.000Z')

    expect(secrets.readSecrets('webhook')).toEqual({ good: 'ok-value' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('secret 解密失败（broken）'))
    for (const call of log.mock.calls) {
      expect(String(call[0])).not.toContain('broken-cipher')
      expect(String(call[0])).not.toContain('ok-value')
    }
  })

  it('校验：插件 id / 键名 / 值形状非法时抛错，错误文案不含值', () => {
    const secrets = makeSecrets()
    expect(() => secrets.setSecret('Bad_Id', 'secret', 'v')).toThrow(/secret_invalid_plugin/)
    expect(() => secrets.setSecret('webhook', '', 'v')).toThrow(/secret_invalid_key/)
    expect(() => secrets.setSecret('webhook', 'k'.repeat(65), 'v')).toThrow(/secret_invalid_key/)
    expect(() => secrets.setSecret('webhook', 'secret', '')).toThrow(/secret_invalid_value: secret/)
    expect(() => secrets.setSecret('webhook', 'secret', 'x'.repeat(2_001))).toThrow(
      /secret_value_too_long: secret/,
    )
    expect(() => secrets.listSecretKeys('Bad_Id')).toThrow(/secret_invalid_plugin/)
    expect(() => secrets.hasSecret('webhook', '')).toThrow(/secret_invalid_key/)
    expect(() => secrets.removeSecret('webhook', '')).toThrow(/secret_invalid_key/)
  })
})

// ---------- 配置合并 ----------

const manifest: PluginManifest = {
  id: 'webhook',
  kind: 'source',
  name: 'Webhook',
  version: '1.0.0',
  capabilities: ['net'],
  config: [
    { key: 'port', label: '端口', type: 'number', default: 47_615 },
    { key: 'path', label: '路径', type: 'text', default: '/webhook' },
    { key: 'enabled', label: '启用', type: 'boolean', default: true },
    { key: 'mode', label: '模式', type: 'select', options: ['a', 'b'], default: 'a' },
    { key: 'secret', label: '密钥', type: 'secret' },
  ],
}

const settingOf = (overrides: Partial<PluginSetting> = {}): PluginSetting => ({
  id: 'webhook',
  kind: 'source',
  enabled: true,
  granted: ['net'],
  config: {},
  ...overrides,
})

describe('resolvePluginConfig', () => {
  it('无设置时只给 manifest 默认值；secret 不凭空出现', () => {
    expect(resolvePluginConfig(manifest, null, {}, false)).toEqual({
      port: 47_615,
      path: '/webhook',
      enabled: true,
      mode: 'a',
    })
  })

  it('设置覆盖默认值；类型不符的项忽略（回退默认值）', () => {
    const setting = settingOf({
      config: { port: 12_345, path: '/hook', enabled: 'yes', mode: 'b' } as unknown as Record<
        string,
        string | number | boolean
      >,
    })
    expect(resolvePluginConfig(manifest, setting, {}, false)).toEqual({
      port: 12_345,
      path: '/hook',
      enabled: true,
      mode: 'b',
    })
  })

  it('未声明字段（manifest 升级后的残留）被忽略', () => {
    const setting = settingOf({ config: { removed: 'old', port: 1 } })
    expect(resolvePluginConfig(manifest, setting, {}, false)).toEqual({
      port: 1,
      path: '/webhook',
      enabled: true,
      mode: 'a',
    })
  })

  it('外部插件授权后合并 secret；设置里的 secret 字段值不进 config', () => {
    const setting = settingOf({ config: { secret: 'from-setting' } })
    expect(resolvePluginConfig(manifest, setting, { secret: 'from-cipher' }, false)).toEqual({
      port: 47_615,
      path: '/webhook',
      enabled: true,
      mode: 'a',
      secret: 'from-cipher',
    })
  })

  it('外部插件未授权（未启用 / 能力未全部授权）不合并 secret', () => {
    const secrets = { secret: 'from-cipher' }
    expect(
      resolvePluginConfig(manifest, settingOf({ enabled: false }), secrets, false),
    ).not.toHaveProperty('secret')
    expect(
      resolvePluginConfig(manifest, settingOf({ granted: [] }), secrets, false),
    ).not.toHaveProperty('secret')
    expect(resolvePluginConfig(manifest, null, secrets, false)).not.toHaveProperty('secret')
  })

  it('内置插件恒可信：没有设置也合并 secret（值只在 welcome 下发）', () => {
    expect(resolvePluginConfig(manifest, null, { secret: 'from-cipher' }, true)).toMatchObject({
      secret: 'from-cipher',
    })
  })

  it('secret 为空串 / 未写入时不进 config', () => {
    expect(resolvePluginConfig(manifest, settingOf(), { secret: '' }, false)).not.toHaveProperty(
      'secret',
    )
    expect(resolvePluginConfig(manifest, settingOf(), {}, false)).not.toHaveProperty('secret')
  })

  it('manifest 没有 config 字段时返回空对象', () => {
    const bare: PluginManifest = {
      id: 'bare',
      kind: 'source',
      name: 'Bare',
      version: '1.0.0',
      capabilities: [],
    }
    expect(resolvePluginConfig(bare, settingOf({ id: 'bare' }), {}, false)).toEqual({})
  })

  it('字段没有 default 且设置未提供：不写入（默认值判定的 false 侧）', () => {
    const local: PluginManifest = {
      id: 'webhook',
      kind: 'source',
      name: 'Webhook',
      version: '1.0.0',
      capabilities: ['net'],
      config: [{ key: 'note', label: '备注', type: 'text' }],
    }
    expect(resolvePluginConfig(local, settingOf(), {}, false)).toEqual({})
  })
})

describe('createPluginSecrets 缺省项', () => {
  it('now / log 缺省：写库用系统时间，解密失败落 console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const secrets = createPluginSecrets({ db, cipher: fakeCipher() })
    secrets.setSecret('webhook', 'secret', 'v')
    expect(Number.isNaN(Date.parse(rowsOf()[0].updatedAt))).toBe(false)

    db.prepare(
      'INSERT INTO plugin_secrets (plugin_id, key, value_cipher, updated_at) VALUES (?, ?, ?, ?)',
    ).run('webhook', 'broken', 'broken-cipher', '2026-11-05T00:00:00.000Z')

    expect(secrets.readSecrets('webhook')).toEqual({ secret: 'v' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('secret 解密失败（broken）'))
  })

  it('解密抛非 Error：日志记录字符串值（不泄漏密文）', () => {
    const log = vi.fn()
    const secrets = makeSecrets({
      cipher: fakeCipher({
        decrypt: () => {
          throw '字符串错误'
        },
      }),
      log,
    })
    db.prepare(
      'INSERT INTO plugin_secrets (plugin_id, key, value_cipher, updated_at) VALUES (?, ?, ?, ?)',
    ).run('webhook', 'secret', 'cipher-value', '2026-11-05T00:00:00.000Z')

    expect(secrets.readSecrets('webhook')).toEqual({})
    expect(log).toHaveBeenCalledWith(expect.stringContaining('字符串错误'))
    expect(String(log.mock.calls[0]?.[0])).not.toContain('cipher-value')
  })
})
