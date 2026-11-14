// @vitest-environment node
/**
 * 源码扫描夹具（`tests/architecture.test.ts` 用）。
 *
 * `tests/kernel/purity.test.ts` 里那套「剥离注释与字面量」的扫描逻辑是逐字符状态机，
 * 与本文件同源；跨层 / 真相源断言需要读全仓源码，故抽到 `tests/support/` 复用，
 * 避免每个断言各写一遍、各错一遍。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface SourceFile {
  /** 相对 `src/` 的 posix 路径，例如 `kernel/decide.ts`。 */
  relative: string
  absolute: string
  text: string
}

export interface Stripped {
  /** 注释已移除、字符串保留：用来找 import 路径（路径本身就是字符串）。 */
  withoutComments: string
  /** 注释与字符串都已移除：用来找 SQL / 符号。 */
  withoutStrings: string
}

const toPosix = (path: string): string => path.split(sep).join('/')

/**
 * 单次扫描剥离注释与字面量。必须一遍扫完：先按行剥注释会把字符串里的 `//`
 * （URL 之类）当成注释，把同一行后面的代码一起吞掉，造成漏报。
 * 替换只填空格、保留换行，所以行号不偏移；模板字符串整体按字符串处理。
 */
export function stripLiterals(code: string): Stripped {
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

/** 行号（1 基）：按字符下标回溯换行数。 */
export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

/** import / require 的说明符与行号，按出现顺序。 */
export function importSpecifiers(code: string): Array<{ specifier: string; line: number }> {
  const found: Array<{ specifier: string; line: number }> = []
  const fromRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const re of [fromRe, requireRe]) {
    for (const match of code.matchAll(re)) {
      found.push({ specifier: match[1], line: lineOf(code, match.index ?? 0) })
    }
  }
  return found
}

/** `switch` 的 `case 'x':` 标签，按出现顺序去重（同名字面量只留一次）。 */
export function caseLabels(code: string): string[] {
  const labels = [...code.matchAll(/case\s+'([^']+)'\s*:/g)].map((match) => match[1])
  return [...new Set(labels)]
}

/**
 * 对象字面量的字符串键（`'x': …`，出现在行首缩进后），按出现顺序去重。
 *
 * 用于「表驱动分派」：`decide.ts` 用 handler 表而不是 `switch`，键和 `case` 标签一样
 * 要与协议白名单一一对应。
 */
export function tableKeys(code: string): string[] {
  const keys = [...code.matchAll(/^\s+'([^']+)':/gm)].map((match) => match[1])
  return [...new Set(keys)]
}

/**
 * 递归读出某个根目录下的 `.ts` / `.tsx` 源文件（跳过测试文件）。
 * 返回顺序按目录遍历顺序，便于失败信息稳定复现。
 */
export function readSources(root: string, skip: RegExp = /\.test\.tsx?$/): SourceFile[] {
  const files: SourceFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (/\.tsx?$/.test(entry.name) && !skip.test(entry.name)) {
        files.push({
          relative: toPosix(relative(root, absolute)),
          absolute,
          text: readFileSync(absolute, 'utf8'),
        })
      }
    }
  }
  walk(root)
  return files
}
