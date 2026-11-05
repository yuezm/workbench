// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 插件边界门禁（SPEC-plugins「插件边界与审查要点 / 测试」）。
 *
 * ESLint 只能按 import specifier 的字面量拦跨层路径，表达不了两件事：
 * ① 插件之间用相对路径互相 import（specifier 里没有 `plugins` 段）；
 * ② manifest 的 `capabilities` 声明与源码里 `sdk.*` 的实际用法是否一致。
 * 这两件事落成本文件的源码扫描（范式照抄 tests/kernel/purity.test.ts：剥注释/字符串 + 正则取 import）。
 *
 * 只读 src/plugins，不 import 任何插件实现；executors 目录还没落盘时按「目录存在才断言」降级。
 */

const PLUGINS_ROOT = resolve(import.meta.dirname, '../../src/plugins')

/** 允许的跨插件共享面：只有 sdk、protocol 与 plugins/shared（shared 仅纯函数）。 */
const SHARED_PREFIXES = ['src/plugins/shared', 'src/sdk', 'src/protocol']

const KIND_DIRS = ['executors', 'sources', 'channels', 'apps']

const toPosix = (p: string): string => p.split(sep).join('/')

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length

interface Stripped {
  /** 注释已移除、字符串保留：用来找 import 路径（路径本身就是字符串）。 */
  withoutComments: string
  /** 注释与字符串都已移除：用来找 sdk 能力用法。 */
  withoutStrings: string
}

/**
 * 单次扫描剥离注释与字面量（与 purity.test 同一实现）：先按行剥注释会把字符串里的 `//`
 * 当成注释，把同一行后面的代码一起吞掉。替换只填空格、保留换行，行号不偏移。
 */
const strip = (code: string): Stripped => {
  const withoutComments: string[] = []
  const withoutStrings: string[] = []
  const keep = (ch: string): void => {
    withoutComments.push(ch)
    withoutStrings.push(ch)
  }
  const mask = (ch: string): void => {
    withoutComments.push(ch === '\n' ? '\n' : ' ')
    withoutStrings.push(ch === '\n' ? '\n' : ' ')
  }

  let i = 0
  while (i < code.length) {
    const ch = code[i]

    if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') {
        mask(code[i])
        i += 1
      }
      continue
    }

    if (ch === '/' && code[i + 1] === '*') {
      mask(code[i])
      mask(code[i + 1])
      i += 2
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        mask(code[i])
        i += 1
      }
      if (i < code.length) {
        mask(code[i])
        mask(code[i + 1])
        i += 2
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      withoutComments.push(ch)
      withoutStrings.push(' ')
      i += 1
      while (i < code.length) {
        const current = code[i]
        if (current === '\\' && i + 1 < code.length) {
          withoutComments.push(current, code[i + 1])
          withoutStrings.push(' ', code[i + 1] === '\n' ? '\n' : ' ')
          i += 2
          continue
        }
        withoutComments.push(current)
        withoutStrings.push(current === '\n' ? '\n' : ' ')
        i += 1
        if (current === quote) break
      }
      continue
    }

    keep(code[i])
    i += 1
  }

  return { withoutComments: withoutComments.join(''), withoutStrings: withoutStrings.join('') }
}

const importsOf = (code: string): Array<{ specifier: string; index: number }> => {
  const found: Array<{ specifier: string; index: number }> = []
  const fromRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [fromRe, requireRe]) {
    for (const match of code.matchAll(re)) {
      found.push({ specifier: match[1], index: match.index ?? 0 })
    }
  }
  return found
}

interface PluginFile {
  /** 相对 src/plugins 的 posix 路径，例如 `executors/dsh/index.ts`。 */
  path: string
  source: string
}

const isSourceFile = (name: string): boolean => name.endsWith('.ts') && !name.endsWith('.test.ts')

const listSources = (dir: string): string[] => {
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name))
      else if (isSourceFile(entry.name)) files.push(join(current, entry.name))
    }
  }
  walk(dir)
  return files
}

const readPluginFiles = (root: string): PluginFile[] =>
  listSources(root).map((file) => ({
    path: toPosix(relative(PLUGINS_ROOT, file)),
    source: readFileSync(file, 'utf8'),
  }))

/** 文件所属的插件目录（相对仓库根的虚拟路径）：具体插件是自己的目录，注册表/契约再导出是整个 plugins。 */
const pluginScopeOf = (filePath: string): string => {
  const segments = filePath.split('/')
  if (segments.length > 1 && KIND_DIRS.includes(segments[0])) {
    return `src/plugins/${segments[0]}/${segments[1]}`
  }
  if (segments.length > 1 && segments[0] === 'shared') return 'src/plugins/shared'
  return 'src/plugins'
}

