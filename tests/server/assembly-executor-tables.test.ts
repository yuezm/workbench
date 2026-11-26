// @vitest-environment node
/**
 * 执行器表单默认值（`packages/bundle/base/src/executor-tables.ts`）。
 *
 * 「未指定 key 取首项 / 未知 key 抛可读错误 / 字段没默认值 / 默认值不是字符串」这些
 * 组合在真装配里要靠不同运行时配置才能碰到，这里直接构造注册表逐条断言。
 */
import { describe, expect, it } from 'vitest'
import type { ExecutorPlugin } from '@workbench/capabilities/types'
import type { ExecutorRegistryEntry } from '@workbench/plugins-registry'
import type { PluginManifest } from '@workbench/protocol/manifest'
import {
  executorChoicesOf,
  executorDefaultsOf,
  executorEntryOf,
  manifestDefaultOf,
} from '@workbench/bundle-base/executor-tables'

const plugin = {} as ExecutorPlugin

const entryOf = (key: string, config?: PluginManifest['config']): ExecutorRegistryEntry => ({
  key,
  label: `${key} 展示名`,
  plugin,
  manifest: {
    id: key,
    kind: 'executor',
    name: `${key} 展示名`,
    version: '1.0.0',
    capabilities: [],
    ...(config === undefined ? {} : { config }),
  },
})

const executors = [
  entryOf('dsh', [
    { key: 'command', label: '命令', type: 'text', default: 'dsh' },
    { key: 'profile', label: 'Profile', type: 'text' },
  ]),
  entryOf('command'),
]

describe('manifestDefaultOf', () => {
  it('有字符串默认值就取它；字段缺失或默认值不是字符串时回空串', () => {
    expect(manifestDefaultOf(executors[0] as ExecutorRegistryEntry, 'command')).toBe('dsh')
    // profile 字段没有 default（只声明类型）
    expect(manifestDefaultOf(executors[0] as ExecutorRegistryEntry, 'profile')).toBe('')
    // 字段不存在
    expect(manifestDefaultOf(executors[0] as ExecutorRegistryEntry, 'nope')).toBe('')
    // manifest 完全没有 config
    expect(manifestDefaultOf(executors[1] as ExecutorRegistryEntry, 'command')).toBe('')
  })

  it('数字/布尔默认值不算字符串默认值（表单里留空，不硬塞 0 / false）', () => {
    const numeric = entryOf('numeric', [
      { key: 'timeout', label: '超时', type: 'number', default: 30 },
      { key: 'stream', label: '流式', type: 'boolean', default: true },
    ])
    expect(manifestDefaultOf(numeric, 'timeout')).toBe('')
    expect(manifestDefaultOf(numeric, 'stream')).toBe('')
  })
})

describe('executorEntryOf', () => {
  it('未指定 key 取注册表首项', () => {
    expect(executorEntryOf(executors, undefined).key).toBe('dsh')
  })

  it('按 key 命中；未知 key 抛可读错误（带上 key 供路由层展示）', () => {
    expect(executorEntryOf(executors, 'command').key).toBe('command')
    expect(() => executorEntryOf(executors, 'nope')).toThrow('执行器插件未注册: nope')
  })
})

describe('executorDefaultsOf', () => {
  it('给定 key：回执行器键 + manifest 默认命令/profile', () => {
    expect(executorDefaultsOf(executors, 'dsh')).toEqual({
      executorKey: 'dsh',
      command: 'dsh',
      profile: '',
    })
  })

  it('未指定 key：与首项一致', () => {
    expect(executorDefaultsOf(executors, undefined)).toEqual({
      executorKey: 'dsh',
      command: 'dsh',
      profile: '',
    })
  })

  it('未知 key：照常抛错（不静默退回首项）', () => {
    expect(() => executorDefaultsOf(executors, 'nope')).toThrow('执行器插件未注册: nope')
  })
})

describe('executorChoicesOf', () => {
  it('顺序即注册表顺序，每项带展示名与两个默认值', () => {
    expect(executorChoicesOf(executors)).toEqual([
      { key: 'dsh', label: 'dsh 展示名', command: 'dsh', profile: '' },
      { key: 'command', label: 'command 展示名', command: '', profile: '' },
    ])
  })

  it('空注册表给空数组（不抛错）', () => {
    expect(executorChoicesOf([])).toEqual([])
  })
})
