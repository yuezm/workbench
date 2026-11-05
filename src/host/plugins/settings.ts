/**
 * 插件设置与 secret 存储（M7 D3/D5）。
 *
 * 两条读路径分开：
 * - **非密钥设置**（enabled / granted / config）走事实日志 → 投影 `plugin_settings`，由
 *   `kernel/plugins` 校验、宿主命令路由读视图合并；本文件不写设置，只负责把它们与
 *   manifest 默认值、授权后的 secret 合并成 `sdk.config()` 的值（`resolvePluginConfig`）。
 * - **secret 值**只写宿主私有表 `plugin_secrets`（非投影表，重建不清空）：
 *   加密由装配根注入的 `SecretCipher`（Electron `safeStorage`）完成；本文件只在
 *   `welcome` 组装时解密读取，键名可以进视图，**值不进事实、不进视图、不进日志**。
 *
 * 失败口径：
 * - `SecretCipher` 不可用时写入直接抛 `secret_cipher_unavailable`（命令路由转 `unsupported`）；
 * - 解密失败只跳过该键并记一条不含密文/明文的日志（旧密文/换机后密钥失效属可恢复情况）；
 * - 校验失败抛错，错误文案只含键名，不回显值。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Capability, ConfigField, PluginManifest } from '../../protocol/manifest'
import { isPluginId } from '../../protocol/plugin-host'
import { PLUGIN_SETTING_LIMITS, type PluginSetting } from '../../protocol/plugins'

/**
 * 加密原件（装配根用 Electron `safeStorage` 实现；测试注入假实现）。
 *
 * 只允许主进程持有：`available=false` 时宿主不得把 secret 当成「已保存」，
 * 写入口据此拒绝（`unsupported`），避免明文落库。
 */
export interface SecretCipher {
  available(): boolean
  /** 明文 → 可落库的密文（base64 文本） */
  encrypt(plain: string): string
  /** 密文 → 明文；失败抛错（调用方按「该键不可用」降级） */
  decrypt(cipher: string): string
}

export interface PluginSecretsOptions {
  db: DatabaseSync
  cipher: SecretCipher
  /** 写入时间（ISO）；缺省系统时钟 */
  now?: () => string
  /** 诊断日志（只记插件 id 与键名，不记值） */
  log?: (line: string) => void
}

export interface PluginSecrets {
  /** 已写入的 secret 键名（升序；不含值） */
  listSecretKeys(pluginId: string): string[]
  hasSecret(pluginId: string, key: string): boolean
  /** 解密后的全部 secret（只给 `welcome` 组装用；调用方不得回显/落日志） */
  readSecrets(pluginId: string): Record<string, string>
  /** 写入或覆盖；`cipher` 不可用时抛 `secret_cipher_unavailable` */
  setSecret(pluginId: string, key: string, plain: string): void
  /** 删除（不存在时静默成功） */
  removeSecret(pluginId: string, key: string): void
}

const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const assertPluginId = (pluginId: string): void => {
  if (!isPluginId(pluginId)) throw new Error(`secret_invalid_plugin: ${String(pluginId)}`)
}

const assertSecretKey = (key: string): void => {
  if (typeof key !== 'string' || key.length === 0 || key.length > PLUGIN_SETTING_LIMITS.configKey) {
    throw new Error(`secret_invalid_key: ${String(key)}`)
  }
}

/** 一行密文记录（只在本文件内流转，不外泄）。 */
interface SecretRow {
  key: string
  value_cipher: string
}

