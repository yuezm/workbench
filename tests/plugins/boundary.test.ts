// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 插件边界门禁（SPEC-plugins「插件边界与审查要点 / 测试」）。
 *
 * 拆包后（B4）插件各自是 `packages/plugins/<包>/`，边界变成两条可判定的规则：
 * ① 相对 import 解析后必须仍在自己的包里（跨包只能写包名）；
 * ② 包名 import 只允许 `@workbench/protocol`、`@workbench/capabilities`、`@workbench/plugins-kit`
 *    （注册表包是唯一例外：它是静态导入点，可以 import 全部插件包）。
 * 外加 manifest 的 `capabilities` 声明与源码里 `sdk.*` 的实际用法是否一致。
 *
 * 只读包目录，不 import 任何插件实现（范式沿用 tests/kernel/purity.test.ts：剥注释/字符串 + 正则取 import）。
 */

const PLUGINS_ROOT = resolve(import.meta.dirname, '../../packages/plugins')

/** 允许插件依赖的仓内包（plugins → protocol + capabilities + plugins-kit）。 */
const ALLOWED_PACKAGES = [
  '@workbench/protocol',
  '@workbench/capabilities',
  '@workbench/plugins-kit',
]

/** 插件包的目录前缀：`executor-*` / `channel-*` / `source-*`。 */
const PLUGIN_PREFIXES = ['executor-', 'channel-', 'source-']

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
  /** 所属包（目录名，例如 `executor-dsh`）。 */
  packageName: string
  /** 相对 `packages/plugins/` 的 posix 路径，例如 `executor-dsh/src/index.ts`。 */
  path: string
  source: string
}

const isSourceFile = (name: string): boolean => name.endsWith('.ts') && !name.endsWith('.test.ts')

const listSources = (dir: string): string[] => {
  const files: string[] = []
  const walk = (current: string): void => {
    if (!existsSync(current)) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name))
      else if (isSourceFile(entry.name)) files.push(join(current, entry.name))
    }
  }
  walk(dir)
  return files
}

/** 插件包清单（`packages/plugins/*`，按目录名）。 */
const pluginPackages = (): string[] =>
  readdirSync(PLUGINS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(PLUGINS_ROOT, name, 'src')))

const packageFiles = (packageName: string): PluginFile[] =>
  listSources(join(PLUGINS_ROOT, packageName, 'src')).map((file) => ({
    packageName,
    path: `${packageName}/src/${toPosix(relative(join(PLUGINS_ROOT, packageName, 'src'), file))}`,
    source: readFileSync(file, 'utf8'),
  }))

const readAllPluginFiles = (): PluginFile[] => pluginPackages().flatMap(packageFiles)

/** 把相对 specifier 解析成相对 `packages/plugins/` 的虚拟路径（只做字符串解析，不读盘）。 */
const resolveSpecifier = (filePath: string, specifier: string): string => {
  const parts = filePath.split('/').slice(0, -1)
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

const isAllowedPackageSpecifier = (specifier: string): boolean =>
  ALLOWED_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))

/** 注册表包是唯一静态导入点：允许 import 全部插件包。 */
const isPluginPackageSpecifier = (specifier: string): boolean =>
  PLUGIN_PREFIXES.some((prefix) => specifier.startsWith(`@workbench/${prefix}`))

/**
 * 跨插件 import 判定：
 * - 相对 import 解析后必须仍在自己的包内；
 * - 包名 import 必须落在 ALLOWED_PACKAGES；`registry` 包额外允许全部插件包。
 */
