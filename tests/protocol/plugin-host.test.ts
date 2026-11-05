import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_PLUGIN_KINDS,
  PLUGIN_HOST_LIMITS,
  PLUGIN_HOST_PROTOCOL_VERSION,
  encodePluginFrame,
  frameErrorLine,
  isPluginId,
  parseExternalManifest,
  parsePluginFrame,
  secretFieldKeys,
} from '../../src/protocol/plugin-host'
import type { PluginManifest } from '../../src/protocol/manifest'

const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'my-plugin',
  kind: 'source',
  name: '我的插件',
  version: '1.0.0',
  capabilities: ['net'],
  ...over,
})

const okManifest = (value: unknown): PluginManifest => {
  const result = parseExternalManifest(value)
  if (!result.ok) throw new Error(`应通过: ${result.detail}`)
  return result.manifest
}

const rejectReason = (value: unknown): string => {
  const result = parseExternalManifest(value)
  if (result.ok) throw new Error('应被拒绝')
  return result.detail
}

describe('parseExternalManifest（M7 外部插件清单）', () => {
  it('M7 只开放 source / channel 两类', () => {
    expect(EXTERNAL_PLUGIN_KINDS).toEqual(['source', 'channel'])
  })

  it('最小合法清单：capabilities 必填、config 可缺省', () => {
    const parsed = okManifest({
      id: 'p1',
      kind: 'channel',
      name: 'n',
      version: '1',
      capabilities: [],
    })
    expect(parsed).toEqual({
      id: 'p1',
      kind: 'channel',
      name: 'n',
      version: '1',
      capabilities: [],
    })
  })

  it('完整清单：description / config 字段逐项保留', () => {
    const parsed = okManifest(
      manifest({
        description: '描述',
        config: [
          { key: 'url', label: '地址', type: 'text', default: 'http://x', help: '说明' },
          { key: 'mode', label: '模式', type: 'select', options: ['a', 'b'], required: true },
          { key: 'secret', label: '密钥', type: 'secret' },
          { key: 'count', label: '数量', type: 'number', default: 3, required: true },
          { key: 'on', label: '开关', type: 'boolean', default: true, required: true },
        ],
      }),
    )
    expect(parsed.description).toBe('描述')
    expect(parsed.config?.map((field) => field.key)).toEqual([
      'url',
      'mode',
      'secret',
      'count',
      'on',
    ])
    expect(parsed.config?.[1]).toMatchObject({
      type: 'select',
      options: ['a', 'b'],
      required: true,
    })
  })

  it('非对象 / 非 kebab-case id / 非法 kind 拒绝', () => {
    expect(rejectReason(null)).toContain('不是对象')
    expect(rejectReason([])).toContain('不是对象')
    expect(rejectReason(manifest({ id: 'Bad Id' }))).toContain('kebab-case')
    expect(rejectReason(manifest({ kind: 'nope' }))).toContain('kind 非法')
    // app 是合法 kind，但不属于 M7 开放的外部类别
    expect(rejectReason(manifest({ kind: 'app' }))).toContain('不开放外部 app')
  })

  it('executor 类外部插件明确拒绝（M7 不开放）', () => {
    expect(rejectReason(manifest({ kind: 'executor' }))).toContain('不开放外部 executor')
  })

  it('name / version / description 形状非法拒绝', () => {
    expect(rejectReason(manifest({ name: '' }))).toContain('name')
    expect(rejectReason(manifest({ version: '' }))).toContain('version')
    expect(rejectReason(manifest({ description: 42 }))).toContain('description')
  })

  it('capabilities 非数组 / 超上限 / 未知能力拒绝，重复项去重', () => {
    expect(rejectReason(manifest({ capabilities: 'net' }))).toContain('capabilities')
    expect(
      rejectReason(manifest({ capabilities: ['net', 'net', 'net', 'net', 'net', 'net'] })),
    ).toContain('capabilities')
    expect(rejectReason(manifest({ capabilities: ['bogus'] }))).toContain('未知能力')
    expect(okManifest(manifest({ capabilities: ['net', 'net'] })).capabilities).toEqual(['net'])
  })

  it('config 非数组 / 超上限拒绝', () => {
    expect(rejectReason(manifest({ config: 'x' }))).toContain('config 非法')
    const tooMany = Array.from({ length: PLUGIN_HOST_LIMITS.configEntries + 1 }, (_, index) => ({
      key: `k${index}`,
      label: 'l',
      type: 'text',
    }))
    expect(rejectReason(manifest({ config: tooMany }))).toContain('config 非法')
  })

  it('config 字段逐项拒绝：非对象 / key / label / type / help / required', () => {
    expect(rejectReason(manifest({ config: [1] }))).toContain('config[0] 不是对象')
    expect(rejectReason(manifest({ config: [{ label: 'l', type: 'text' }] }))).toContain('key 非法')
    expect(rejectReason(manifest({ config: [{ key: 'k', type: 'text' }] }))).toContain('label 非法')
    expect(rejectReason(manifest({ config: [{ key: 'k', label: 'l', type: 'weird' }] }))).toContain(
      'type 非法',
    )
    expect(
      rejectReason(manifest({ config: [{ key: 'k', label: 'l', type: 'text', help: 1 }] })),
    ).toContain('help 非法')
    expect(
      rejectReason(manifest({ config: [{ key: 'k', label: 'l', type: 'text', required: 'yes' }] })),
    ).toContain('required 非法')
  })

  it('select 字段：options 必填且合法；非 select 不接受 options', () => {
    expect(
      rejectReason(manifest({ config: [{ key: 'k', label: 'l', type: 'select' }] })),
    ).toContain('options 非法')
    expect(
      rejectReason(manifest({ config: [{ key: 'k', label: 'l', type: 'select', options: [] }] })),
    ).toContain('options 非法')
    expect(
      rejectReason(manifest({ config: [{ key: 'k', label: 'l', type: 'select', options: [''] }] })),
    ).toContain('options 非法')
    expect(
      rejectReason(manifest({ config: [{ key: 'k', label: 'l', type: 'text', options: ['a'] }] })),
    ).toContain('仅 select 可用')
  })

  it('default 类型必须与字段类型一致', () => {
    expect(
      rejectReason(manifest({ config: [{ key: 'k', label: 'l', type: 'text', default: 1 }] })),
    ).toContain('default 非法')
    expect(
      rejectReason(manifest({ config: [{ key: 'k', label: 'l', type: 'number', default: 'x' }] })),
    ).toContain('default 非法')
    expect(
      rejectReason(manifest({ config: [{ key: 'k', label: 'l', type: 'boolean', default: 1 }] })),
    ).toContain('default 非法')
    // number 字段不接受 options
    expect(
      rejectReason(
        manifest({ config: [{ key: 'k', label: 'l', type: 'number', options: ['a'] }] }),
      ),
    ).toContain('仅 select 可用')
  })

  it('config 键重复拒绝', () => {
    const config = [
      { key: 'k', label: 'l', type: 'text' },
      { key: 'k', label: 'l2', type: 'text' },
    ]
    expect(rejectReason(manifest({ config }))).toContain('config 键重复: k')
  })
})