export function createPluginSecrets(options: PluginSecretsOptions): PluginSecrets {
  const { db, cipher } = options
  const now = options.now ?? (() => new Date().toISOString())
  const log = options.log ?? ((line: string): void => console.warn(line))

  return {
    listSecretKeys(pluginId) {
      assertPluginId(pluginId)
      const rows = db
        .prepare('SELECT key FROM plugin_secrets WHERE plugin_id = ? ORDER BY key')
        .all(pluginId) as unknown as Array<{ key: string }>
      return rows.map((row) => row.key)
    },

    hasSecret(pluginId, key) {
      assertPluginId(pluginId)
      assertSecretKey(key)
      const row = db
        .prepare('SELECT 1 AS hit FROM plugin_secrets WHERE plugin_id = ? AND key = ?')
        .get(pluginId, key) as unknown as { hit: number } | undefined
      return row !== undefined
    },

    readSecrets(pluginId) {
      assertPluginId(pluginId)
      const rows = db
        .prepare('SELECT key, value_cipher FROM plugin_secrets WHERE plugin_id = ? ORDER BY key')
        .all(pluginId) as unknown as SecretRow[]
      const secrets: Record<string, string> = {}
      for (const row of rows) {
        try {
          secrets[row.key] = cipher.decrypt(row.value_cipher)
        } catch (error) {
          // 旧密文 / 换机后密钥失效：跳过该键，其它键照常可用
          log(`[plugin:${pluginId}] secret 解密失败（${row.key}）：${errMsg(error)}`)
        }
      }
      return secrets
    },

    setSecret(pluginId, key, plain) {
      assertPluginId(pluginId)
      assertSecretKey(key)
      if (typeof plain !== 'string' || plain.length === 0) {
        throw new Error(`secret_invalid_value: ${key}`)
      }
      if (plain.length > PLUGIN_SETTING_LIMITS.configValue) {
        throw new Error(`secret_value_too_long: ${key}`)
      }
      if (!cipher.available()) {
        throw new Error('secret_cipher_unavailable: 宿主未提供安全存储，拒绝明文落库')
      }
      let valueCipher: string
      try {
        valueCipher = cipher.encrypt(plain)
      } catch (error) {
        // 加密失败：错误文案不含明文；保留 cause 供诊断，调用方按 unsupported 处理
        log(`[plugin:${pluginId}] secret 加密失败（${key}）：${errMsg(error)}`)
        throw new Error(`secret_encrypt_failed: ${key}`, { cause: error })
      }
      db.prepare(
        `INSERT INTO plugin_secrets (plugin_id, key, value_cipher, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value_cipher = excluded.value_cipher, updated_at = excluded.updated_at`,
      ).run(pluginId, key, valueCipher, now())
    },

    removeSecret(pluginId, key) {
      assertPluginId(pluginId)
      assertSecretKey(key)
      db.prepare('DELETE FROM plugin_secrets WHERE plugin_id = ? AND key = ?').run(pluginId, key)
    },
  }
}

/** 设置里的 config 只收标量（形状校验在内核；这里按 manifest 字段类型再收一道）。 */
const matchesFieldType = (field: ConfigField, value: string | number | boolean): boolean => {
  switch (field.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    default:
      return typeof value === 'string'
  }
}

/** 外部插件是否满足启动授权：启用且声明能力全部授权（内置插件恒可信）。 */
const isAuthorized = (
  manifest: PluginManifest,
  setting: PluginSetting | null,
  builtin: boolean,
): boolean => {
  if (builtin) return true
  if (setting === null || !setting.enabled) return false
  const granted = new Set<Capability>(setting.granted)
  return manifest.capabilities.every((capability) => granted.has(capability))
}

/**
 * 合并插件运行时配置（`sdk.config()` 的值）。
 *
 * 顺序：manifest 字段默认值 → 设置里的非 secret 值（只认 manifest 声明的字段与类型）→
 * **授权后**的 secret（内置插件恒可信；外部插件须启用且声明能力全部授权）。
 * 未声明字段（manifest 升级后设置里的残留）一律忽略，避免把旧配置带进新版本。
 */
export function resolvePluginConfig(
  manifest: PluginManifest,
  setting: PluginSetting | null,
  secrets: Record<string, string>,
  builtin: boolean,
): Record<string, string | number | boolean> {
  const config: Record<string, string | number | boolean> = {}
  const fields = manifest.config ?? []
  for (const field of fields) {
    if (field.type === 'secret') continue
    if (field.default !== undefined) config[field.key] = field.default
    const value = setting?.config?.[field.key]
    if (value !== undefined && matchesFieldType(field, value)) config[field.key] = value
  }
  if (!isAuthorized(manifest, setting, builtin)) return config
  for (const field of fields) {
    if (field.type !== 'secret') continue
    const value = secrets[field.key]
    if (typeof value === 'string' && value.length > 0) config[field.key] = value
  }
  return config
}
