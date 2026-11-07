// @vitest-environment node
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CAPABILITIES, PLUGIN_KINDS } from '../../src/protocol/manifest'
import {
  CAPABILITIES as PLUGINS_CAPABILITIES,
  PLUGIN_KINDS as PLUGINS_KINDS,
} from '../../src/plugins/manifest'
import {
  channelById,
  channels,
  detectAll,
  detectAllWith,
  executorById,
  sourceById,
  sources,
  executors,
  type ExecutorRegistryEntry,
} from '../../src/plugins/registry'
import { CLI_CANDIDATES } from '../../src/plugins/shared/cli-catalog'
import type { PluginManifest } from '../../src/protocol/manifest'
import type { DetectedRuntime } from '../../src/protocol/entities'
import type { ExecutorPlugin, SdkHost } from '../../src/sdk/types'

/**
 * 执行器插件注册表契约（SPEC-plugins「Manifest / 测试 / 内置插件清单」）。
 *
 * 新增协议 = `src/plugins/executors/<id>/` + registry 一行；本文件守住两件事：
 * ① 清单本身合法（id/kind/version/capabilities/run）；
 * ② 目录与清单双向一致——漏注册（目录在、清单没有）和幽灵注册（清单有、目录没了）都失败。
 */

const EXECUTORS_ROOT = resolve(import.meta.dirname, '../../src/plugins/executors')
const CHANNELS_ROOT = resolve(import.meta.dirname, '../../src/plugins/channels')

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/

describe('执行器插件注册表', () => {
  it('注册表非空', () => {
    expect(executors.length).toBeGreaterThan(0)
  })

  it('plugins/manifest 只是协议层契约的再导出（同一份取值）', () => {
    expect(PLUGINS_CAPABILITIES).toBe(CAPABILITIES)
    expect(PLUGINS_KINDS).toBe(PLUGIN_KINDS)
  })

  it('每条注册项的 key 唯一、等于 manifest.id 且为 kebab-case', () => {
    const keys = executors.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of executors) {
      expect(entry.key).toMatch(KEBAB_CASE)
      expect(entry.key).toBe(entry.manifest.id)
      expect(entry.manifest.kind).toBe('executor')
    }
  })

  it('manifest 必填字段齐全、capabilities 在枚举内且不重复', () => {
    for (const entry of executors) {
      const { key, label, manifest, plugin } = entry
      expect(label, `${key} 的展示名为空`).toBeTruthy()
      expect(manifest.name, `${key} 的 manifest.name 为空`).toBeTruthy()
      expect(manifest.version, `${key} 的 manifest.version 为空`).toBeTruthy()
      expect(Array.isArray(manifest.capabilities)).toBe(true)
      expect(new Set(manifest.capabilities).size).toBe(manifest.capabilities.length)
      for (const capability of manifest.capabilities) {
        expect(CAPABILITIES, `${key} 声明了枚举外的能力「${capability}」`).toContain(capability)
      }
      expect(plugin.run, `${key} 缺少 run`).toBeTypeOf('function')
      for (const optional of ['probe', 'models', 'detect'] as const) {
        if (plugin[optional] !== undefined) {
          expect(plugin[optional], `${key} 的 ${optional} 不是函数`).toBeTypeOf('function')
        }
      }
    }
  })

  it('executorById 命中同一条注册项，未知 key 抛可读错误', () => {
    for (const entry of executors) {
      expect(executorById(entry.key)).toBe(entry)
    }
    expect(() => executorById('nope')).toThrow(/执行器插件未注册: nope/)
    expect(() => executorById('')).toThrow(/执行器插件未注册/)
  })

  it('src/plugins/executors/* 目录与注册表清单双向一致', () => {
    if (!existsSync(EXECUTORS_ROOT)) return

    const dirIds = readdirSync(EXECUTORS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const registeredIds = executors.map((entry) => entry.key).sort()

    expect(
      registeredIds,
      `执行器目录与注册表不一致：多出/缺少注册项（目录 [${dirIds.join(', ')}]，清单 [${registeredIds.join(', ')}]）`,
    ).toEqual(dirIds)

    for (const id of dirIds) {
      for (const file of ['manifest.ts', 'index.ts']) {
        expect(existsSync(join(EXECUTORS_ROOT, id, file)), `${id} 缺少 ${file}`).toBe(true)
      }
    }
  })
})

