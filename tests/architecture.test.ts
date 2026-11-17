// @vitest-environment node
/**
 * 架构边界断言（计划 M35-B）。
 *
 * 与 `tests/kernel/purity.test.ts` 同款思路：把「结构事实」写成可判定的断言，
 * 而不是靠 review 记住。这里守的是**跨层**与**真相源**两条边界：
 *
 * - 依赖方向：kernel 只依赖相对路径与 protocol；plugins 不 import host；renderer 不碰 Node/Electron。
 * - 真相源：事实只由 `host/store` 追加；投影表只由 `host/store` 写入（`schema.ts` 里的 `${targetTable}`
 *   是 M2 迁移期 SQL 构造器，按字面表名扫描，不会误判）。
 * - 契约一致：`COMMAND_NAMES + HOST_INPUT_NAMES` 与内核分派分支一致；`INPUT_NAMES` 与
 *   `view-spec` 切片一致；两张 `PROJECTION_TABLES` 一致且都有 DDL；每个事实类型都有投影与时间线分支。
 *
 * 断言本身会 dr 漂：`护栏自检` 用合成样本证明每组检测都能抓出违规（与 purity.test.ts 同款）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROJECTION_DDL,
  PROJECTION_TABLES as HOST_PROJECTION_TABLES,
} from '@workbench/host-store/schema'
import { PROJECTION_TABLES as KERNEL_PROJECTION_TABLES } from '@workbench/kernel/core/types'
import { COMMAND_NAMES } from '@workbench/protocol/commands'
import { FACT_TYPES } from '@workbench/protocol/facts'
import { HOST_INPUT_NAMES, INPUT_NAMES } from '@workbench/protocol/inputs'
import {
  caseLabels,
  importSpecifiers,
  readSources,
  stripLiterals,
  tableKeys,
  type SourceFile,
} from './support/source'

/**
 * 服务端与前端已拆成包（拆分 B5/B6）：`src/` 目录整体退役，扫描根改成分层命名空间。
 *
 * 前缀约定（断言文案用）：`server/…`、`client/<包>/…`、`web/…`。
 */
const API_ROOT = resolve(import.meta.dirname, '../packages/api/http/src')
const APP_SERVER_ROOT = resolve(import.meta.dirname, '../apps/server/src')
const CLIENT_ROOT = resolve(import.meta.dirname, '../packages/client')
const WEB_ROOT = resolve(import.meta.dirname, '../apps/web/src')

const serverSources: SourceFile[] = [
  ...readSources(API_ROOT).map((file) => ({ ...file, relative: `server/http/${file.relative}` })),
  ...readSources(APP_SERVER_ROOT).map((file) => ({
    ...file,
    relative: `server/app/${file.relative}`,
  })),
]

const clientSources: SourceFile[] = [
  ...readdirSync(CLIENT_ROOT)
    .filter((name) => existsSync(join(CLIENT_ROOT, name, 'src')))
    .flatMap((name) =>
      readSources(join(CLIENT_ROOT, name, 'src')).map((file) => ({
        ...file,
        relative: `client/${name.replace(/^client-/u, '')}/${file.relative}`,
      })),
    ),
  ...readSources(WEB_ROOT).map((file) => ({ ...file, relative: `web/${file.relative}` })),
]

/**
 * kernel 已搬进 `packages/core/kernel`（拆分 B2）。断言文案继续用 `kernel/` 前缀代表这一层，
 * 所以这里读包目录后补回前缀——所有调用点（`under('kernel/')`、`textOf('kernel/decide.ts')`）
 * 都不必跟着改路径。
 */
const KERNEL_ROOT = resolve(import.meta.dirname, '../packages/core/kernel/src')
const kernelSources: SourceFile[] = readSources(KERNEL_ROOT).map((file) => ({
  ...file,
  relative: `kernel/${file.relative}`,
}))

/**
 * 插件已各自成包（`packages/plugins/<包>/src`，拆分 B4）。断言文案继续用 `plugins/<包>/` 前缀，
 * 与拆包前的目录形态一致，调用点不用改。
 */
const HOST_ROOT = resolve(import.meta.dirname, '../packages/host/host/src')
const STORE_ROOT = resolve(import.meta.dirname, '../packages/host/store/src')

