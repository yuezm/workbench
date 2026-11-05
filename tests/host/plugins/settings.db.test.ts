// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/host/db'
import { createPluginSecrets, type SecretCipher } from '../../../src/host/plugins/settings'

/**
 * `plugin_secrets` × 真实 schema（M7 D5）：用 `openDatabase` 建库（不是测试自建 DDL），
 * 验证列名与契约一致、加密往返可读回、重复写入覆盖、删除生效——防止 schema 与
 * `createPluginSecrets` 的列名/主键悄悄漂移。
 */

const cipher: SecretCipher = {
  available: () => true,
  encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (value) => Buffer.from(value.slice(4), 'base64').toString('utf8'),
}

interface SecretRawRow {
  plugin_id: string
  key: string
  value_cipher: string
  updated_at: string
}

let db: DatabaseSync

beforeEach(() => {
  db = openDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

describe('plugin_secrets × openDatabase', () => {
  it('schema 列与契约一致（plugin_id / key / value_cipher / updated_at）', () => {
    const columns = db.prepare('PRAGMA table_info(plugin_secrets)').all() as unknown as Array<{
      name: string
    }>
    expect(columns.map((column) => column.name)).toEqual([
      'plugin_id',
      'key',
      'value_cipher',
      'updated_at',
    ])
  })

  it('写入 → 读回明文；库里只有密文', () => {
    const secrets = createPluginSecrets({
      db,
      cipher,
      now: () => '2026-11-05T00:00:00.000Z',
    })

    secrets.setSecret('webhook', 'secret', 'top-secret')
    expect(secrets.listSecretKeys('webhook')).toEqual(['secret'])
    expect(secrets.hasSecret('webhook', 'secret')).toBe(true)
    expect(secrets.readSecrets('webhook')).toEqual({ secret: 'top-secret' })

    const rows = db
      .prepare('SELECT plugin_id, key, value_cipher, updated_at FROM plugin_secrets')
      .all() as unknown as SecretRawRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0].plugin_id).toBe('webhook')
    expect(rows[0].key).toBe('secret')
    expect(rows[0].value_cipher).not.toContain('top-secret')
    expect(rows[0].updated_at).toBe('2026-11-05T00:00:00.000Z')
  })

  it('同一 (plugin_id, key) 覆盖写入（主键与 upsert 语法对得上真实 schema）', () => {
    const secrets = createPluginSecrets({ db, cipher })
    secrets.setSecret('webhook', 'secret', 'first')
    secrets.setSecret('webhook', 'secret', 'second')

    const count = db
      .prepare('SELECT COUNT(*) AS total FROM plugin_secrets WHERE plugin_id = ?')
      .get('webhook') as unknown as { total: number }
    expect(count.total).toBe(1)
    expect(secrets.readSecrets('webhook')).toEqual({ secret: 'second' })
  })

  it('删除后读回为空；不同插件互不可见', () => {
    const secrets = createPluginSecrets({ db, cipher })
    secrets.setSecret('webhook', 'secret', 'a')
    secrets.setSecret('other', 'secret', 'b')

    secrets.removeSecret('webhook', 'secret')
    expect(secrets.readSecrets('webhook')).toEqual({})
    expect(secrets.readSecrets('other')).toEqual({ secret: 'b' })
  })
})
