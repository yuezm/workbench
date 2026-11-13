// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { validateCommand } from '../../src/protocol/validate'

const command = (type: string, payload: Record<string, unknown>): Record<string, unknown> => ({
  type,
  commandId: 'c-1',
  ...payload,
})

const settings = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'webhook',
  kind: 'source',
  enabled: true,
  granted: ['net'],
  config: { port: 1 },
  ...over,
})

const invalid = (value: unknown): string => {
  const result = validateCommand(value)
  if (result.ok) throw new Error('应被拒绝')
  return result.message
}

describe('validateCommand: plugins.replace（M7）', () => {
  it('合法整批通过（config 可选 / 标量值）', () => {
    const result = validateCommand(
      command('plugins.replace', {
        settings: [
          settings(),
          settings({ id: 'webhook-channel', kind: 'channel', granted: [], config: {} }),
        ],
      }),
    )
    expect(result.ok).toBe(true)
  })

  it('settings 非数组 / 超条数拒绝', () => {
    expect(invalid(command('plugins.replace', { settings: 'x' }))).toContain('settings 必须是数组')
    const tooMany = Array.from({ length: 65 }, (_, index) => settings({ id: `p-${index}` }))
    expect(invalid(command('plugins.replace', { settings: tooMany }))).toContain('最多 64 项')
  })

  it('单条非法：非对象 / id / enabled / kind / granted', () => {
    expect(invalid(command('plugins.replace', { settings: [1] }))).toContain('必须是对象')
    expect(invalid(command('plugins.replace', { settings: [settings({ id: 'Bad' })] }))).toContain(
      'id 必须是小写 slug',
    )
    expect(
      invalid(command('plugins.replace', { settings: [settings({ enabled: 'yes' })] })),
    ).toContain('enabled 必须是布尔值')
    expect(
      invalid(command('plugins.replace', { settings: [settings({ kind: 'weird' })] })),
    ).toContain('kind')
    expect(
      invalid(command('plugins.replace', { settings: [settings({ granted: 'net' })] })),
    ).toContain('granted 必须是数组')
    expect(
      invalid(
        command('plugins.replace', {
          settings: [settings({ granted: ['net', 'spawn', 'notify', 'fs.read', 'fs.write', 'x'] })],
        }),
      ),
    ).toContain('最多 5 项')
    expect(
      invalid(command('plugins.replace', { settings: [settings({ granted: ['bogus'] })] })),
    ).toContain('不是已声明的能力')
    expect(
      invalid(command('plugins.replace', { settings: [settings({ granted: ['net', 'net'] })] })),
    ).toContain('重复')
  })

  it('config 形状：非对象 / 超条数 / 键名 / 值类型', () => {
    // 布尔与字符串标量都接受（覆盖 boolean continue 分支）
    const okBoolean = validateCommand(
      command('plugins.replace', {
        settings: [settings({ config: { enabled: true, name: 'x' } })],
      }),
    )
    expect(okBoolean.ok).toBe(true)
    expect(
      invalid(command('plugins.replace', { settings: [settings({ config: 'x' })] })),
    ).toContain('config 必须是对象')
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, 1]))
    expect(
      invalid(command('plugins.replace', { settings: [settings({ config: tooMany })] })),
    ).toContain('最多 32 项')
    expect(
      invalid(command('plugins.replace', { settings: [settings({ config: { 'Bad Key': 1 } })] })),
    ).toContain('键名非法')
    expect(
      invalid(command('plugins.replace', { settings: [settings({ config: { k: Number.NaN } })] })),
    ).toContain('必须是有限数字')
    expect(
      invalid(
        command('plugins.replace', { settings: [settings({ config: { k: 'x'.repeat(2_001) } })] }),
      ),
    ).toContain('必须是字符串 / 数字 / 布尔')
    expect(
      invalid(
        command('plugins.replace', {
          settings: [settings({ config: { k: { nested: true } } })],
        }),
      ),
    ).toContain('必须是字符串 / 数字 / 布尔')
  })
})

describe('validateCommand: plugin.set（M7）', () => {
  it('合法：enabled / granted / config / secrets（null 表示删除）', () => {
    const result = validateCommand(
      command('plugin.set', {
        pluginId: 'webhook',
        enabled: false,
        granted: ['net'],
        config: { port: 1 },
        secrets: { secret: 'v', gone: null },
      }),
    )
    expect(result.ok).toBe(true)
  })

  it('pluginId 必填；可选字段形状错误逐项拒绝', () => {
    expect(invalid(command('plugin.set', {}))).toContain('pluginId')
    expect(invalid(command('plugin.set', { pluginId: 'webhook', enabled: 'yes' }))).toContain(
      'enabled必须是布尔值',
    )
    expect(invalid(command('plugin.set', { pluginId: 'webhook', granted: 'net' }))).toContain(
      'granted 必须是数组',
    )
    expect(invalid(command('plugin.set', { pluginId: 'webhook', config: 'x' }))).toContain(
      'config 必须是对象',
    )
  })

  it('secrets：非对象 / 键名非法 / 非字符串 / 超长拒绝', () => {
    expect(invalid(command('plugin.set', { pluginId: 'webhook', secrets: 'x' }))).toContain(
      'secrets 必须是对象',
    )
    expect(
      invalid(command('plugin.set', { pluginId: 'webhook', secrets: { 'Bad Key': 'v' } })),
    ).toContain('键名非法')
    expect(
      invalid(command('plugin.set', { pluginId: 'webhook', secrets: { secret: 1 } })),
    ).toContain('必须是字符串或 null')
    expect(
      invalid(
        command('plugin.set', { pluginId: 'webhook', secrets: { secret: 'x'.repeat(2_001) } }),
      ),
    ).toContain('最长')
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, 'v']))
    expect(invalid(command('plugin.set', { pluginId: 'webhook', secrets: tooMany }))).toContain(
      '最多 32 项',
    )
  })
})
