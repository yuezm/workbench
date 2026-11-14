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
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECTION_DDL, PROJECTION_TABLES as HOST_PROJECTION_TABLES } from '../src/host/schema'
import { PROJECTION_TABLES as KERNEL_PROJECTION_TABLES } from '../src/kernel/core/types'
import { COMMAND_NAMES } from '../src/protocol/commands'
import { FACT_TYPES } from '../src/protocol/facts'
import { HOST_INPUT_NAMES, INPUT_NAMES } from '../src/protocol/inputs'
import {
  caseLabels,
  importSpecifiers,
  readSources,
  stripLiterals,
  tableKeys,
  type SourceFile,
} from './support/source'

const SRC_ROOT = resolve(import.meta.dirname, '../src')
const sources = readSources(SRC_ROOT)

const textOf = (relative: string): string => {
  const found = sources.find((file) => file.relative === relative)
  if (found === undefined) throw new Error(`找不到源文件：${relative}`)
  return found.text
}

/** 取路径前缀下的源文件（`kernel/`、`plugins/` 这类，相对 src/）。 */
const under = (prefix: string): SourceFile[] =>
  sources.filter((file) => file.relative.startsWith(prefix))

/**
 * 非相对路径（第三方或 Node 内置）的 import 清单。
 * kernel 允许的写法只有相对路径：`./x`、`../protocol/x`。
 */
const thirdPartyImports = (files: readonly SourceFile[]): string[] =>
  files.flatMap((file) =>
    importSpecifiers(stripLiterals(file.text).withoutComments)
      .filter((entry) => !entry.specifier.startsWith('.'))
      .map((entry) => `${file.relative}:${entry.line} 第三方 import「${entry.specifier}」`),
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

/** plugins 不得 import host（宿主的副作用面只经 sdk 暴露）。 */
const hostImportsIn = (files: readonly SourceFile[], prefix: string): string[] =>
  files
    .filter((file) => file.relative.startsWith(prefix))
    .flatMap((file) =>
      importSpecifiers(stripLiterals(file.text).withoutComments)
        .filter((entry) => /(^|\/)host\//.test(entry.specifier))
        .map((entry) => `${file.relative}:${entry.line} 越界 import「${entry.specifier}」`),
    )

/** renderer 不得直接碰 Electron / Node 内置（ESLint 之外的文本兜底）。 */
const nodeImportsInRenderer = (files: readonly SourceFile[]): string[] =>
  files
    .filter((file) => file.relative.startsWith('renderer/'))
    .flatMap((file) =>
      importSpecifiers(stripLiterals(file.text).withoutComments)
        .filter((entry) => entry.specifier === 'electron' || entry.specifier.startsWith('node:'))
        .map((entry) => `${file.relative}:${entry.line} 越界 import「${entry.specifier}」`),
    )

describe('arch：分层与真相源', () => {
  it('kernel 不 import 第三方模块（只允许相对路径）', () => {
    const violations = thirdPartyImports(under('kernel/'))
    expect(violations, `kernel 只能依赖相对路径与 protocol：\n${violations.join('\n')}`).toEqual([])
  })

  it('事实只由 host/store 追加', () => {
    const writers = factWriters(sources)
    expect(writers, `事实写入必须集中在 host/store（实测 ${writers.join(', ')}）`).toEqual([
      'host/store/facts.ts',
    ])
  })

  it('投影表只由 host/store 写入（不得绕过事实日志）', () => {
    const violations = projectionWriters(sources)
    expect(violations, `投影表写入必须走 host/store：\n${violations.join('\n')}`).toEqual([])
  })

  it('plugins 不 import host', () => {
    const violations = hostImportsIn(sources, 'plugins/')
    expect(violations, `插件只能依赖 sdk 与 protocol：\n${violations.join('\n')}`).toEqual([])
  })

  it('renderer 不 import electron 与 node 内置', () => {
    const violations = nodeImportsInRenderer(sources)
    expect(violations, `renderer 只能走桥接：\n${violations.join('\n')}`).toEqual([])
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
          "import type { Task } from '../protocol/entities'",
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
      file('plugins/executors/x/run.ts', "import { store } from '../../../host/store'"),
      file('renderer/src/app/x.ts', "import { ipcRenderer } from 'electron'"),
    ]
    expect(hostImportsIn(files, 'plugins/')).toEqual([
      'plugins/executors/x/run.ts:1 越界 import「../../../host/store」',
    ])
    expect(nodeImportsInRenderer(files)).toEqual([
      'renderer/src/app/x.ts:1 越界 import「electron」',
    ])
  })
})

// 供上面的「找不到源文件」分支保持可达：清单本身必须非空，否则断言全成空转。
describe('arch：扫描范围', () => {
  it('扫描到 src 下四层与内核目录', () => {
    expect(sources.length).toBeGreaterThan(150)
    expect(under('kernel/').length).toBeGreaterThan(20)
    expect(readFileSync(resolve(SRC_ROOT, 'kernel/decide.ts'), 'utf8').length).toBeGreaterThan(0)
  })
})