describe('isPluginId', () => {
  it('只接受小写 slug', () => {
    expect(isPluginId('webhook')).toBe(true)
    expect(isPluginId('web-hook2')).toBe(true)
    expect(isPluginId('Webhook')).toBe(false)
    expect(isPluginId('')).toBe(false)
    expect(isPluginId(1)).toBe(false)
    expect(isPluginId('a'.repeat(65))).toBe(false)
  })
})

describe('parsePluginFrame（M7 stdio JSONL 帧）', () => {
  const frame = (value: Record<string, unknown>): string =>
    JSON.stringify({ v: PLUGIN_HOST_PROTOCOL_VERSION, ...value })

  it('非 JSON / 非对象 / 版本不符返回 null', () => {
    expect(parsePluginFrame('{')).toBeNull()
    expect(parsePluginFrame('1')).toBeNull()
    expect(parsePluginFrame('[]')).toBeNull()
    expect(parsePluginFrame(JSON.stringify({ v: 2, type: 'log', line: 'x' }))).toBeNull()
    expect(parsePluginFrame('')).toBeNull()
    expect(parsePluginFrame('x'.repeat(PLUGIN_HOST_LIMITS.frameBytes + 1))).toBeNull()
  })

  it('hello 帧：合法、能力去重；缺字段 / 非法 kind / 未知能力返回 null', () => {
    expect(
      parsePluginFrame(
        frame({
          type: 'hello',
          id: 'webhook',
          kind: 'source',
          version: '1.0.0',
          capabilities: ['net', 'net'],
        }),
      ),
    ).toEqual({
      v: PLUGIN_HOST_PROTOCOL_VERSION,
      type: 'hello',
      id: 'webhook',
      kind: 'source',
      version: '1.0.0',
      capabilities: ['net'],
    })
    expect(parsePluginFrame(frame({ type: 'hello', kind: 'source', version: '1' }))).toBeNull()
    expect(
      parsePluginFrame(frame({ type: 'hello', id: 'x', kind: 'nope', version: '1' })),
    ).toBeNull()
    expect(
      parsePluginFrame(
        frame({ type: 'hello', id: 'x', kind: 'source', version: '1', capabilities: ['bogus'] }),
      ),
    ).toBeNull()
    expect(
      parsePluginFrame(
        frame({ type: 'hello', id: 'x', kind: 'source', version: '', capabilities: [] }),
      ),
    ).toBeNull()
    expect(
      parsePluginFrame(
        frame({ type: 'hello', id: 'x', kind: 'source', version: '1', capabilities: 'net' }),
      ),
    ).toBeNull()
  })

  it('log 帧：合法与超长拒绝', () => {
    expect(parsePluginFrame(frame({ type: 'log', line: 'hi' }))).toMatchObject({ type: 'log' })
    expect(parsePluginFrame(frame({ type: 'log', line: 1 }))).toBeNull()
    expect(
      parsePluginFrame(frame({ type: 'log', line: 'x'.repeat(PLUGIN_HOST_LIMITS.logLine + 1) })),
    ).toBeNull()
  })

  it('event 帧：形状合法与各类非法字段', () => {
    const event = { source: 'webhook', type: 'issues.opened', subject: 's' }
    expect(parsePluginFrame(frame({ type: 'event', event }))).toMatchObject({
      type: 'event',
      event,
    })
    expect(parsePluginFrame(frame({ type: 'event' }))).toBeNull()
    expect(parsePluginFrame(frame({ type: 'event', event: 'x' }))).toBeNull()
    expect(parsePluginFrame(frame({ type: 'event', event: { ...event, source: '' } }))).toBeNull()
    expect(parsePluginFrame(frame({ type: 'event', event: { ...event, type: 1 } }))).toBeNull()
    expect(parsePluginFrame(frame({ type: 'event', event: { ...event, subject: '' } }))).toBeNull()
    expect(
      parsePluginFrame(frame({ type: 'event', event: { ...event, summary: 'x'.repeat(201) } })),
    ).toBeNull()
    expect(parsePluginFrame(frame({ type: 'event', event: { ...event, detail: 1 } }))).toBeNull()
    expect(parsePluginFrame(frame({ type: 'event', event: { ...event, link: 1 } }))).toBeNull()
    expect(parsePluginFrame(frame({ type: 'event', event: { ...event, dedupeKey: 1 } }))).toBeNull()
    expect(
      parsePluginFrame(
        frame({ type: 'event', event: { ...event, summary: 'ok', detail: 'x', link: 'u' } }),
      ),
    ).toMatchObject({ type: 'event' })
  })

  it('delivered / answer 帧：合法与非法', () => {
    expect(
      parsePluginFrame(
        frame({ type: 'delivered', cardId: 'c1', version: 2, ref: 'webhook-channel' }),
      ),
    ).toMatchObject({ type: 'delivered', version: 2 })
    expect(
      parsePluginFrame(frame({ type: 'delivered', cardId: '', version: 2, ref: 'x' })),
    ).toBeNull()
    expect(
      parsePluginFrame(frame({ type: 'delivered', cardId: 'c', version: 1.5, ref: 'x' })),
    ).toBeNull()
    expect(
      parsePluginFrame(frame({ type: 'delivered', cardId: 'c', version: 1, ref: '' })),
    ).toBeNull()
    expect(parsePluginFrame(frame({ type: 'answer', cardId: 'c', optionIndex: 0 }))).toMatchObject({
      type: 'answer',
      optionIndex: 0,
    })
    expect(parsePluginFrame(frame({ type: 'answer', cardId: 'c', optionIndex: 1.5 }))).toBeNull()
    expect(parsePluginFrame(frame({ type: 'answer', optionIndex: 0 }))).toBeNull()
  })

  it('未知帧类型返回 null', () => {
    expect(parsePluginFrame(frame({ type: 'shutdown' }))).toBeNull()
  })
})

describe('encodePluginFrame / secretFieldKeys / frameErrorLine', () => {
  it('宿主 → 插件帧编码为单行 JSONL', () => {
    const line = encodePluginFrame({
      v: PLUGIN_HOST_PROTOCOL_VERSION,
      type: 'welcome',
      pluginId: 'webhook',
      granted: ['net'],
      config: { port: 1 },
    })
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toMatchObject({ type: 'welcome', config: { port: 1 } })
  })

  it('secret 字段名从 manifest 中挑出', () => {
    const parsed = okManifest(
      manifest({
        config: [
          { key: 'secret', label: '密钥', type: 'secret' },
          { key: 'url', label: '地址', type: 'text' },
        ],
      }),
    )
    expect(secretFieldKeys(parsed)).toEqual(['secret'])
    expect(secretFieldKeys({ ...parsed, config: undefined })).toEqual([])
  })

  it('帧错误文案不含帧内容', () => {
    expect(frameErrorLine(new Error('boom'))).toBe('插件帧处理失败：boom')
    expect(frameErrorLine('x')).toBe('插件帧处理失败：x')
  })
})