describe('通道插件注册表（M4）', () => {
  it('每条注册项的 key 唯一、等于 manifest.id、kebab-case 且 kind=channel', () => {
    const keys = channels.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of channels) {
      expect(entry.key).toMatch(KEBAB_CASE)
      expect(entry.key).toBe(entry.manifest.id)
      expect(entry.manifest.kind).toBe('channel')
      expect(entry.label, `${entry.key} 的展示名为空`).toBeTruthy()
      expect(entry.manifest.version, `${entry.key} 的 manifest.version 为空`).toBeTruthy()
      expect(new Set(entry.manifest.capabilities).size).toBe(entry.manifest.capabilities.length)
      for (const capability of entry.manifest.capabilities) {
        expect(CAPABILITIES, `${entry.key} 声明了枚举外的能力「${capability}」`).toContain(
          capability,
        )
      }
      expect(entry.plugin.start, `${entry.key} 缺少 start`).toBeTypeOf('function')
    }
  })

  it('channelById 命中同一条注册项，未知 key 抛可读错误', () => {
    for (const entry of channels) expect(channelById(entry.key)).toBe(entry)
    expect(() => channelById('nope')).toThrow(/通道插件未注册: nope/)
    expect(() => channelById('')).toThrow(/通道插件未注册/)
  })

  it('内置通道顺序固定：in-app 在前、desktop 其次、webhook-channel 最后（数组顺序即投递顺序）', () => {
    expect(channels.map((entry) => entry.key)).toEqual(['in-app', 'desktop', 'webhook-channel'])
    // in-app 不需要副作用能力（投影即送达）；desktop 只声明 notify；webhook 通道声明 net
    expect(channelById('in-app').manifest.capabilities).toEqual([])
    expect(channelById('desktop').manifest.capabilities).toEqual(['notify'])
    expect(channelById('webhook-channel').manifest.capabilities).toEqual(['net'])
  })

  it('src/plugins/channels/* 目录与注册表清单双向一致', () => {
    // 防御空转：通道目录不存在时清单必须为空
    if (!existsSync(CHANNELS_ROOT)) {
      expect(channels).toEqual([])
      return
    }

    const dirIds = readdirSync(CHANNELS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const registeredIds = channels.map((entry) => entry.key).sort()

    expect(
      registeredIds,
      `通道目录与注册表不一致：多出/缺少注册项（目录 [${dirIds.join(', ')}]，清单 [${registeredIds.join(', ')}]）`,
    ).toEqual(dirIds)

    for (const id of dirIds) {
      for (const file of ['manifest.ts', 'index.ts']) {
        expect(existsSync(join(CHANNELS_ROOT, id, file)), `${id} 缺少 ${file}`).toBe(true)
      }
    }
  })

  it('通道清单与执行器清单是两份独立注册表', () => {
    const executorKeys = new Set(executors.map((entry) => entry.key))
    for (const entry of channels) expect(executorKeys.has(entry.key)).toBe(false)
  })
})

/** detect 汇总的测试脚手架：假 manifest/插件/宿主能力面，不启动进程、不碰真实文件系统。 */
const fakeManifest = (id: string): PluginManifest => ({
  id,
  kind: 'executor',
  name: id,
  version: '1.0.0',
  capabilities: ['spawn'],
})

function fakeEntry(key: string, detect?: ExecutorPlugin['detect']): ExecutorRegistryEntry {
  const plugin: ExecutorPlugin = {
    run: async () => {
      throw new Error('detect 测试不执行 run')
    },
  }
  if (detect !== undefined) plugin.detect = detect
  return { key, label: key, manifest: fakeManifest(key), plugin }
}

interface FakeHostOptions {
  dirs?: string[]
  found?: Record<string, string>
  log?: (line: string) => void
}

