// @vitest-environment node
/**
 * `resolveWorkdir` 的健壮性分支：
 * - 默认 `log` 回调（未注入时）本身要被调用到（编译为默认参数的匿名函数）；
 * - `mkdirSync` 抛出非 Error 时，错误文案按 `String(error)` 归一。
 * 通过局部 mock `node:fs` 让 `mkdirSync` 抛字符串来同时触达这两点。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdirSync: vi.fn(() => {
      throw 'disk-full'
    }),
  }
})

import { resolveWorkdir, WORKDIR_ENV } from '../../src/main/workdir'

describe('main/workdir · 建目录失败（非 Error）', () => {
  it('未注入 log：走默认回调且不抛，退回 fallback', () => {
    const fallback = 'C:/fallback-dir'
    const resolved = resolveWorkdir({
      env: { [WORKDIR_ENV]: 'C:/wanted' },
      home: 'C:/home',
      fallback,
    })
    expect(resolved).toBe(fallback)
  })

  it('注入 log：mkdirSync 抛非 Error 时文案按 String 归一，含原始信息', () => {
    const logs: string[] = []
    const fallback = 'C:/fallback-dir'
    const resolved = resolveWorkdir(
      { env: { [WORKDIR_ENV]: 'C:/wanted' }, home: 'C:/home', fallback },
      (line) => logs.push(line),
    )
    expect(resolved).toBe(fallback)
    expect(logs.join('\n')).toContain('默认工作目录不可用')
    expect(logs.join('\n')).toContain('disk-full')
  })
})