/**
 * 宿主已拆成 `@workbench/host` + `@workbench/host-store`（拆分 B3）：断言文案沿用 `host/`、
 * `host/store/` 前缀，调用点不用改。
 */
const hostSources: SourceFile[] = [
  ...readSources(HOST_ROOT).map((file) => ({ ...file, relative: `host/${file.relative}` })),
  ...readSources(STORE_ROOT).map((file) => ({
    ...file,
    relative: `host/store/${file.relative}`,
  })),
]

const PLUGINS_ROOT = resolve(import.meta.dirname, '../packages/plugins')
const pluginSources: SourceFile[] = readdirSync(PLUGINS_ROOT)
  .filter((name) => existsSync(join(PLUGINS_ROOT, name, 'src')))
  .flatMap((name) =>
    readSources(join(PLUGINS_ROOT, name, 'src')).map((file) => ({
      ...file,
      relative: `plugins/${name}/${file.relative}`,
    })),
  )

const allSources: SourceFile[] = [
  ...kernelSources,
  ...hostSources,
  ...pluginSources,
  ...serverSources,
  ...clientSources,
]

const textOf = (relative: string): string => {
  const pool = relative.startsWith('kernel/')
    ? kernelSources
    : relative.startsWith('plugins/')
      ? pluginSources
      : relative.startsWith('host/')
        ? hostSources
        : relative.startsWith('server/')
          ? serverSources
          : relative.startsWith('client/') || relative.startsWith('web/')
            ? clientSources
            : []
  const found = pool.find((file) => file.relative === relative)
  if (found === undefined) throw new Error(`找不到源文件：${relative}`)
  return found.text
}

/** 取路径前缀下的源文件（`server/`、`client/`、`host/` 这类分层命名空间）。 */
const under = (prefix: string): SourceFile[] =>
  allSources.filter((file) => file.relative.startsWith(prefix))

/** 仓库内包名前缀：拆分后跨包一律写包名，不再用 `../protocol/x` 这类相对路径。 */
const WORKSPACE_SCOPE = '@workbench/'

/**
 * 非相对路径、且不是仓库内包的 import 清单（真正的外部依赖 / Node 内置）。
 *
 * 拆分后内核依赖 `@workbench/protocol/*` 是合法的（protocol 是纯契约），所以 `@workbench/`
 * 在这里放行；「内核只准依赖 protocol、不准摸别的仓内包」由下面的用例单独判。
 */
const thirdPartyImports = (files: readonly SourceFile[]): string[] =>
  files.flatMap((file) =>
    importSpecifiers(stripLiterals(file.text).withoutComments)
      .filter((entry) => !entry.specifier.startsWith('.'))
      .filter((entry) => !entry.specifier.startsWith(WORKSPACE_SCOPE))
      .map((entry) => `${file.relative}:${entry.line} 第三方 import「${entry.specifier}」`),
  )

/** 仓库内包的 import 清单（用于把「只准依赖某一个包」写成断言）。 */
const workspaceImports = (files: readonly SourceFile[]): string[] =>
  files.flatMap((file) =>
    importSpecifiers(stripLiterals(file.text).withoutComments)
      .filter((entry) => entry.specifier.startsWith(WORKSPACE_SCOPE))
      .map((entry) => `${file.relative}:${entry.line} 仓内包 import「${entry.specifier}」`),
  )

/**
 * 追加事实的写入点（只允许 `host/store/facts.ts`）。
 * SQL 本身写在字符串字面量里，所以这里保留字符串、只剥注释；注释里的同名字样不算。
 */
const factWriters = (files: readonly SourceFile[]): string[] =>
  files
    .filter((file) => /INSERT\s+INTO\s+facts\b/i.test(stripLiterals(file.text).withoutComments))
    .map((file) => file.relative)

