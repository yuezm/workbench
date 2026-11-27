// @vitest-environment node
/**
 * 进程入口的「不该被 import 启动」约定，以及守卫本身的判据。
 *
 * `src/server/index.ts` 直接执行时起服务；被测试 import 时必须什么都不做——
 * 否则任何一个用例只要引到它就会绑端口、占数据目录（e2e 的临时目录约定也会被打破）。
 *
 * 守卫的判据是「进程入口脚本解析出来的就是本模块文件」：CJS 产物直接执行时成立，被 import /
 * 被别的模块 require 时不成立。两侧都先用文件系统归一（目录 → `<dir>/index.js`，再 realpath），
 * 所以 `node out/server` 与 `node out/server/index.js` 等价——以前只比 `path.resolve` 的字符串，
 * 目录形态下 `process.argv[1]` 原样是目录，守卫为假，进程装上模块就静默退出（exit 0、无日志）。
 * 判据与「真启动」都收在 `lifecycle.ts` 的 `isDirectRun` / `startIfDirect` 里，入口只负责把两个
 * 引用取出来传进去。以前写成 `require.main === module`：在 ESM（测试与 Vite SSR）里那两个全局
 * 根本不存在，真分支永远测不到。现在两支都能在这里直接构造 refs 覆盖，不依赖模块系统。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isDirectRun, startIfDirect } from '@workbench/server/lifecycle'

describe('server/index（入口守卫）', () => {
  it('被 import 时不注册信号、不绑端口', async () => {
    const sigintBefore = process.listenerCount('SIGINT')
    const sigtermBefore = process.listenerCount('SIGTERM')
    await import('@workbench/server/index')
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore)
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore)
  })

  it('isDirectRun：入口脚本就是本文件才为真；相对路径按 cwd 解析后比较；缺 argv 为假', () => {
    const entry = resolve('out/server/index.js')
    expect(isDirectRun({ entry, argv: entry })).toBe(true)
    // e2e / 运维脚本用相对路径起进程：解析后与文件绝对路径一致
    expect(isDirectRun({ entry, argv: 'out/server/index.js' })).toBe(true)
    expect(isDirectRun({ entry, argv: resolve('out/server/other.js') })).toBe(false)
    // 嵌入场景（argv[1] 不存在）不算直接执行
    expect(isDirectRun({ entry, argv: undefined })).toBe(false)
  })

  it('isDirectRun：argv 是包含入口的目录（`node out/server`）也为真', () => {
    const entry = resolve('out/server/index.js')
    // 真磁盘不一定有 out/（未构建），目录判定注入成「就是 out/server」
    const deps = { isDirectory: (target: string) => resolve(target) === resolve('out/server') }
    expect(isDirectRun({ entry, argv: 'out/server' }, deps)).toBe(true)
    // 别的目录不算：Node 装不到本模块
    expect(isDirectRun({ entry, argv: 'out/web' }, deps)).toBe(false)
  })

  it('isDirectRun：默认依赖下目录形态成立（真临时目录 + index.js）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workbench-entry-'))
    try {
      const entry = join(dir, 'index.js')
      writeFileSync(entry, '')
      expect(isDirectRun({ entry, argv: dir })).toBe(true)
      expect(isDirectRun({ entry, argv: join(dir, 'other.js') })).toBe(false)
      expect(isDirectRun({ entry, argv: join(dir, 'nested') })).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('isDirectRun：软链接 / 大小写差异经 realpath 归一后仍为真', () => {
    const entry = resolve('out/server/index.js')
    // realpath 一侧注入：目录 argv 归一后就是入口文件（模拟符号链接被解开）
    const deps = {
      isDirectory: (target: string) => resolve(target) === resolve('out/server'),
      realpath: (target: string): string | null =>
        target.toLowerCase().endsWith('index.js') ? resolve(entry) : null,
    }
    expect(isDirectRun({ entry, argv: 'out/server' }, deps)).toBe(true)
  })

  it('startIfDirect：守卫为假什么都不做（被 import 的情形）', async () => {
    const start = vi.fn(async () => undefined)
    const onError = vi.fn()
    startIfDirect(
      { entry: resolve('out/server/index.js'), argv: resolve('out/server/other.js') },
      start,
      onError,
    )
    await new Promise<void>((done) => setImmediate(done))
    expect(start).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('startIfDirect：守卫为真就启动，失败交给 onError（直接执行的情形）', async () => {
    const entry = resolve('out/server/index.js')
    const start = vi.fn(async () => {
      throw new Error('配置错误 fixture')
    })
    const onError = vi.fn()
    startIfDirect({ entry, argv: entry }, start, onError)
    await new Promise<void>((done) => setImmediate(done))
    expect(start).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('配置错误 fixture')
  })

  it('startIfDirect：成功启动时不碰 onError', async () => {
    const entry = resolve('out/server/index.js')
    const onError = vi.fn()
    startIfDirect({ entry, argv: entry }, async () => undefined, onError)
    await new Promise<void>((done) => setImmediate(done))
    expect(onError).not.toHaveBeenCalled()
  })
})
