// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const KERNEL_ROOT = import.meta.dirname

/** 禁用模块：宿主/Node 能力与反向依赖（ARCHITECTURE「边界守则 1」）。 */
const FORBIDDEN_MODULES = [
  'electron',
  'node:fs',
  'node:child_process',
  'node:http',
  'node:https',
  'node:net',
  'node:dns',
  'node:crypto',
]

/** 禁用符号：时钟、随机数、网络，以及跨层依赖（宿主/插件/渲染层）。 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bDate\s*\.\s*now\s*\(/g, label: 'Date.now()' },
  { pattern: /\bMath\s*\.\s*random\s*\(/g, label: 'Math.random()' },
  { pattern: /\brandomUUID\s*\(/g, label: 'randomUUID()' },
  { pattern: /\bfetch\s*\(/g, label: 'fetch()' },
]

/** 跨层 import 前缀：kernel 只允许依赖 src/protocol。 */
const FORBIDDEN_IMPORT_PREFIXES = ['shared/', 'main/', 'host/', 'plugins/', 'renderer/']

const isSourceFile = (name: string): boolean => name.endsWith('.ts') && !name.endsWith('.test.ts')

const kernelSources = (): string[] => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (isSourceFile(entry.name)) files.push(join(dir, entry.name))
    }
  }
  walk(KERNEL_ROOT)
  return files
}

const toPosix = (p: string): string => p.split(sep).join('/')

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length

const blank = (text: string): string => text.replace(/[^\n]/g, ' ')

/** 去掉注释；字符串保留，因为 import 路径本身就是字符串。 */
const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank)

/** 再去掉字符串与模板字面量，只留可执行代码（行号不因替换而偏移）。 */
const stripLiterals = (code: string): string =>
  stripComments(code)
    .replace(/'(?:\\.|[^'\\\n])*'/g, blank)
    .replace(/"(?:\\.|[^"\\\n])*"/g, blank)
    .replace(/`(?:\\.|[^`\\])*`/g, blank)

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

const violationsOf = (file: string, source: string): string[] => {
  const code = stripComments(source)
  const found: string[] = []

  for (const { specifier, index } of importsOf(code)) {
    const at = `${file}:${lineOf(code, index)}`
    if (FORBIDDEN_MODULES.includes(specifier)) {
      found.push(`${at} 禁止 import「${specifier}」`)
      continue
    }
    const posix = toPosix(specifier)
    const hit = FORBIDDEN_IMPORT_PREFIXES.find((prefix) => posix.includes(`/${prefix}`))
    if (hit) found.push(`${at} 禁止跨层 import「${specifier}」（只允许 src/protocol）`)
  }

  const symbols = stripLiterals(code)
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    for (const match of symbols.matchAll(pattern)) {
      found.push(`${file}:${lineOf(symbols, match.index ?? 0)} 禁止使用 ${label}`)
    }
  }

  return found
}

describe('kernel 纯度', () => {
  it('不出现宿主/Node 能力、时钟、随机数、网络与跨层依赖', () => {
    const files = kernelSources()
    expect(files.length, 'kernel 至少要有 1 个源文件，否则护栏空转').toBeGreaterThan(0)

    const violations = files.flatMap((file) =>
      violationsOf(toPosix(relative(KERNEL_ROOT, file)), readFileSync(file, 'utf8')),
    )

    expect(
      violations,
      `kernel 是纯模块：\n${violations.join('\n')}\n（扫描 ${files.length} 个源文件）`,
    ).toEqual([])
  })

  it('护栏能抓到违规样本，并给出文件与行号', () => {
    const dirty = [
      "import { readFileSync } from 'node:fs'",
      "import type { Task } from '../shared/ai-workflow-api'",
      'export const noise = (): number => Date.now() + Math.random()',
    ].join('\n')

    expect(violationsOf('dirty.ts', dirty)).toEqual([
      'dirty.ts:1 禁止 import「node:fs」',
      'dirty.ts:2 禁止跨层 import「../shared/ai-workflow-api」（只允许 src/protocol）',
      'dirty.ts:3 禁止使用 Date.now()',
      'dirty.ts:3 禁止使用 Math.random()',
    ])
  })

  it('不把注释与字符串里的禁用词当违规', () => {
    const clean = [
      "// 说明：这里不能写 Date.now()，也不能 import 'node:fs'",
      "import type { Task } from '../protocol/types'",
      "export const label = 'Date.now() 由宿主传入'",
      'export const ok = (task: Task | null): boolean => task !== null',
    ].join('\n')

    expect(violationsOf('clean.ts', clean)).toEqual([])
  })
})