/** 投影表的直接写入点：按字面表名扫描；只允许 `host/store/**`。 */
const projectionWriters = (files: readonly SourceFile[]): string[] => {
  const tables = [
    ...KERNEL_PROJECTION_TABLES,
    'tasks',
    'workflows',
    'workflow_stages',
    'agents',
    'runtimes',
    'projects',
    'runs',
    'run_events',
    'conversations',
    'messages',
    'cards',
    'rule_sets',
    'rule_fires',
    'threads',
    'plugin_settings',
    'task_comments',
    'review_reports',
  ]
  const pattern = new RegExp(
    `(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:${[...new Set(tables)].join('|')})\\b`,
    'i',
  )
  return files
    .filter((file) => !file.relative.startsWith('host/store/'))
    .filter((file) => pattern.test(stripLiterals(file.text).withoutComments))
    .map((file) => file.relative)
}

/** 拆包后的形态：`@workbench/host`、`@workbench/host-store` 这类包名也算宿主的副作用面。 */
const isHostSpecifier = (specifier: string): boolean =>
  /(^|\/)host\//.test(specifier) ||
  specifier === '@workbench/host' ||
  specifier.startsWith('@workbench/host-')

/** plugins 不得 import host（宿主的副作用面只经 sdk 暴露）。 */
const hostImportsIn = (files: readonly SourceFile[], prefix: string): string[] =>
  files
    .filter((file) => file.relative.startsWith(prefix))
    .flatMap((file) =>
      importSpecifiers(stripLiterals(file.text).withoutComments)
        .filter((entry) => isHostSpecifier(entry.specifier))
        .map((entry) => `${file.relative}:${entry.line} 越界 import「${entry.specifier}」`),
    )

/**
 * renderer 不得直接碰 Node 内置、服务端实现或桌面运行时（ESLint 之外的文本兜底）。
 *
 * `electron` 留在清单里是防御性的：服务器形态已经删掉这个依赖，但一旦有人把
 * 「桌面壳」重新引回来，这条断言先红。
 */
const nodeImportsInRenderer = (files: readonly SourceFile[]): string[] =>
  files
    .filter((file) => file.relative.startsWith('client/') || file.relative.startsWith('web/'))
    .flatMap((file) =>
      importSpecifiers(stripLiterals(file.text).withoutComments)
        .filter(
          (entry) =>
            entry.specifier === 'electron' ||
            entry.specifier.startsWith('node:') ||
            /(^|\/)server\//.test(entry.specifier),
        )
        .map((entry) => `${file.relative}:${entry.line} 越界 import「${entry.specifier}」`),
    )

/** server 不得 import renderer（依赖方向 server → host/plugins → sdk → protocol 单向）。 */
/** 拆包后前端形态是 `@workbench/client-*`；`renderer/` 前缀保留给合成样本。 */
const isFrontendSpecifier = (specifier: string): boolean =>
  /(^|\/)renderer\//.test(specifier) || specifier.startsWith('@workbench/client-')

const rendererImportsIn = (files: readonly SourceFile[], prefix: string): string[] =>
  files
    .filter((file) => file.relative.startsWith(prefix))
    .flatMap((file) =>
      importSpecifiers(stripLiterals(file.text).withoutComments)
        .filter((entry) => isFrontendSpecifier(entry.specifier))
        .map((entry) => `${file.relative}:${entry.line} 越界 import「${entry.specifier}」`),
    )

/** server 只经插件注册表取插件：不得直接 import 具体 executors / sources / channels 实现。 */
const isPluginImplementation = (specifier: string): boolean =>
  /(^|\/)plugins\/(executors|sources|channels)\//.test(specifier) ||
  /^@workbench\/(executor|channel|source)-/.test(specifier)

const pluginImplementationImportsIn = (files: readonly SourceFile[], prefix: string): string[] =>
  files
    .filter((file) => file.relative.startsWith(prefix))
    .flatMap((file) =>
      importSpecifiers(stripLiterals(file.text).withoutComments)
        .filter((entry) => isPluginImplementation(entry.specifier))
        .map((entry) => `${file.relative}:${entry.line} 越界 import「${entry.specifier}」`),
    )

