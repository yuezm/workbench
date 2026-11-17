// @vitest-environment node
/**
 * 进程入口的「不该被 import 启动」约定。
 *
 * `src/server/index.ts` 直接执行时起服务；被测试 import 时必须什么都不做——
 * 否则任何一个用例只要引到它就会绑端口、占数据目录（e2e 的临时目录约定也会被打破）。
 */
import { describe, expect, it } from 'vitest'

describe('server/index（入口守卫）', () => {
  it('被 import 时不注册信号、不绑端口', async () => {
    const sigintBefore = process.listenerCount('SIGINT')
    const sigtermBefore = process.listenerCount('SIGTERM')
    await import('@workbench/server/index')
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore)
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore)
  })
})
