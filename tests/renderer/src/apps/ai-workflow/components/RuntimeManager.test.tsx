import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiWorkflowApi,
  DetectedRuntime,
  Runtime,
  RuntimeInput,
  RuntimeModelOption,
  RuntimeProbe,
  RuntimeStatus,
} from '../../../../../../src/shared/ai-workflow-api'
import { RuntimeManager } from '../../../../../../src/renderer/src/apps/ai-workflow/components/RuntimeManager'

function setApi(api: unknown): void {
  ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = api
}

function makeProbe(over: Partial<RuntimeProbe> = {}): RuntimeProbe {
  return {
    state: 'ready',
    path: 'C:/tools/dsh.exe',
    cliVersion: '1.2.3',
    protocolVersion: 1,
    pluginVersion: null,
    error: null,
    output: 'probe ok',
    elapsedMs: 12,
    checkedAt: 't',
    ...over,
  }
}

function makeRuntime(over: Partial<Runtime> = {}): Runtime {
  return {
    id: 'r1',
    name: 'ds',
    protocolFamily: 'dsh',
    command: 'dsh',
    profile: 'multica',
    permissionMode: 'workspace-write',
    model: null,
    reasoningEffort: null,
    workdir: null,
    maxConcurrent: 2,
    enabled: true,
    createdAt: 't',
    lastProbe: makeProbe(),
    ...over,
  }
}

function makeStatus(
  runtimeId: string,
  over: Partial<RuntimeStatus['workload']> = {},
): RuntimeStatus {
  return { runtimeId, workload: { running: 0, queued: 0, maxConcurrent: 2, ...over } }
}

function makeDetected(over: Partial<DetectedRuntime> = {}): DetectedRuntime {
  return {
    command: 'dsh',
    label: 'DeepSeek Harness',
    path: 'C:/tools/dsh.exe',
    supported: true,
    ...over,
  }
}