describe('arch：分层与真相源', () => {
  it('kernel 不 import 第三方模块（只允许相对路径与仓内契约包）', () => {
    const violations = thirdPartyImports(under('kernel/'))
    expect(
      violations,
      `kernel 只能依赖相对路径与 @workbench/protocol：\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('kernel 只依赖 @workbench/protocol（不摸其它仓内包）', () => {
    const violations = workspaceImports(under('kernel/')).filter(
      (entry) => !entry.includes(`「${WORKSPACE_SCOPE}protocol`),
    )
    expect(violations, `kernel 只准依赖 protocol：\n${violations.join('\n')}`).toEqual([])
  })

  it('事实只由 host/store 追加', () => {
    const writers = factWriters(under('host/'))
    expect(writers, `事实写入必须集中在 host/store（实测 ${writers.join(', ')}）`).toEqual([
      'host/store/facts.ts',
    ])
  })

  it('投影表只由 host/store 写入（不得绕过事实日志）', () => {
    const violations = projectionWriters([...serverSources, ...clientSources, ...under('host/')])
    expect(violations, `投影表写入必须走 host/store：\n${violations.join('\n')}`).toEqual([])
  })

  it('plugins 不 import host', () => {
    const violations = hostImportsIn(under('plugins/'), 'plugins/')
    expect(violations, `插件只能依赖 sdk 与 protocol：\n${violations.join('\n')}`).toEqual([])
  })

  it('renderer 不 import node 内置、服务端实现与 electron', () => {
    const violations = nodeImportsInRenderer(clientSources)
    expect(violations, `renderer 只能走桥接：\n${violations.join('\n')}`).toEqual([])
  })

  it('server 不 import renderer，也不直接 import 具体插件实现', () => {
    const renderer = rendererImportsIn(serverSources, 'server/')
    expect(renderer, `server 不得 import renderer：\n${renderer.join('\n')}`).toEqual([])
    const plugins = pluginImplementationImportsIn(serverSources, 'server/')
    expect(plugins, `server 只经注册表取插件：\n${plugins.join('\n')}`).toEqual([])
  })

  it('仓库不再依赖桌面运行时（package.json 里没有 electron*）', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    expect(all.filter((name) => name === 'electron' || name.startsWith('electron-'))).toEqual([])
  })
})

describe('arch：契约一致', () => {
  it('命令 + 宿主输入 与内核分派分支完全一致', () => {
    const dispatched = [
      ...caseLabels(textOf('kernel/decide.ts')),
      ...tableKeys(textOf('kernel/decide.ts')),
    ]
    const declared = [...COMMAND_NAMES, ...HOST_INPUT_NAMES]
    const missing = declared.filter((name) => !dispatched.includes(name))
    const extra = dispatched.filter((name) => !declared.includes(name))
    expect({ missing, extra }, '内核分派与协议白名单必须一一对应').toEqual({
      missing: [],
      extra: [],
    })
  })

  it('每个输入都有视图切片声明（禁止漏切片导致全表装载）', () => {
    const sliced = caseLabels(textOf('kernel/scopes/view-spec.ts'))
    const missing = INPUT_NAMES.filter((name) => !sliced.includes(name))
    expect(missing, `这些输入缺 viewSpec 分支：${missing.join(', ')}`).toEqual([])
  })

  it('两张 PROJECTION_TABLES 清单一致', () => {
    expect(HOST_PROJECTION_TABLES).toEqual(KERNEL_PROJECTION_TABLES)
  })

  it('每张投影表都有 DDL', () => {
    const missing = KERNEL_PROJECTION_TABLES.filter(
      (table) =>
        !new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`).test(PROJECTION_DDL),
    )
    expect(missing, `这些表在白名单里但没有 DDL：${missing.join(', ')}`).toEqual([])
  })

  it('每个事实类型都有投影分支与时间线分支', () => {
    const projected = caseLabels(textOf('kernel/scopes/project.ts'))
    const timed = caseLabels(textOf('kernel/scopes/timeline.ts'))
    const unprojected = FACT_TYPES.filter((type) => !projected.includes(type))
    const timeless = FACT_TYPES.filter((type) => !timed.includes(type))
    expect(unprojected, `这些事实类型没有投影分支：${unprojected.join(', ')}`).toEqual([])
    expect(timeless, `这些事实类型没有时间线分支：${timeless.join(', ')}`).toEqual([])
  })
})

