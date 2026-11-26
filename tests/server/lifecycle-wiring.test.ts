// @vitest-environment node
/**
 * 装配接缝：`startWorkbenchServer` 交给 HTTP 层的那几个回调。
 *
 * 为什么单独一个文件：真实 HTTP 那条路能覆盖到 `publish` / `listDirs` / `info`，
 * 而 `notify` 的入参是**已归一化**的形状（`body` 由 `POST /api/notify` 的 handler 补齐），
 * 从真实请求那侧看不到「宿主该拿什么给事件流」。这里把 `startWebServer` 换成一个只收下
 * deps 的桩，拿到同一份回调后按契约直接调用，断言它落到事件流与日志上。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ApiDeps, WebServer } from '@workbench/api-http/http'
import type { LarkAdmin } from '@workbench/host/lark-admin'
import type { Workbench } from '@workbench/bundle-base'
import type { ServerConfig } from '@workbench/server/config'
import { startWorkbenchServer } from '@workbench/server/lifecycle'

const { captured } = vi.hoisted(() => ({ captured: { deps: null as unknown } }))

vi.mock('@workbench/api-http/http', () => ({
  startWebServer: async (deps: ApiDeps): Promise<WebServer> => {
    captured.deps = deps
    return { port: 4321, server: {} as WebServer['server'], close: async () => undefined }
  },
}))

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  dataDir: '/data',
  webDir: '/app/out/web',
  ui: 'auto',
  token: null,
  tokenSource: null,
}

function fakeWorkbench(): Workbench {
  return {
    router: {
      dispatch: async () => ({ facts: [], value: null }),
      query: async () => [],
    } as unknown as Workbench['router'],
    store: {} as Workbench['store'],
    lark: {} as LarkAdmin,
    info: () => ({
      name: 'workbench',
      version: '2.0.0',
      kernelVersion: 'M47.0.0',
      dataDir: '/data',
      defaultWorkdir: '/work',
      startedAt: 't',
      clients: 0,
      pid: 1,
    }),
    shutdown: async () => undefined,
  }
}

/** 起一次服务、收下交给 HTTP 层的 deps，然后立刻收尾 */
async function depsOf(logs: string[]): Promise<ApiDeps> {
  captured.deps = null
  const server = await startWorkbenchServer({
    config,
    assemble: async () => fakeWorkbench(),
    log: (line) => logs.push(line),
  })
  await server.stop()
  const deps = captured.deps
  expect(deps).not.toBeNull()
  return deps as ApiDeps
}

describe('startWorkbenchServer：交给 HTTP 层的回调', () => {
  it('带正文的知会照常拼接；info 与目录浏览读的也是装配层那一份', async () => {
    const logs: string[] = []
    const deps = await depsOf(logs)
    deps.notify({ title: '跑完了', body: '甲任务' })
    expect(logs.filter((line) => line.includes('[notify] 跑完了'))).toHaveLength(1)
    expect(deps.info()).toMatchObject({ name: 'workbench', pid: 1 })
    expect(deps.listDirs()).toMatchObject({ entries: expect.any(Array) as unknown })
    // 越界的目录按可读错误抛出（HTTP 层翻译成信封，不在这一层吞掉）
    expect(() => deps.listDirs('/definitely-not-a-dir')).toThrow(/目录不存在/u)
  })
})
