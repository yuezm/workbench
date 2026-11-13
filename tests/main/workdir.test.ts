// @vitest-environment node
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WORKDIR_NAME,
  WORKDIR_ENV,
  expandHome,
  resolveWorkdir,
} from '../../src/main/workdir'

const roots: string[] = []
const tempRoot = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-workdir-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('main/workdir', () => {
  it('未配置环境变量：落到 <home>/.workbench 并创建目录', () => {
    const home = tempRoot()
    const resolved = resolveWorkdir({ env: {}, home, fallback: home })
    expect(resolved).toBe(path.join(home, DEFAULT_WORKDIR_NAME))
    expect(existsSync(resolved)).toBe(true)
  })

  it('环境变量为绝对路径：直接用它（不影响 home）', () => {
    const home = tempRoot()
    const target = path.join(tempRoot(), 'agent-space')
    const resolved = resolveWorkdir({ env: { [WORKDIR_ENV]: target }, home, fallback: home })
    expect(resolved).toBe(path.resolve(target))
    expect(existsSync(resolved)).toBe(true)
  })

  it('环境变量里的 ~ 展开成 home；纯 ~ 就是 home', () => {
    const home = tempRoot()
    const a = resolveWorkdir({ env: { [WORKDIR_ENV]: '~/agents' }, home, fallback: home })
    expect(a).toBe(path.join(home, 'agents'))
    const b = resolveWorkdir({ env: { [WORKDIR_ENV]: '~' }, home, fallback: home })
    expect(b).toBe(path.resolve(home))
  })

  it('相对路径按 fallback 解析；空白环境变量视为未配置', () => {
    const home = tempRoot()
    const base = tempRoot()
    const relative = resolveWorkdir({ env: { [WORKDIR_ENV]: 'nested/work' }, home, fallback: base })
    expect(relative).toBe(path.join(base, 'nested', 'work'))
    expect(resolveWorkdir({ env: { [WORKDIR_ENV]: '   ' }, home, fallback: base })).toBe(
      path.join(home, DEFAULT_WORKDIR_NAME),
    )
  })

  it('目录建不出来（同名文件占位）：退回 fallback 并记一条日志', () => {
    const home = tempRoot()
    const occupied = path.join(home, 'occupied')
    writeFileSync(occupied, 'x')
    const log = vi.fn()
    const resolved = resolveWorkdir({ env: { [WORKDIR_ENV]: occupied }, home, fallback: home }, log)
    expect(resolved).toBe(home)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('默认工作目录不可用'))
  })

  it('expandHome 只认 ~ / ~/x，不认 ~user', () => {
    expect(expandHome('~', 'H')).toBe('H')
    expect(expandHome('~/a', 'H')).toBe(path.join('H', 'a'))
    expect(expandHome('~user/a', 'H')).toBe('~user/a')
    expect(expandHome('a/b', 'H')).toBe('a/b')
  })
})