describe('arch：护栏自检', () => {
  const file = (relative: string, text: string): SourceFile => ({
    relative,
    absolute: `/src/${relative}`,
    text,
  })

  it('能抓出 kernel 里的第三方 import 并给出文件与行号', () => {
    const dirty = [
      file(
        'kernel/dirty.ts',
        ["import { readFileSync } from 'node:fs'", '', 'export const x = 1'].join('\n'),
      ),
    ]
    expect(thirdPartyImports(dirty)).toEqual(['kernel/dirty.ts:1 第三方 import「node:fs」'])
  })

  it('能抓出绕过 store 的事实与投影写入', () => {
    const files = [
      file('host/store/facts.ts', "db.prepare('INSERT INTO facts (type) VALUES (?)')"),
      file('host/bypass.ts', "db.prepare('INSERT INTO facts (type) VALUES (?)')"),
      file('host/bypass2.ts', 'db.prepare(`UPDATE tasks SET title = ? WHERE id = ?`)'),
    ]
    expect(factWriters(files)).toEqual(['host/store/facts.ts', 'host/bypass.ts'])
    expect(projectionWriters(files)).toEqual(['host/bypass2.ts'])
  })

  it('注释里的违规词不算违规', () => {
    const clean = [
      file(
        'kernel/clean.ts',
        [
          "// 这里不能 import 'node:fs'，也不能写 UPDATE tasks SET x = 1",
          "import type { Task } from '@workbench/protocol/entities'",
          "export const label = 'Date.now() 由宿主传入'",
        ].join('\n'),
      ),
    ]
    expect(thirdPartyImports(clean)).toEqual([])
    expect(projectionWriters(clean)).toEqual([])
  })

  it('字符串里的 SQL 仍算写入（SQL 只存在于字面量，注释之外一律不放过）', () => {
    // 取舍：SQL 一定写在字符串里，剥掉字符串就等于放弃这条护栏。
    // 代价是「把 SQL 文案写进字符串」会误报——比漏报整条 bypass 通道便宜。
    const sneaky = [file('host/bypass3.ts', "const sql = 'DELETE FROM tasks WHERE id = ?'")]
    expect(projectionWriters(sneaky)).toEqual(['host/bypass3.ts'])
  })

  it('能抓出插件越界 import host 与 renderer 越界 import electron', () => {
    const files = [
      file('plugins/executor-x/src/run.ts', "import { store } from '@workbench/host'"),
      file('client/shell/src/app/x.ts', "import { ipcRenderer } from 'electron'"),
    ]
    expect(hostImportsIn(files, 'plugins/')).toEqual([
      'plugins/executor-x/src/run.ts:1 越界 import「@workbench/host」',
    ])
    expect(nodeImportsInRenderer(files)).toEqual([
      'client/shell/src/app/x.ts:1 越界 import「electron」',
    ])
    // 服务端反向依赖 renderer 与直接 import 插件实现同样要被抓出来
    const serverDirty = [
      file(
        'server/app/assembly.ts',
        "import { Workbench } from '@workbench/client-shell/Workbench'",
      ),
      file('server/app/assembly.ts', "import { dsh } from '@workbench/executor-dsh/index'"),
    ]
    expect(rendererImportsIn(serverDirty, 'server/')).toEqual([
      'server/app/assembly.ts:1 越界 import「@workbench/client-shell/Workbench」',
    ])
    expect(pluginImplementationImportsIn(serverDirty, 'server/')).toEqual([
      'server/app/assembly.ts:1 越界 import「@workbench/executor-dsh/index」',
    ])
  })
})

// 供上面的「找不到源文件」分支保持可达：清单本身必须非空，否则断言全成空转。
describe('arch：扫描范围', () => {
  it('扫描到各分层命名空间（内核 / 宿主 / 插件 / 服务端 / 前端）', () => {
    expect(serverSources.length).toBeGreaterThan(8)
    expect(clientSources.length).toBeGreaterThan(80)
    expect(pluginSources.length).toBeGreaterThan(30)
    expect(under('kernel/').length).toBeGreaterThan(20)
    expect(readFileSync(resolve(KERNEL_ROOT, 'decide.ts'), 'utf8').length).toBeGreaterThan(0)
  })
})
