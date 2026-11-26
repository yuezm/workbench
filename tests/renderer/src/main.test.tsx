/**
 * renderer 入口：main.tsx 只做三件事——装配浏览器桥接、探一次服务可用性、挂载 Workbench。
 *
 * 与桌面形态的差别：桥接不再是 preload 注入，而是入口自己创建的 HTTP/SSE 桥接；因此这里
 * mock 掉 `shared/bridge` 的工厂，断言：
 * ① 服务连不上时渲染启动失败页，不装配内核；
 * ② 服务可用时先装配内核（取 kernel.seq 快照）再 render；
 * ③ 知会管道在 render 之前接上，并且接的是 shell store 的 `pushOpenTarget`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoticeEvent } from '@workbench/protocol/http'
import type { OpenTarget } from '@workbench/protocol/ipc'
import type { WorkbenchApi } from '@workbench/contract-api'

const { createRootMock, renderMock, infoMock, onNoticeMock, toastMock } = vi.hoisted(() => {
  const renderMock = vi.fn()
  const createRootMock = vi.fn(() => ({ render: renderMock }))
  const infoMock = vi.fn()
  const onNoticeMock = vi.fn<(handler: (notice: NoticeEvent) => void) => () => void>(() => () => {})
  const toastMock = vi.fn()
  return { createRootMock, renderMock, infoMock, onNoticeMock, toastMock }
})

vi.mock('react-dom/client', () => ({
  default: { createRoot: createRootMock },
}))

vi.mock('@workbench/client-ui-kit/toast', () => ({ toast: toastMock }))

const queryMock = vi.fn(async (view: string) => (view === 'kernel.seq' ? 0 : ([] as unknown)))

/** 被测入口拿到的桥接（`createWebBridge` 的返回值） */
const fakeBridge: WorkbenchApi = {
  dispatch: vi.fn(async () => ({ facts: [], value: null })) as WorkbenchApi['dispatch'],
  query: queryMock as unknown as WorkbenchApi['query'],
  subscribe: vi.fn(() => () => {}),
  onNotice: onNoticeMock,
  listDirs: vi.fn(async () => ({ path: '/home/me', parent: null, roots: ['/'], entries: [] })),
  info: infoMock as unknown as WorkbenchApi['info'],
  lark: vi.fn() as unknown as WorkbenchApi['lark'],
  notify: vi.fn(),
}

vi.mock('@workbench/client-bridge', () => ({
  createWebBridge: () => fakeBridge,
  establishSession: vi.fn(async () => true),
}))

describe('renderer 入口 main.tsx', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete (window as unknown as { workbench?: WorkbenchApi }).workbench
    // 缺省：页面上没有 #root（产物被改坏 / 挂到了别的文档）——initTheme 与桥接照旧先落地
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('服务连不上：渲染启动失败页，不装配内核', async () => {
    infoMock.mockRejectedValue(new Error('Failed to fetch'))
    const { StartupFailure } = await import('@workbench/client-shell/components/StartupFailure')
    await import('@workbench/web/main')

    await vi.waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1))
    const element = renderMock.mock.calls[0]?.[0] as { type: unknown }
    expect(element.type).toBe(StartupFailure)
    // 没连上就不该去装配内核（否则订阅与快照都会连续失败）
    expect(queryMock).not.toHaveBeenCalled()
    expect(onNoticeMock).not.toHaveBeenCalled()
  })

  it('服务可用：先装配内核（取 kernel.seq 快照）再 createRoot().render(Workbench)', async () => {
    infoMock.mockResolvedValue({
      name: 'workbench',
      version: '2.0.0',
      kernelVersion: 'M47.0.0',
      dataDir: '/data',
      defaultWorkdir: '/work',
      startedAt: 't',
      clients: 1,
      pid: 1,
    })
    await import('@workbench/web/main')

    await vi.waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1))
    expect(infoMock).toHaveBeenCalledTimes(1)
    expect(fakeBridge.subscribe).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledWith('kernel.seq')
    // 桥接挂到 window.workbench：app 代码沿用同一个入口
    expect((window as unknown as { workbench?: WorkbenchApi }).workbench).toBe(fakeBridge)
  })

  it('知会管道在 render 之前接上：接到 shell store 的 pushOpenTarget', async () => {
    infoMock.mockResolvedValue({
      name: 'workbench',
      version: '2.0.0',
      kernelVersion: 'M47.0.0',
      dataDir: '/data',
      defaultWorkdir: '/work',
      startedAt: 't',
      clients: 1,
      pid: 1,
    })
    await import('@workbench/web/main')
    const openTargetModule = await import('@workbench/client-shell/openTarget')

    await vi.waitFor(() => expect(onNoticeMock).toHaveBeenCalledTimes(1))
    const handler = onNoticeMock.mock.calls[0]?.[0] as (notice: NoticeEvent) => void
    const target: OpenTarget = { appId: 'ai-workflow', taskId: 't1' }
    let seen: { appId?: string; taskId?: string } | null = null
    const off = openTargetModule.subscribeOpenTarget((pending) => {
      seen = pending
    })
    handler({ kind: 'notice', title: '任务完成', body: '甲任务', target })
    off()
    // 落点进了 shell store：切 app 与后续消费方都读同一份
    expect(seen).toMatchObject({ appId: 'ai-workflow', taskId: 't1' })
    expect(onNoticeMock.mock.invocationCallOrder[0]).toBeLessThan(
      renderMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    )
  })

  it('服务连不上但抛的不是 Error（字符串 / 对象）：启动失败页照样写清原因', async () => {
    // 页面里有 #root（正常产物）：容器取自它，失败页仍然照常渲染
    document.body.innerHTML = '<div id="root"></div>'
    infoMock.mockRejectedValue('连接被重置')
    const { StartupFailure } = await import('@workbench/client-shell/components/StartupFailure')
    await import('@workbench/web/main')

    await vi.waitFor(() => expect(renderMock).toHaveBeenCalledTimes(1))
    expect(createRootMock).toHaveBeenCalledWith(document.getElementById('root'))
    const element = renderMock.mock.calls[0]?.[0] as {
      type: unknown
      props: { message: string }
    }
    expect(element.type).toBe(StartupFailure)
    expect(element.props.message).toContain('连接被重置')
  })

  it('知会没有正文也没有落点：只弹标题，不动落点队列', async () => {
    infoMock.mockResolvedValue({
      name: 'workbench',
      version: '2.0.0',
      kernelVersion: 'M47.0.0',
      dataDir: '/data',
      defaultWorkdir: '/work',
      startedAt: 't',
      clients: 1,
      pid: 1,
    })
    await import('@workbench/web/main')
    const openTargetModule = await import('@workbench/client-shell/openTarget')

    await vi.waitFor(() => expect(onNoticeMock).toHaveBeenCalledTimes(1))
    const handler = onNoticeMock.mock.calls[0]?.[0] as (notice: NoticeEvent) => void
    let seen: unknown = null
    const off = openTargetModule.subscribeOpenTarget((pending) => {
      seen = pending
    })
    handler({ kind: 'notice', title: '测试全绿', body: '' })
    off()

    expect(toastMock).toHaveBeenCalledWith('测试全绿', 'info')
    expect(seen).toBeNull()
  })
})
