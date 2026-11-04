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

/** 只剥掉注释与模板字符串，保留 import 路径（它本身是字符串）以便单独检查。 */
const stripComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

const importsOf = (code: string): string[] => {
  const specifiers: string[] = []
  const fromRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [fromRe, requireRe]) {
    for (const match of code.matchAll(re)) specifiers.push(match[1])
  }
  return specifiers
}

const violationsOf = (file: string, source: string): string[] => {
  const code = stripComments(source)
  const found: string[] = []

  for (const specifier of importsOf(code)) {
    if (FORBIDDEN_MODULES.includes(specifier)) {
      found.push(`${file}: 禁止 import「${specifier}」`)
      continue
    }
    const posix = toPosix(specifier)
    const hit = FORBIDDEN_IMPORT_PREFIXES.find((prefix) => posix.includes(`/${prefix}`))
    if (hit) found.push(`${file}: 禁止跨层 import「${specifier}」（只允许 src/protocol）`)
  }

  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      found.push(`${file}:${lineOf(code, match.index ?? 0)} 禁止使用 ${label}`)
    }
  }

  return found
}

describe('kernel 纯度', () => {
  it('不出现宿主/Node 能力、时钟、随机数、网络与跨层依赖', () => {
    const files = kernelSources()
    const violations = files.flatMap((file) =>
      violationsOf(toPosix(relative(KERNEL_ROOT, file)), readFileSync(file, 'utf8')),
    )

    expect(
      violations,
      `kernel 是纯模块：\n${violations.join('\n')}\n（扫描 ${files.length} 个源文件）`,
    ).toEqual([])
  })
})
