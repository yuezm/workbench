// @vitest-environment node
/**
 * 服务生命周期：装配 → 监听 → 退出，用假装配验证接缝。
 *
 * 关心的三件事：监听地址从哪来（`port=0` 时用系统分配的）、退出顺序（HTTP → 事件流 → 装配层）、
 * 退出幂等（信号连发两次不能把库关两遍）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LarkAdmin } from '@workbench/host/lark-admin'
import type { Workbench } from '@workbench/bundle-base'
import { API_PATHS } from '@workbench/protocol/http'
import { ConfigError, SERVER_ENV, type ServerConfig } from '@workbench/server/config'
import {
  displayHost,
  reportStartupError,
  runServerEntry,
  startWorkbenchServer,
  type StartedServer,
} from '@workbench/server/lifecycle'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeWorkbench(): Workbench & { shutdown: ReturnType<typeof vi.fn> } {
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
    shutdown: vi.fn(async () => undefined),
  }
}

const configOf = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  host: '127.0.0.1',
  port: 0,
  dataDir: tmpdir(),
  webDir: path.join(tmpdir(), 'wb-no-web'),
  ui: 'auto',
  token: null,
  tokenSource: null,
  ...overrides,
})

describe('startWorkbenchServer', () => {
  it('起在系统分配的端口上，info 走假装配；stop 幂等且先关 HTTP 再关装配', async () => {
    const workbench = fakeWorkbench()
    const assemble = vi.fn(async () => workbench)
    const server = await startWorkbenchServer({
      config: configOf(),
      assemble,
      log: () => undefined,
    })

    expect(server.port).toBeGreaterThan(0)
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
    const res = await fetch(`${server.url}/api/info`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; value: { pid: number } }
    expect(body).toMatchObject({ ok: true, value: { pid: 1 } })

    await server.stop()
    expect(workbench.shutdown).toHaveBeenCalledTimes(1)
    await server.stop()
    expect(workbench.shutdown).toHaveBeenCalledTimes(1)
    // HTTP 已关：再请求连不上
    await expect(fetch(`${server.url}/api/info`)).rejects.toThrow()
  })

  it('有 SSE 客户端在线：stop 立刻完成，并把事件流合上', async () => {
    const workbench = fakeWorkbench()
    const server = await startWorkbenchServer({
      config: configOf(),
      assemble: async () => workbench,
      log: () => undefined,
    })

    const abort = new AbortController()
    const sse = await fetch(`${server.url}/api/events`, { signal: abort.signal })
    expect(sse.status).toBe(200)
    const reader = sse.body!.getReader()
    // 首帧 `retry:` 到了才算连上（否则 close 时连接还没建好，测不到死等）
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('retry:')

    const startedAt = Date.now()
    await server.stop()
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    abort.abort()
    await reader.cancel().catch(() => undefined)
    expect(workbench.shutdown).toHaveBeenCalledTimes(1)
  })

  it('真装配 + 在线 SSE：stop 在宽限内完成（Ctrl+C 不该等浏览器断开）', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-lifecycle-real-'))
    created.push(dataDir)
    // 不注入 assemble：跑真的 createWorkbench，退出的另一半风险（来源/通道/库）也在内
    const server = await startWorkbenchServer({
      config: configOf({ dataDir }),
      log: () => undefined,
    })

    const abort = new AbortController()
    const sse = await fetch(`${server.url}/api/events`, { signal: abort.signal })
    const reader = sse.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('retry:')

    const startedAt = Date.now()
    await server.stop()
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    abort.abort()
    await reader.cancel().catch(() => undefined)
  })

  it('配置了 token：/api/info 需要会话', async () => {
    const server = await startWorkbenchServer({
      config: configOf({ token: 'k'.repeat(32), tokenSource: 'env' }),
      assemble: async () => fakeWorkbench(),
      log: () => undefined,
    })
    expect((await fetch(`${server.url}/api/info`)).status).toBe(401)
    await server.stop()
  })

  it('静态托管：Web 产物存在时首页可读', async () => {
    const webDir = mkdtempSync(path.join(tmpdir(), 'wb-lifecycle-web-'))
    created.push(webDir)
    writeFileSync(path.join(webDir, 'index.html'), '<title>Workbench</title>')
    const server = await startWorkbenchServer({
      config: configOf({ webDir }),
      assemble: async () => fakeWorkbench(),
      log: () => undefined,
    })
    const res = await fetch(server.url + '/')
    expect(await res.text()).toContain('Workbench')
    await server.stop()
  })

  it('装配失败：start 直接抛错（入口据此退出码 1，不留半套服务）', async () => {
    await expect(
      startWorkbenchServer({
        config: configOf(),
        assemble: async () => {
          throw new Error('库打不开')
        },
        log: () => undefined,
      }),
    ).rejects.toThrow('库打不开')
  })

  it('不注入 log：装配层的日志落到 stderr；SSE 广播与在线数是事件流的同一份', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const pushed: unknown[] = []
      let clients: number | null = null
      const server = await startWorkbenchServer({
        config: configOf(),
        assemble: async (options) => {
          options.log?.('装配完成')
          options.publish({ kind: 'notice', title: '装配', body: '' })
          pushed.push(options.publish)
          clients = options.clients?.() ?? -1
          return fakeWorkbench()
        },
      })
      expect(stderr.mock.calls.map((call) => String(call[0]))).toContain('装配完成\n')
      expect(pushed).toHaveLength(1)
      // 在线数就是事件流的当前连接数：此刻没有 SSE 客户端
      expect(clients).toBe(0)
      await server.stop()
    } finally {
      stderr.mockRestore()
    }
  })

  it('webDir 显式给 null：纯 API 模式（不托管产物，根路径给一段人话说明）', async () => {
    const server = await startWorkbenchServer({
      config: configOf(),
      assemble: async () => fakeWorkbench(),
      log: () => undefined,
      webDir: null,
    })
    const res = await fetch(server.url + '/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('纯 API 模式')
    await server.stop()
  })

  it('目录浏览与知会两条 HTTP 接缝都接到装配层', async () => {
    const workbench = fakeWorkbench()
    const server = await startWorkbenchServer({
      config: configOf(),
      assemble: async () => workbench,
      log: () => undefined,
    })

    const dirsRes = await fetch(`${server.url}${API_PATHS.dirs}`)
    expect(dirsRes.status).toBe(200)
    const dirsBody = (await dirsRes.json()) as {
      ok: boolean
      value: { path: string | null; roots: string[] }
    }
    expect(dirsBody.ok).toBe(true)
    // listDirs 真的走了 listDirectories：返回的是目录浏览的形状，不是空壳
    expect(Array.isArray(dirsBody.value.roots)).toBe(true)

    const notifyRes = await fetch(`${server.url}${API_PATHS.notify}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '跑完了', body: '甲任务' }),
    })
    expect(notifyRes.status).toBe(200)
    expect((await notifyRes.json()) as { value: { sent: boolean } }).toMatchObject({
      ok: true,
      value: { sent: true },
    })

    await server.stop()
  })
})

describe('runServerEntry', () => {
  const started = (): StartedServer & { stop: ReturnType<typeof vi.fn> } => ({
    port: 3000,
    url: 'http://127.0.0.1:3000',
    stop: vi.fn(async () => undefined),
  })

  it('打印固定启动行、挂两个信号、退出只跑一次', async () => {
    const server = started()
    const log = vi.fn()
    const handlers = new Map<string, () => void>()
    const exit = vi.fn()
    const entry = await runServerEntry({
      env: {},
      log,
      loadConfig: () => configOf({ token: 'k'.repeat(32), tokenSource: 'env' }),
      start: async () => server,
      onSignal: (signal, handler) => handlers.set(signal, handler),
      exit,
      resolveUi: () => ({ dir: 'out/web', reason: 'out/web' }),
    })

    const lines = log.mock.calls.map((call) => String(call[0]))
    expect(
      lines.some((line) => line.startsWith('workbench listening on http://127.0.0.1:3000')),
    ).toBe(true)
    // 有界面时启动行后缀写明产物目录（运维扫一眼就知道这次挂没挂 UI）
    expect(lines.some((line) => line.includes('(ui: out/web)'))).toBe(true)
    expect(JSON.stringify(log.mock.calls)).not.toContain('k'.repeat(32))
    expect(handlers.has('SIGINT')).toBe(true)
    expect(handlers.has('SIGTERM')).toBe(true)

    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(server.stop).toHaveBeenCalledTimes(1)
    await entry.stop('SIGINT')
    expect(server.stop).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('Web 产物缺失：先给一条可读提示，服务照常起（API 仍可用）', async () => {
    const log = vi.fn()
    await runServerEntry({
      env: {},
      log,
      loadConfig: () => configOf(),
      start: async () => started(),
      onSignal: () => undefined,
      exit: () => undefined,
      resolveUi: () => ({ dir: null, reason: '没有 Web 产物' }),
    })
    const lines = log.mock.calls.map((call) => String(call[0]))
    // 纯 API 模式的启动行要写清原因，且服务照常监听
    expect(lines.some((line) => line.includes('界面：纯 API 模式（没有 Web 产物）'))).toBe(true)
    expect(lines.some((line) => line.includes('(api only; 没有 Web 产物)'))).toBe(true)
    expect(lines.some((line) => line.startsWith('workbench listening on http://'))).toBe(true)
  })

  it('退出清理卡住：到时限就放弃清理并退出（信号语义是「一定退」）', async () => {
    const log = vi.fn()
    const exit = vi.fn()
    const entry = await runServerEntry({
      env: {},
      log,
      loadConfig: () => configOf(),
      start: async () => ({
        port: 1,
        url: 'http://127.0.0.1:1',
        // 永不 resolve：模拟插件留下的死等
        stop: () => new Promise<void>(() => undefined),
      }),
      onSignal: () => undefined,
      exit,
      stopDeadlineMs: 20,
      resolveUi: () => ({ dir: 'out/web', reason: 'out/web' }),
    })
    await entry.stop('SIGINT')
    expect(exit).toHaveBeenCalledWith(0)
    expect(JSON.stringify(log.mock.calls)).toContain('放弃剩余动作直接退出')
  })

  it('退出清理失败：记一条日志，仍然退出（不把进程吊住）', async () => {
    const log = vi.fn()
    const exit = vi.fn()
    const entry = await runServerEntry({
      env: {},
      log,
      loadConfig: () => configOf(),
      start: async () => ({
        port: 1,
        url: 'http://127.0.0.1:1',
        stop: async () => {
          throw new Error('close 超时')
        },
      }),
      onSignal: () => undefined,
      exit,
      resolveUi: () => ({ dir: 'out/web', reason: 'out/web' }),
    })
    await entry.stop('SIGINT')
    expect(JSON.stringify(log.mock.calls)).toContain('退出清理失败')
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('清理抛出的不是 Error（字符串）：日志按字符串写，照样退出', async () => {
    const log = vi.fn()
    const exit = vi.fn()
    const entry = await runServerEntry({
      env: {},
      log,
      loadConfig: () => configOf(),
      start: async () => ({
        port: 1,
        url: 'http://127.0.0.1:1',
        stop: () => Promise.reject('句柄关不掉'),
      }),
      onSignal: () => undefined,
      exit,
      resolveUi: () => ({ dir: 'out/web', reason: 'out/web' }),
    })
    await entry.stop('SIGTERM')
    expect(JSON.stringify(log.mock.calls)).toContain('句柄关不掉')
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('连退出时限的定时器都起不来：按清理失败记一条，仍然退出', async () => {
    const log = vi.fn()
    const exit = vi.fn()
    const entry = await runServerEntry({
      env: {},
      log,
      loadConfig: () => configOf(),
      start: async () => started(),
      onSignal: () => undefined,
      exit,
      resolveUi: () => ({ dir: 'out/web', reason: 'out/web' }),
    })
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
      throw new Error('定时器不可用')
    })
    try {
      await entry.stop('SIGTERM')
    } finally {
      setTimeoutSpy.mockRestore()
    }
    expect(JSON.stringify(log.mock.calls)).toContain('定时器不可用')
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('口令来自数据目录文件：启动行写清来源（不打印口令）', async () => {
    const log = vi.fn()
    await runServerEntry({
      env: {},
      log,
      loadConfig: () => configOf({ token: 'k'.repeat(32), tokenSource: 'file' }),
      start: async () => started(),
      onSignal: () => undefined,
      exit: () => undefined,
      resolveUi: () => ({ dir: null, reason: '没有 Web 产物' }),
    })
    const lines = log.mock.calls.map((call) => String(call[0]))
    expect(lines.some((line) => line.includes('口令来源：数据目录里的口令文件'))).toBe(true)
    expect(lines.join('\n')).not.toContain('k'.repeat(32))
  })

  it('不注入 env：loadConfig 收到 undefined（生产就是让它自己读 process.env）', async () => {
    const loadConfig = vi.fn(() => configOf())
    await runServerEntry({
      log: () => undefined,
      loadConfig,
      start: async () => started(),
      onSignal: () => undefined,
      exit: () => undefined,
      resolveUi: () => ({ dir: null, reason: '没有 Web 产物' }),
    })
    expect(loadConfig).toHaveBeenCalledWith(undefined)
  })

  it('不注入 exit：走 process.exit（生产就是这样退的）', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null): never => {
        throw Object.assign(new Error('process.exit fixture'), { code })
      })
    try {
      const entry = await runServerEntry({
        env: {},
        log: () => undefined,
        loadConfig: () => configOf(),
        start: async () => started(),
        onSignal: () => undefined,
        resolveUi: () => ({ dir: null, reason: '没有 Web 产物' }),
      })
      // exit 被换成抛错：断言退出码，并把这次「退出」截在测试里
      await expect(entry.stop('SIGINT')).rejects.toThrow('process.exit fixture')
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('一个接缝都不注入：读真实配置、起真装配、挂真信号、日志落 stderr', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'wb-entry-defaults-'))
    const webDir = mkdtempSync(path.join(tmpdir(), 'wb-entry-no-web-'))
    created.push(dataDir, webDir)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const exit = vi.fn()
    const listenersBefore = {
      SIGINT: process.listeners('SIGINT'),
      SIGTERM: process.listeners('SIGTERM'),
    }
    try {
      const entry = await runServerEntry({
        env: {
          [SERVER_ENV.port]: '0',
          [SERVER_ENV.dataDir]: dataDir,
          [SERVER_ENV.webDir]: webDir,
        },
        exit,
      })
      const added = (signal: 'SIGINT' | 'SIGTERM'): Array<() => void> =>
        process
          .listeners(signal)
          .filter((listener) => !listenersBefore[signal].includes(listener))
          .map((listener) => listener as unknown as () => void)

      expect(added('SIGINT')).toHaveLength(1)
      expect(added('SIGTERM')).toHaveLength(1)
      const printed = stderr.mock.calls.map((call) => String(call[0]))
      expect(
        printed.some((line) => line.startsWith('workbench listening on http://127.0.0.1:')),
      ).toBe(true)
      expect(printed.some((line) => line.includes('未启用鉴权（仅回环监听）'))).toBe(true)

      // 真信号处理器：SIGINT 与 SIGTERM 走同一条退出流程
      added('SIGINT')[0]?.()
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
      added('SIGTERM')[0]?.()
      await entry.stop('SIGTERM')
      expect(exit).toHaveBeenCalledTimes(1)
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        for (const listener of process.listeners(signal)) {
          if (!listenersBefore[signal].includes(listener)) process.off(signal, listener)
        }
      }
      stderr.mockRestore()
    }
  })
})

describe('reportStartupError', () => {
  it('配置错误只报文案；其它错误带栈，并置退出码 1', () => {
    const lines: string[] = []
    reportStartupError(new Error('端口非法：abc'), (line) => lines.push(line))
    expect(lines[0]).toContain('启动失败')
    expect(process.exitCode).toBe(1)

    const configLines: string[] = []
    reportStartupError(new ConfigError('监听 0.0.0.0 需要鉴权'), (line) => configLines.push(line))
    expect(configLines).toHaveLength(1)
    expect(configLines[0]).toContain('配置错误')
    process.exitCode = 0
  })

  it('不注入 log：落到 stderr；抛出的不是 Error 时按字符串写，没有栈就只有一行', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      reportStartupError('库文件被占用')
      const printed = stderr.mock.calls.map((call) => String(call[0]))
      expect(printed).toEqual(['[workbench] 启动失败：库文件被占用\n'])
      expect(process.exitCode).toBe(1)

      stderr.mockClear()
      const noStack = new Error('栈丢了')
      Object.defineProperty(noStack, 'stack', { value: undefined })
      reportStartupError(noStack)
      expect(stderr.mock.calls.map((call) => String(call[0]))).toEqual([
        '[workbench] 启动失败：栈丢了\n',
      ])
    } finally {
      stderr.mockRestore()
      process.exitCode = 0
    }
  })
})

describe('displayHost', () => {
  it('IPv6 加方括号，IPv4/域名原样', () => {
    expect(displayHost('127.0.0.1')).toBe('127.0.0.1')
    expect(displayHost('::1')).toBe('[::1]')
    expect(displayHost('::')).toBe('[::]')
  })
})