/** 把相对 specifier 解析成相对仓库根的虚拟路径（只做字符串解析，不读盘）。 */
const resolveSpecifier = (filePath: string, specifier: string): string => {
  const parts = ['src', 'plugins', ...filePath.split('/').slice(0, -1)]
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

const isUnder = (target: string, prefix: string): boolean =>
  target === prefix || target.startsWith(`${prefix}/`)

/**
 * 跨插件 import：相对 import 解析后必须落在自己插件目录、`src/plugins/shared`、`src/sdk`
 * 或 `src/protocol` 之内；`src/plugins/registry.ts` 是唯一静态导入点，可以 import 任何插件。
 */
const importViolationsOf = (files: readonly PluginFile[]): string[] => {
  const found: string[] = []
  for (const file of files) {
    const { withoutComments } = strip(file.source)
    const scope = pluginScopeOf(file.path)
    const allowed = [scope, ...SHARED_PREFIXES]
    for (const { specifier, index } of importsOf(withoutComments)) {
      if (!specifier.startsWith('.')) continue
      const resolved = resolveSpecifier(file.path, specifier)
      if (allowed.some((prefix) => isUnder(resolved, prefix))) continue
      found.push(
        `${file.path}:${lineOf(withoutComments, index)} 禁止跨插件 import「${specifier}」` +
          `（解析到 ${resolved}；只允许本插件目录、src/plugins/shared、src/sdk、src/protocol）`,
      )
    }
  }
  return found
}

/** manifest 里声明的 capabilities（静态读取数组字面量，不执行插件代码）。 */
const declaredCapabilitiesOf = (manifestSource: string): string[] => {
  const { withoutComments } = strip(manifestSource)
  const array = /capabilities\s*:\s*\[([^\]]*)\]/.exec(withoutComments)
  if (!array) return []
  return Array.from(array[1].matchAll(/['"]([^'"]+)['"]/g), (match) => match[1])
}

/**
 * sdk 用法 → 需要的 capability：`sdk.process.*` 归 `spawn`，`sdk.notify(...)` 归 `notify`，
 * `sdk.fs.read/write` 各归其声明。规则同时匹配 `sdk.` 与 `ctx.sdk.` 这类命名空间访问。
 */