function fakeSdkHost(options: FakeHostOptions = {}): SdkHost {
  return {
    log: options.log ?? (() => undefined),
    now: () => 0,
    paths: { sessionRoot: null },
    config: <T = Record<string, unknown>>() => ({}) as T,
    process: {
      spawn: () => {
        throw new Error('detect 不允许启动子进程')
      },
      resolve: (command) => ({ path: null, error: `detect 不解析命令：${command}` }),
      killTree: () => false,
      scanDirs: () => options.dirs ?? [],
      findInDirs: (command) => options.found?.[command] ?? null,
    },
  }
}

const rawHit = (command: string): DetectedRuntime => ({
  command,
  label: command,
  path: `/bin/${command}`,
  executorKey: '',
  supported: false,
})

describe('detect 汇总（D8）', () => {
  it('按注册表顺序串行汇总、回填 executorKey/supported，输出按候选清单排序', async () => {
    const entries = [
      fakeEntry('beta', () => [rawHit('codex')]),
      fakeEntry('alpha', () => [rawHit('dsh')]),
    ]
    const host = fakeSdkHost({ dirs: ['/bin'], found: { claude: '/bin/claude' } })

    const result = await detectAllWith(entries, host)

    // dsh（插件 alpha）→ claude（本机已装、无插件）→ codex（插件 beta）：按 cli-catalog 顺序
    expect(result.map((item) => [item.command, item.executorKey, item.supported])).toEqual([
      ['dsh', 'alpha', true],
      ['claude', '', false],
      ['codex', 'beta', true],
    ])
  })

  it('内置注册表的 detectAll：dsh / claude 插件各自认领，其余已装 CLI 保持 supported:false', async () => {
    const host = fakeSdkHost({ dirs: ['/bin'], found: { dsh: '/bin/dsh', claude: '/bin/claude' } })

    const result = await detectAll(host)

    expect(
      result.map((item) => [item.command, item.label, item.executorKey, item.supported]),
    ).toEqual([
      ['dsh', 'DeepSeek Harness', 'dsh', true],
      ['claude', 'Claude Code', 'claude', true],
    ])
    // 汇总是只读的：不 spawn、不写库、不发 changed
    expect(() => host.process.spawn('x', [], { env: {} })).toThrow(/不允许启动子进程/)
  })

  it('本机装了但没有插件认领的 CLI 以 supported:false 出现（executorKey 为空）', async () => {
    const host = fakeSdkHost({ dirs: ['/bin'], found: { codex: '/bin/codex' } })

    const result = await detectAll(host)

    expect(result.map((item) => [item.command, item.executorKey, item.supported])).toEqual([
      ['codex', '', false],
    ])
  })

  it('同一 command 被多个插件声明：按注册表顺序先到先得并记一条 warn', async () => {
    const log = vi.fn()
    const entries = [
      fakeEntry('first', () => [rawHit('dsh')]),
      fakeEntry('second', () => [rawHit('dsh')]),
    ]

    const result = await detectAllWith(entries, fakeSdkHost({ log }))

    expect(result.map((item) => [item.command, item.executorKey])).toEqual([['dsh', 'first']])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('重复声明命令「dsh」'))
  })

  it('单个插件抛错只跳过该插件，不影响其它插件结果', async () => {
    const log = vi.fn()
    const entries = [
      fakeEntry('broken', () => {
        throw new Error('扫描炸了')
      }),
      fakeEntry('good', () => [rawHit('dsh')]),
    ]

    const result = await detectAllWith(entries, fakeSdkHost({ log }))

    expect(result.map((item) => item.command)).toEqual(['dsh'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('检测失败'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('扫描炸了'))
  })

  it('单个插件超时被跳过并记录日志', async () => {
    const log = vi.fn()
    const hanging = (): Promise<DetectedRuntime[]> => new Promise(() => undefined)
    const entries = [fakeEntry('slow', hanging), fakeEntry('good', () => [rawHit('dsh')])]

    const result = await detectAllWith(entries, fakeSdkHost({ log }), { timeoutMs: 10 })

    expect(result.map((item) => item.command)).toEqual(['dsh'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('检测失败'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('超时'))
  })

  it('空注册表返回空数组而不是抛错，也不扫描文件系统', async () => {
    const log = vi.fn()
    const findInDirs = vi.fn(() => '/bin/dsh')
    const host = fakeSdkHost({ log })
    host.process.findInDirs = findInDirs

    await expect(detectAllWith([], host)).resolves.toEqual([])
    expect(findInDirs).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('输出稳定：同一环境重复汇总结果逐项相同', async () => {
    const host = fakeSdkHost({ dirs: ['/bin'], found: { claude: '/bin/claude' } })
    const first = await detectAllWith([fakeEntry('dsh-like', () => [rawHit('dsh')])], host)
    const second = await detectAllWith([fakeEntry('dsh-like', () => [rawHit('dsh')])], host)
    expect(second).toEqual(first)
  })

  it('空命令被跳过、清单外命令排最后；非 Error 抛错同样按失败隔离', async () => {
    const log = vi.fn()
    const entries = [
      fakeEntry('mixed', () => [rawHit(''), rawHit('my-cli')]),
      fakeEntry('string-throw', () => {
        throw '扫描炸了'
      }),
    ]

    const result = await detectAllWith(
      entries,
      fakeSdkHost({ dirs: ['/bin'], found: { dsh: '/bin/dsh' }, log }),
    )

    // 空命令不进结果；my-cli 不在候选清单里，排在清单内命令之后
    expect(result.map((item) => [item.command, item.executorKey, item.supported])).toEqual([
      ['dsh', '', false],
      ['my-cli', 'mixed', true],
    ])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('扫描炸了'))
  })

  it('清单外命令排在前面时同样稳定排序（比较器另一向的清单外兜底）', async () => {
    const entries = [
      fakeEntry('dsh-like', () => [rawHit('dsh')]),
      fakeEntry('extra', () => [rawHit('my-cli')]),
    ]

    const result = await detectAllWith(entries, fakeSdkHost({ dirs: ['/bin'] }))

    expect(result.map((item) => [item.command, item.executorKey, item.supported])).toEqual([
      ['dsh', 'dsh-like', true],
      ['my-cli', 'extra', true],
    ])
  })

  it('cli-catalog 顺序即汇总输出顺序（顺序表与常量保持唯一来源）', () => {
    expect(CLI_CANDIDATES.map((item) => item.command)).toEqual([
      'dsh',
      'claude',
      'hermes',
      'codex',
      'gemini',
      'opencode',
      'aider',
      'cursor-agent',
      'qwen',
      'goose',
      'crush',
    ])
  })
})

describe('来源插件注册表（M7）', () => {
  const SOURCES_ROOT = resolve(import.meta.dirname, '../../src/plugins/sources')

  it('内置来源清单非空且 key 等于 manifest.id、kind 合法', () => {
    expect(sources.length).toBeGreaterThan(0)
    for (const entry of sources) {
      expect(entry.key).toBe(entry.manifest.id)
      expect(entry.manifest.kind).toBe('source')
      expect(
        entry.manifest.capabilities.every((capability) => CAPABILITIES.includes(capability)),
      ).toBe(true)
    }
  })

  it('webhook 来源声明 net 能力（监听 + 验签都经 sdk.net）', () => {
    const webhook = sourceById('webhook')
    expect(webhook.manifest.capabilities).toEqual(['net'])
    expect(webhook.plugin.start).toBeTypeOf('function')
  })

  it('未知来源 key 给可读错误（不猜、不降级）', () => {
    expect(() => sourceById('nope')).toThrow(/来源插件未注册: nope/)
    expect(() => sourceById('')).toThrow(/来源插件未注册/)
  })

  it('src/plugins/sources/* 目录与注册表清单双向一致', () => {
    if (!existsSync(SOURCES_ROOT)) {
      expect(sources).toEqual([])
      return
    }
    const dirIds = readdirSync(SOURCES_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const registryIds = sources.map((entry) => entry.key).sort()
    expect(registryIds).toEqual(dirIds)
  })
})