/** 手动控制 resolve 的 promise，用于验证加载中 / 测试中的中间态 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeApi() {
  const runtimes = {
    list: vi.fn(async (): Promise<Runtime[]> => [makeRuntime()]),
    statuses: vi.fn(async (): Promise<RuntimeStatus[]> => [makeStatus('r1')]),
    detect: vi.fn(async (): Promise<DetectedRuntime[]> => []),
    create: vi.fn(async (input: RuntimeInput): Promise<Runtime> =>
      makeRuntime({ id: 'r2', ...input }),
    ),
    update: vi.fn(async (_id: string, patch: Partial<RuntimeInput>): Promise<Runtime> =>
      makeRuntime({ ...patch }),
    ),
    remove: vi.fn(async (_id: string): Promise<void> => undefined),
    probe: vi.fn(async (): Promise<RuntimeProbe> => makeProbe()),
    models: vi.fn(async (): Promise<RuntimeModelOption[]> => []),
  }
  setApi({ runtimes } as unknown as Partial<AiWorkflowApi>)
  return runtimes
}

beforeEach(() => vi.clearAllMocks())

describe('RuntimeManager', () => {
  it('清单展示名称/协议族/健康/CLI 版本/启动头/路径/负载', async () => {
    const runtimes = makeApi()
    runtimes.list.mockResolvedValue([makeRuntime()])
    runtimes.statuses.mockResolvedValue([makeStatus('r1', { running: 1, maxConcurrent: 2 })])

    render(<RuntimeManager />)

    expect(await screen.findByText('ds')).toBeInTheDocument()
    expect(screen.getByText('dsh')).toBeInTheDocument()
    expect(screen.getByText('可用 · 12ms')).toBeInTheDocument()
    expect(screen.getByText('CLI v1.2.3')).toBeInTheDocument()
    expect(screen.getByText('dsh --profile multica --stdio')).toBeInTheDocument()
    expect(screen.getByText('C:/tools/dsh.exe')).toBeInTheDocument()
    expect(screen.getByText('负载 1/2')).toBeInTheDocument()
    expect(screen.queryByText(/排队/)).not.toBeInTheDocument()
  })

  it('未检测 / 不可用 / 停用 / 排队都按契约展示', async () => {
    const runtimes = makeApi()
    runtimes.list.mockResolvedValue([
      makeRuntime({ id: 'r1', name: 'fresh', lastProbe: null, enabled: false }),
      makeRuntime({
        id: 'r2',
        name: 'broken',
        lastProbe: makeProbe({ state: 'unavailable', elapsedMs: 8, error: '登录态失效' }),
      }),
    ])
    runtimes.statuses.mockResolvedValue([
      makeStatus('r1'),
      makeStatus('r2', { queued: 2, running: 0, maxConcurrent: 4 }),
    ])

    render(<RuntimeManager />)

    expect(await screen.findByText('fresh')).toBeInTheDocument()
    expect(screen.getByText('未检测')).toBeInTheDocument()
    expect(screen.getByText('未解析到可执行文件')).toBeInTheDocument()
    expect(screen.getByText('已停用')).toBeInTheDocument()
    expect(screen.getByText('不可用 · 8ms')).toBeInTheDocument()
    expect(screen.getByText('负载 0/4')).toBeInTheDocument()
    expect(screen.getByText('排队 2')).toBeInTheDocument()
  })

  it('statuses 缺该运行时 use runtime.maxConcurrent 兜底', async () => {
    const runtimes = makeApi()
    runtimes.list.mockResolvedValue([makeRuntime({ maxConcurrent: 3 })])
    runtimes.statuses.mockResolvedValue([])

    render(<RuntimeManager />)
    expect(await screen.findByText('负载 0/3')).toBeInTheDocument()
  })

  it('清单加载失败展示错误', async () => {
    const runtimes = makeApi()
    runtimes.list.mockRejectedValue('boom')

    render(<RuntimeManager />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('检测清单区分支持/不支持/已添加', async () => {
    const runtimes = makeApi()
    runtimes.list.mockResolvedValue([makeRuntime({ command: 'dsh' })])
    runtimes.detect.mockResolvedValue([
      makeDetected({ command: 'dsh', label: 'DeepSeek Harness', supported: true }),
      makeDetected({ command: 'codex', label: 'Codex CLI', supported: true }),
      makeDetected({ command: 'claude', label: 'Claude Code', supported: false }),
    ])

    render(<RuntimeManager />)

    expect(await screen.findByText('已添加')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '使用' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '暂不支持' })).toBeDisabled()
    expect(screen.getByText('当前版本仅接入 DSH')).toBeInTheDocument()
  })

  it('扫描中显示进行态，未检测到 CLI 时给出提示', async () => {
    const runtimes = makeApi()
    const slow = deferred<DetectedRuntime[]>()
    runtimes.detect.mockReturnValue(slow.promise)

    render(<RuntimeManager />)

    expect(await screen.findByText('正在扫描本机 PATH…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '扫描中…' })).toBeDisabled()

    slow.resolve([])
    expect(await screen.findByText(/未检测到已安装的 CLI/)).toBeInTheDocument()
  })

  it('重新扫描拉取到结果；扫描失败展示错误', async () => {
    const runtimes = makeApi()
    runtimes.detect
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makeDetected({ command: 'codex', label: 'Codex CLI', path: 'C:/codex.exe' }),
      ])
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText(/未检测到已安装的 CLI/)

    await user.click(screen.getByRole('button', { name: '重新扫描' }))
    expect(await screen.findByText('Codex CLI')).toBeInTheDocument()
    expect(runtimes.detect).toHaveBeenCalledTimes(2)
  })

  it('检测失败与重新扫描失败都展示错误', async () => {
    const runtimes = makeApi()
    runtimes.detect
      .mockRejectedValueOnce(new Error('detect-boom'))
      .mockRejectedValueOnce(new Error('rescan-boom'))
    const user = userEvent.setup()
    render(<RuntimeManager />)

    expect(await screen.findByText('detect-boom')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重新扫描' }))
    expect(await screen.findByText('rescan-boom')).toBeInTheDocument()
  })

  it('检测结果「使用」预填新建表单（名称不冲突）', async () => {
    const runtimes = makeApi()
    runtimes.list.mockResolvedValue([makeRuntime({ name: 'ds' })])
    runtimes.detect.mockResolvedValue([
      makeDetected({ command: 'codex', label: 'Codex CLI', path: 'C:/codex.exe' }),
    ])
    const user = userEvent.setup()
    render(<RuntimeManager />)

    await user.click(await screen.findByRole('button', { name: '使用' }))

    expect(screen.getByLabelText('运行时名称')).toHaveValue('Codex CLI')
    expect(screen.getByLabelText('运行时命令')).toHaveValue('codex')
    expect(screen.getByLabelText('运行时 profile')).toHaveValue('multica')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('运行时名称')).not.toBeInTheDocument()
  })

  it('检测结果名称与既有运行时冲突时带命令后缀', async () => {
    const runtimes = makeApi()
    runtimes.list.mockResolvedValue([makeRuntime({ name: 'Codex CLI', command: 'old' })])
    runtimes.detect.mockResolvedValue([
      makeDetected({ command: 'codex', label: 'Codex CLI', supported: true }),
    ])
    const user = userEvent.setup()
    render(<RuntimeManager />)

    await user.click(await screen.findByRole('button', { name: '使用' }))
    expect(screen.getByLabelText('运行时名称')).toHaveValue('Codex CLI (codex)')
  })

  it('新建运行时：默认值提交、成功后关闭并刷新', async () => {
    const runtimes = makeApi()
    runtimes.list.mockResolvedValue([makeRuntime()])
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '新建运行时' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('新建运行时')
    await user.type(screen.getByLabelText('运行时名称'), '新的')
    await user.click(screen.getByRole('button', { name: '添加运行时' }))

    await waitFor(() => expect(runtimes.create).toHaveBeenCalled())
    expect(runtimes.create.mock.calls[0][0]).toMatchObject({
      name: '新的',
      command: 'dsh',
      profile: 'multica',
      permissionMode: 'workspace-write',
      model: null,
      reasoningEffort: null,
      workdir: null,
      maxConcurrent: 1,
      enabled: true,
    })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '添加运行时' })).not.toBeInTheDocument(),
    )
    expect(runtimes.list).toHaveBeenCalledTimes(2)
  })

  it('新建失败在弹窗内展示错误并保持打开', async () => {
    const runtimes = makeApi()
    runtimes.create.mockRejectedValue(new Error('create-fail'))
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '新建运行时' }))
    await user.type(screen.getByLabelText('运行时名称'), 'x')
    await user.click(screen.getByRole('button', { name: '添加运行时' }))

    expect(await screen.findByText('create-fail')).toBeInTheDocument()
    expect(screen.getByLabelText('运行时名称')).toBeInTheDocument()
  })

  it('编辑运行时：预填、读取模型目录、提交 update 后关闭并刷新', async () => {
    const runtimes = makeApi()
    runtimes.list.mockResolvedValue([
      makeRuntime({ name: 'ds', maxConcurrent: 3, enabled: true, workdir: 'D:/work' }),
    ])
    runtimes.models.mockResolvedValue([
      {
        id: 'deepseek/chat',
        label: 'DeepSeek Chat',
        provider: 'deepseek',
        default: true,
        thinkingLevels: ['low', 'high'],
        defaultThinkingLevel: 'low',
      },
    ])
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '编辑运行时 ds' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('编辑运行时')
    expect(runtimes.models).toHaveBeenCalledWith('r1')
    expect(screen.getByLabelText('运行时名称')).toHaveValue('ds')
    expect(screen.getByLabelText('运行时工作目录')).toHaveValue('D:/work')
    expect(screen.getByLabelText('运行时并发上限')).toHaveValue(3)

    await user.clear(screen.getByLabelText('运行时名称'))
    await user.type(screen.getByLabelText('运行时名称'), 'ds2')
    await user.click(screen.getByRole('checkbox', { name: '启用运行时' }))
    await user.click(screen.getByRole('button', { name: '保存运行时' }))

    await waitFor(() => expect(runtimes.update).toHaveBeenCalled())
    expect(runtimes.update.mock.calls[0][0]).toBe('r1')
    expect(runtimes.update.mock.calls[0][1]).toMatchObject({
      name: 'ds2',
      maxConcurrent: 3,
      enabled: false,
      workdir: 'D:/work',
    })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '保存运行时' })).not.toBeInTheDocument(),
    )
    expect(runtimes.list).toHaveBeenCalledTimes(2)
  })

  it('编辑失败也在弹窗内展示错误', async () => {
    const runtimes = makeApi()
    runtimes.update.mockRejectedValue(new Error('update-fail'))
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '编辑运行时 ds' }))
    await user.click(screen.getByRole('button', { name: '保存运行时' }))
    expect(await screen.findByText('update-fail')).toBeInTheDocument()
    expect(screen.getByLabelText('运行时名称')).toBeInTheDocument()
  })

  it('测试成功：测试中禁用并展示新耗时，其他行状态独立', async () => {
    const runtimes = makeApi()
    runtimes.list.mockResolvedValue([
      makeRuntime({ id: 'r1', name: 'ds', lastProbe: null }),
      makeRuntime({ id: 'r2', name: 'claude', command: 'claude', lastProbe: null }),
    ])
    runtimes.statuses.mockResolvedValue([makeStatus('r1'), makeStatus('r2')])
    const slow = deferred<RuntimeProbe>()
    runtimes.probe.mockReturnValue(slow.promise)
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '测试运行时 ds' }))
    expect(runtimes.probe).toHaveBeenCalledWith('r1')
    expect(screen.getByRole('button', { name: '测试运行时 ds' })).toBeDisabled()
    expect(screen.getByText('测试中…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试运行时 claude' })).toBeEnabled()

    slow.resolve(makeProbe({ elapsedMs: 42 }))
    expect(await screen.findByText('可用 · 42ms')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试运行时 ds' })).toBeEnabled()
    expect(screen.getByText('未检测')).toBeInTheDocument()
  })

  it('测试失败（不可用）可点开详情查看原因与输出', async () => {
    const runtimes = makeApi()
    runtimes.list.mockResolvedValue([makeRuntime({ lastProbe: null })])
    runtimes.statuses.mockResolvedValue([makeStatus('r1')])
    runtimes.probe.mockResolvedValue(
      makeProbe({
        state: 'unavailable',
        elapsedMs: 8,
        error: '登录态失效',
        output: 'stderr 尾部',
        cliVersion: null,
        path: null,
      }),
    )
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '测试运行时 ds' }))
    const badge = await screen.findByRole('button', { name: '不可用 · 8ms' })
    expect(badge).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('登录态失效')).not.toBeInTheDocument()

    await user.click(badge)
    expect(badge).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('登录态失效')).toBeInTheDocument()
    expect(screen.getByText('stderr 尾部')).toBeInTheDocument()
    expect(screen.getByText('未解析到可执行文件')).toBeInTheDocument()

    await user.click(badge)
    expect(screen.queryByText('登录态失效')).not.toBeInTheDocument()
  })

  it('探测失败缺原因时详情用兜底文案', async () => {
    const runtimes = makeApi()
    runtimes.list.mockResolvedValue([makeRuntime({ lastProbe: null })])
    runtimes.statuses.mockResolvedValue([makeStatus('r1')])
    runtimes.probe.mockResolvedValue(makeProbe({ state: 'unavailable', error: null, output: '' }))
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '测试运行时 ds' }))
    await user.click(await screen.findByRole('button', { name: /不可用 ·/ }))
    expect(screen.getByText('未知错误')).toBeInTheDocument()
  })

  it('探测调用抛错展示页面级错误', async () => {
    const runtimes = makeApi()
    runtimes.probe.mockRejectedValue(new Error('probe-boom'))
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '测试运行时 ds' }))
    expect(await screen.findByText('probe-boom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试运行时 ds' })).toBeEnabled()
  })

  it('删除运行时：成功刷新并清掉展开的探测详情', async () => {
    const runtimes = makeApi()
    let store: Runtime[] = [
      makeRuntime({
        lastProbe: makeProbe({ state: 'unavailable', error: '坏了', output: 'tail' }),
      }),
    ]
    runtimes.list.mockImplementation(async () => store)
    runtimes.statuses.mockResolvedValue([makeStatus('r1')])
    runtimes.remove.mockImplementation(async () => {
      store = []
    })
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '不可用 · 12ms' }))
    expect(screen.getByText('坏了')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '删除运行时 ds' }))
    await waitFor(() => expect(screen.queryByText('ds')).not.toBeInTheDocument())
    expect(screen.queryByText('坏了')).not.toBeInTheDocument()
  })

  it('删除其它运行时不收起已展开的详情', async () => {
    const runtimes = makeApi()
    let store: Runtime[] = [
      makeRuntime({
        id: 'r1',
        name: 'ds',
        lastProbe: makeProbe({ state: 'unavailable', error: '坏了', output: '' }),
      }),
      makeRuntime({ id: 'r2', name: 'claude', command: 'claude' }),
    ]
    runtimes.list.mockImplementation(async () => store)
    runtimes.statuses.mockResolvedValue([makeStatus('r1'), makeStatus('r2')])
    runtimes.remove.mockImplementation(async (id: string) => {
      store = store.filter((r) => r.id !== id)
    })
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '不可用 · 12ms' }))
    expect(screen.getByText('坏了')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '删除运行时 claude' }))
    await waitFor(() => expect(screen.queryByText('claude')).not.toBeInTheDocument())
    expect(screen.getByText('坏了')).toBeInTheDocument()
  })

  it('删除失败展示页面级错误', async () => {
    const runtimes = makeApi()
    runtimes.remove.mockRejectedValue(new Error('remove-fail'))
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '删除运行时 ds' }))
    expect(await screen.findByText('remove-fail')).toBeInTheDocument()
    expect(screen.getByText('ds')).toBeInTheDocument()
  })

  it('加载未完成即卸载不报错', async () => {
    const slow = deferred<Runtime[]>()
    const runtimes = makeApi()
    runtimes.list.mockReturnValue(slow.promise)
    const { unmount } = render(<RuntimeManager />)
    unmount()
    slow.resolve([makeRuntime()])
    await new Promise((r) => setTimeout(r, 0))
  })
})