const importViolationsOf = (files: readonly PluginFile[]): string[] => {
  const found: string[] = []
  for (const file of files) {
    const { withoutComments } = strip(file.source)
    const isRegistry = file.packageName === 'registry'
    for (const { specifier, index } of importsOf(withoutComments)) {
      const at = `${file.path}:${lineOf(withoutComments, index)}`
      if (specifier.startsWith('.')) {
        const resolved = resolveSpecifier(file.path, specifier)
        if (resolved.startsWith(`${file.packageName}/`)) continue
        found.push(
          `${at} 禁止跨插件 import「${specifier}」（解析到 ${resolved}；包内相对 import 只能留在本包，跨包请写包名）`,
        )
        continue
      }
      if (!specifier.startsWith('@workbench/')) continue
      if (isRegistry && isPluginPackageSpecifier(specifier)) continue
      if (isAllowedPackageSpecifier(specifier)) continue
      found.push(`${at} 禁止跨插件 import「${specifier}」（只允许 ${ALLOWED_PACKAGES.join('、')}）`)
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
  { capability: 'net', usage: /sdk\s*\.\s*net\s*\./ },
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

/** 某一类插件包的 capabilities 双向一致性检查（manifest 与源码都在包内）。 */
const capabilityFindingsFor = (prefix: string): { findings: string[]; count: number } => {
  const packages = pluginPackages().filter((name) => name.startsWith(prefix))
  const findings: string[] = []
  for (const packageName of packages) {
    const manifestPath = join(PLUGINS_ROOT, packageName, 'src', 'manifest.ts')
    expect(existsSync(manifestPath), `插件包 ${packageName} 缺少 src/manifest.ts`).toBe(true)
    const declared = declaredCapabilitiesOf(readFileSync(manifestPath, 'utf8'))
    findings.push(...capabilityViolationsOf(packageName, packageFiles(packageName), declared))
  }
  return { findings, count: packages.length }
}

describe('插件边界', () => {
  it('插件源码只 import 本包、@workbench/protocol、@workbench/capabilities、@workbench/plugins-kit', () => {
    const files = readAllPluginFiles()
    expect(files.length, '插件包至少要有 1 个源文件，否则护栏空转').toBeGreaterThan(0)

    const violations = importViolationsOf(files)

    expect(
      violations,
      `插件之间禁止互相 import，副作用只能来自 sdk：\n${violations.join('\n')}\n（扫描 ${files.length} 个源文件）`,
    ).toEqual([])
  })

  it('执行器插件的 capabilities 声明与 sdk 用法双向一致', () => {
    const { findings, count } = capabilityFindingsFor('executor-')
    expect(count, '至少要有一个执行器包').toBeGreaterThan(0)
    expect(
      findings,
      `capabilities 是授权声明，必须与 sdk 用法一致：\n${findings.join('\n')}\n（扫描 ${count} 个执行器包）`,
    ).toEqual([])
  })

  it('通道插件的 capabilities 声明与 sdk 用法双向一致（M4 T8）', () => {
    const { findings, count } = capabilityFindingsFor('channel-')
    expect(count, '至少要有一个通道包').toBeGreaterThan(0)
    expect(
      findings,
      `通道的 capabilities 是授权声明，必须与源码用法一致：\n${findings.join('\n')}\n（扫描 ${count} 个通道包）`,
    ).toEqual([])
  })

  it('来源插件的 capabilities 声明与 sdk 用法双向一致（M7 T4）', () => {
    const { findings, count } = capabilityFindingsFor('source-')
    expect(count, '至少要有一个来源包').toBeGreaterThan(0)
    expect(
      findings,
      `来源的 capabilities 是授权声明，必须与源码用法一致：\n${findings.join('\n')}\n（扫描 ${count} 个来源包）`,
    ).toEqual([])
  })
})

describe('插件边界护栏自检', () => {
  const file = (packageName: string, path: string, source: string): PluginFile => ({
    packageName,
    path: `${packageName}/src/${path}`,
    source,
  })

  it('能抓到跨包相对 import、越界包名与 registry 之外的插件互引', () => {
    const dirty: PluginFile[] = [
      file(
        'executor-dsh',
        'process.ts',
        "import { runCommand } from '../../executor-command/src/index'",
      ),
      file('executor-dsh', 'process.ts', "import { store } from '@workbench/host-store'"),
      file('channel-desktop', 'index.ts', "import { dsh } from '@workbench/executor-dsh'"),
    ]

    expect(importViolationsOf(dirty)).toEqual([
      'executor-dsh/src/process.ts:1 禁止跨插件 import「../../executor-command/src/index」（解析到 executor-command/src/index；包内相对 import 只能留在本包，跨包请写包名）',
      'executor-dsh/src/process.ts:1 禁止跨插件 import「@workbench/host-store」（只允许 @workbench/protocol、@workbench/capabilities、@workbench/plugins-kit）',
      'channel-desktop/src/index.ts:1 禁止跨插件 import「@workbench/executor-dsh」（只允许 @workbench/protocol、@workbench/capabilities、@workbench/plugins-kit）',
    ])
  })

  it('不把合法依赖与注释里的 import 当违规（registry 允许 import 插件包）', () => {
    const clean: PluginFile[] = [
      file(
        'executor-dsh',
        'index.ts',
        [
          "// 说明：这里不能写 import { x } from '../../executor-command/src/index'",
          "import type { Sdk } from '@workbench/capabilities/types'",
          "import { manifest } from './manifest'",
          "import { splitLines } from '@workbench/plugins-kit/jsonl'",
          "import type { Turn } from '@workbench/protocol/executor'",
        ].join('\n'),
      ),
      file('registry', 'index.ts', "import { dshExecutor } from '@workbench/executor-dsh'"),
    ]

    expect(importViolationsOf(clean)).toEqual([])
  })

  it('能力护栏能抓到「用了没声明」与「声明了没用」', () => {
    const files: PluginFile[] = [
      file(
        'executor-fake',
        'run.ts',
        'export const run = (sdk: Sdk): Promise<string> => sdk.fs.read("/tmp/x")',
      ),
    ]

    expect(capabilityViolationsOf('executor-fake', files, ['spawn'])).toEqual([
      'executor-fake: 源码用了 sdk 的「fs.read」能力，但 manifest.capabilities 未声明',
      'executor-fake: manifest.capabilities 声明了「spawn」，但源码没有对应用法',
    ])
  })

  it('notify 护栏：通道用 sdk.notify 必须声明 notify，声明了不用也报（M4 T6）', () => {
    // 通道插件经 `ctx.sdk` 拿能力面，规则必须同时认命名空间访问
    const usesNotify: PluginFile[] = [
      file(
        'channel-desktop',
        'index.ts',
        "export const start = (ctx: ChannelContext): void => ctx.sdk.notify('待审批', '正文')",
      ),
    ]
    expect(capabilityViolationsOf('channel-desktop', usesNotify, [])).toEqual([
      'channel-desktop: 源码用了 sdk 的「notify」能力，但 manifest.capabilities 未声明',
    ])
    expect(capabilityViolationsOf('channel-desktop', usesNotify, ['notify'])).toEqual([])

    // 反向：声明了 notify 但源码没调 → 也是违规（声明 = 授权面，实际未用）
    const noUsage: PluginFile[] = [
      file('channel-desktop', 'index.ts', 'export const start = (): void => undefined'),
    ]
    expect(capabilityViolationsOf('channel-desktop', noUsage, ['notify'])).toEqual([
      'channel-desktop: manifest.capabilities 声明了「notify」，但源码没有对应用法',
    ])
  })

  it('net 护栏：来源用 sdk.net 必须声明 net，声明了不用也报（M7 T3）', () => {
    const usesNet: PluginFile[] = [
      file(
        'source-webhook',
        'index.ts',
        'export const start = (ctx: SourceContext): void => { void ctx.sdk.net.listen(0, async () => ({ status: 200 })) }',
      ),
    ]
    expect(capabilityViolationsOf('source-webhook', usesNet, [])).toEqual([
      'source-webhook: 源码用了 sdk 的「net」能力，但 manifest.capabilities 未声明',
    ])
    expect(capabilityViolationsOf('source-webhook', usesNet, ['net'])).toEqual([])

    const noUsage: PluginFile[] = [
      file('source-webhook', 'index.ts', 'export const start = (): void => undefined'),
    ]
    expect(capabilityViolationsOf('source-webhook', noUsage, ['net'])).toEqual([
      'source-webhook: manifest.capabilities 声明了「net」，但源码没有对应用法',
    ])
  })
})
