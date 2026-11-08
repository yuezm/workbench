/**
 * renderer 入口（M5）：main.tsx 只做两件事——校验 preload 桥接、装配 kernelStore、挂载 Workbench。
 * 这里 mock react-dom/client，断言「缺桥接直接报错」「有桥接先配置内核再 render」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchApi } from '../../../src/shared/workbench-api'

const { createRootMock, renderMock } = vi.hoisted(() => {
  const renderMock = vi.fn()
  const createRootMock = vi.fn(() => ({ render: renderMock }))
  return { createRootMock, renderMock }
})

vi.mock('react-dom/client', () => ({
  default: { createRoot: createRootMock },
}))

const queryMock = vi.fn(async (view: string) => (view === 'kernel.seq' ? 0 : ([] as unknown)))

function fakeBridge(): WorkbenchApi {
  return {
    dispatch: vi.fn(async () => ({ facts: [], value: null })) as WorkbenchApi['dispatch'],
    query: queryMock as unknown as WorkbenchApi['query'],
    subscribe: vi.fn(() => () => {}),
    // M10：项目文件夹选择器（这里只保证桥接形状完整，不实际弹框）
    pickFolder: vi.fn(async () => null),
    notify: vi.fn(),
  }
}

describe('renderer 入口 main.tsx', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete (window as unknown as { workbench?: WorkbenchApi }).workbench
  })

  it('preload 未注入：渲染启动失败页，不白屏、不挂载 Workbench', async () => {
    const { StartupFailure } =
      await import('../../../src/renderer/src/shell/components/StartupFailure')
    await import('../../../src/renderer/src/main')

    expect(createRootMock).toHaveBeenCalledTimes(1)
    expect(renderMock).toHaveBeenCalledTimes(1)
    const element = renderMock.mock.calls[0][0] as { type: unknown }
    expect(element.type).toBe(StartupFailure)
    // 没有桥接就不该去装配内核（否则会连不上宿主的订阅）
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('有桥接：先装配 kernel（取 kernel.seq 快照）再 createRoot().render(Workbench)', async () => {
    const bridge = fakeBridge()
    ;(window as unknown as { workbench?: WorkbenchApi }).workbench = bridge
    await import('../../../src/renderer/src/main')

    expect(bridge.subscribe).toHaveBeenCalledTimes(1)
    expect(queryMock).toHaveBeenCalledWith('kernel.seq')
    expect(createRootMock).toHaveBeenCalledTimes(1)
    expect(renderMock).toHaveBeenCalledTimes(1)
  })
})