const capabilityUseRules: ReadonlyArray<{ capability: string; usage: RegExp }> = [
  { capability: 'spawn', usage: /sdk\s*\.\s*process\s*\./ },
  { capability: 'notify', usage: /sdk\s*\.\s*notify\s*\(/ },
  { capability: 'fs.read', usage: /sdk\s*\.\s*fs\s*\.\s*read\s*\(/ },
  { capability: 'fs.write', usage: /sdk\s*\.\s*fs\s*\.\s*write\s*\(/ },
]

const usedCapabilitiesOf = (files: readonly PluginFile[]): Set<string> => {
  const used = new Set<string>()
  for (const file of files) {
    const { withoutStrings } = strip(file.source)
    for (const { capability, usage } of capabilityUseRules) {
      if (usage.test(withoutStrings)) used.add(capability)
    }
  }
  return used
}

const capabilityViolationsOf = (
  pluginId: string,
  files: readonly PluginFile[],
  declared: readonly string[],
): string[] => {
  const used = usedCapabilitiesOf(files)
  const declaredSet = new Set(declared)
  const found: string[] = []
  for (const capability of [...used].sort()) {
    if (!declaredSet.has(capability)) {
      found.push(
        `${pluginId}: 源码用了 sdk 的「${capability}」能力，但 manifest.capabilities 未声明`,
      )
    }
  }
  for (const capability of [...declaredSet].sort()) {
    if (!used.has(capability)) {
      found.push(`${pluginId}: manifest.capabilities 声明了「${capability}」，但源码没有对应用法`)
    }
  }
  return found
}

describe('插件边界', () => {
  it('插件源码只 import 本插件目录、plugins/shared、sdk 与 protocol', () => {
    const files = readPluginFiles(PLUGINS_ROOT)
    expect(files.length, 'src/plugins 至少要有 1 个源文件，否则护栏空转').toBeGreaterThan(0)

    const violations = importViolationsOf(files)

    expect(
      violations,
      `插件之间禁止互相 import，副作用只能来自 sdk：\n${violations.join('\n')}\n（扫描 ${files.length} 个源文件）`,
    ).toEqual([])
  })

  it('执行器插件的 capabilities 声明与 sdk 用法双向一致', () => {
    const executorsRoot = join(PLUGINS_ROOT, 'executors')
    if (!existsSync(executorsRoot)) return

    const executorDirs = readdirSync(executorsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const findings: string[] = []
    for (const id of executorDirs) {
      const dir = join(executorsRoot, id)
      const manifestPath = join(dir, 'manifest.ts')
      expect(existsSync(manifestPath), `执行器插件 ${id} 缺少 manifest.ts`).toBe(true)
      const declared = declaredCapabilitiesOf(readFileSync(manifestPath, 'utf8'))
      findings.push(...capabilityViolationsOf(id, readPluginFiles(dir), declared))
    }

    expect(
      findings,
      `capabilities 是授权声明，必须与 sdk 用法一致：\n${findings.join('\n')}\n（扫描 ${executorDirs.length} 个执行器插件）`,
    ).toEqual([])
  })
})

describe('插件边界护栏自检', () => {
  it('能抓到跨插件 import 与越界 import，并给出文件与行号', () => {
    const dirty: PluginFile[] = [
      { path: 'executors/dsh/index.ts', source: "import { runCommand } from '../command/index'" },
      { path: 'executors/dsh/index.ts', source: "import { spawn } from '../../../host/process'" },
      { path: 'shared/jsonl.ts', source: "import { dsh } from '../executors/dsh/index'" },
    ]

    expect(importViolationsOf(dirty)).toEqual([
      'executors/dsh/index.ts:1 禁止跨插件 import「../command/index」（解析到 src/plugins/executors/command/index；只允许本插件目录、src/plugins/shared、src/sdk、src/protocol）',
      'executors/dsh/index.ts:1 禁止跨插件 import「../../../host/process」（解析到 src/host/process；只允许本插件目录、src/plugins/shared、src/sdk、src/protocol）',
      'shared/jsonl.ts:1 禁止跨插件 import「../executors/dsh/index」（解析到 src/plugins/executors/dsh/index；只允许本插件目录、src/plugins/shared、src/sdk、src/protocol）',
    ])
  })

  it('不把合法依赖与注释里的 import 当违规', () => {
    const clean: PluginFile[] = [
      {
        path: 'executors/dsh/index.ts',
        source: [
          "// 说明：这里不能写 import { x } from '../command/index'",
          "import type { Sdk } from '../../../sdk/types'",
          "import { manifest } from './manifest'",
          "import { splitLines } from '../../shared/jsonl'",
          "import type { Turn } from '../../../protocol/executor'",
        ].join('\n'),
      },
      { path: 'registry.ts', source: "import { dshExecutor } from './executors/dsh/index'" },
    ]

    expect(importViolationsOf(clean)).toEqual([])
  })

  it('能力护栏能抓到「用了没声明」与「声明了没用」', () => {
    const files: PluginFile[] = [
      {
        path: 'executors/fake/run.ts',
        source: 'export const run = (sdk: Sdk): Promise<string> => sdk.fs.read("/tmp/x")',
      },
    ]

    expect(capabilityViolationsOf('fake', files, ['spawn'])).toEqual([
      'fake: 源码用了 sdk 的「fs.read」能力，但 manifest.capabilities 未声明',
      'fake: manifest.capabilities 声明了「spawn」，但源码没有对应用法',
    ])
  })

  it('notify 护栏：通道用 sdk.notify 必须声明 notify，声明了不用也报（M4 T6）', () => {
    // 通道插件经 `ctx.sdk` 拿能力面，规则必须同时认命名空间访问
    const usesNotify: PluginFile[] = [
      {
        path: 'channels/desktop/index.ts',
        source:
          "export const start = (ctx: ChannelContext): void => ctx.sdk.notify('待审批', '正文')",
      },
    ]
    expect(capabilityViolationsOf('desktop', usesNotify, [])).toEqual([
      'desktop: 源码用了 sdk 的「notify」能力，但 manifest.capabilities 未声明',
    ])
    expect(capabilityViolationsOf('desktop', usesNotify, ['notify'])).toEqual([])

    // 反向：声明了 notify 但源码没调 → 也是违规（声明 = 授权面，实际未用）
    const noUsage: PluginFile[] = [
      { path: 'channels/desktop/index.ts', source: 'export const start = (): void => undefined' },
    ]
    expect(capabilityViolationsOf('desktop', noUsage, ['notify'])).toEqual([
      'desktop: manifest.capabilities 声明了「notify」，但源码没有对应用法',
    ])
  })
})
