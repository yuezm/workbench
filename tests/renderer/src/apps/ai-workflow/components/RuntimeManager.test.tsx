import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Command } from '../../../../../../src/protocol/commands'
import type {
  DetectedRuntime,
  Runtime,
  RuntimeExecutorChoice,
  RuntimeProbe,
  RuntimeStatus,
} from '../../../../../../src/protocol/entities'
import type { DispatchResult } from '../../../../../../src/protocol/ipc'
import type { ViewId, ViewParams, ViewResult } from '../../../../../../src/protocol/views'
import { RuntimeManager } from '../../../../../../src/renderer/src/apps/ai-workflow/components/RuntimeManager'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

/** 执行器清单：与弹窗共用（顺序即注册表顺序，dsh 首项） */
const EXECUTORS: RuntimeExecutorChoice[] = [
  { key: 'dsh', label: 'DeepSeek Harness', command: 'dsh', profile: 'multica' },
  { key: 'command', label: '通用命令', command: 'my-cli', profile: '' },
]

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
    executorKey: 'dsh',
    argsTemplate: '',
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
    executorKey: 'dsh',
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

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

afterEach(() => {
  stopFakeKernel()
})

interface SetupOptions {
  runtimes?: Runtime[]
  statuses?: RuntimeStatus[]
  detected?: DetectedRuntime[]
  executors?: RuntimeExecutorChoice[]
}

/** 预置视图：清单/负载走 useKernelViewState，探测与执行器清单是宿主视图 */
function setup(options: SetupOptions = {}): void {
  kernel.setView('runtimes.all', undefined, options.runtimes ?? [makeRuntime()])
  kernel.setView('runtimes.statuses', undefined, options.statuses ?? [makeStatus('r1')])
  kernel.setView('runtimes.executors', undefined, options.executors ?? EXECUTORS)
  kernel.setView('runtimes.detected', undefined, options.detected ?? [])
}

/** dispatch 注入：绕过 onDispatch 的泛型签名，测试里按命令 type 分支 */
function handleDispatch(
  handler: (command: Command) => Promise<DispatchResult<unknown>> | DispatchResult<unknown>,
): void {
  kernel.onDispatch(handler as unknown as Parameters<FakeKernel['onDispatch']>[0])
}

/** 记录窗口对 store.query 的调用（宿主视图走它） */
function recordQueries(): Array<{ view: ViewId; params?: unknown }> {
  const calls: Array<{ view: ViewId; params?: unknown }> = []
  const original = kernel.store.query
  kernel.store.query = <T extends ViewId>(
    view: T,
    params?: ViewParams<T>,
  ): Promise<ViewResult<T>> => {
    calls.push({ view, params })
    return original(view, params)
  }
  return calls
}

describe('RuntimeManager', () => {
  it('清单展示名称/执行器/健康/CLI 版本/启动头/路径/负载', async () => {
    setup({
      statuses: [makeStatus('r1', { running: 1, maxConcurrent: 2 })],
    })

    render(<RuntimeManager />)

    expect(await screen.findByText('ds')).toBeInTheDocument()
    expect(await screen.findByText('DeepSeek Harness')).toBeInTheDocument()
    expect(screen.getByText('可用 · 12ms')).toBeInTheDocument()
    expect(screen.getByText('CLI v1.2.3')).toBeInTheDocument()
    expect(screen.getByText('dsh --profile multica')).toBeInTheDocument()
    expect(screen.getByText('C:/tools/dsh.exe')).toBeInTheDocument()
    expect(screen.getByText('负载 1/2')).toBeInTheDocument()
    expect(screen.queryByText(/排队/)).not.toBeInTheDocument()
  })

  it('启动头只显示命令本身：profile 为空（claude / hermes 等）时不拼 --profile', async () => {
    setup({
      runtimes: [
        makeRuntime({
          id: 'r1',
          name: 'claude',
          executorKey: 'claude',
          command: 'claude',
          profile: '',
        }),
      ],
      statuses: [makeStatus('r1')],
    })

    render(<RuntimeManager />)

    expect((await screen.findAllByText('claude')).length).toBeGreaterThan(0)
    // 启动头只显示命令本身：没有 profile 就不该出现 --profile
    expect(screen.queryByText(/--profile/)).not.toBeInTheDocument()
  })

  it('执行器角标显示清单 label；清单映射不到时回退原始 key', async () => {
    setup({
      runtimes: [
        makeRuntime({ id: 'r1', name: 'ds', executorKey: 'dsh' }),
        makeRuntime({ id: 'r2', name: 'legacy', executorKey: 'ghost' }),
      ],
      statuses: [makeStatus('r1'), makeStatus('r2')],
    })

    render(<RuntimeManager />)

    expect(await screen.findByText('DeepSeek Harness')).toBeInTheDocument()
    expect(screen.getByText('ghost')).toBeInTheDocument()
  })

  it('未检测 / 不可用 / 停用 / 排队都按契约展示', async () => {
    setup({
      runtimes: [
        makeRuntime({ id: 'r1', name: 'fresh', lastProbe: null, enabled: false }),
        makeRuntime({
          id: 'r2',
          name: 'broken',
          lastProbe: makeProbe({ state: 'unavailable', elapsedMs: 8, error: '登录态失效' }),
        }),
      ],
      statuses: [makeStatus('r1'), makeStatus('r2', { queued: 2, running: 0, maxConcurrent: 4 })],
    })

    render(<RuntimeManager />)

    expect(await screen.findByText('fresh')).toBeInTheDocument()
    expect(screen.getByText('未检测')).toBeInTheDocument()
    expect(screen.getByText('未找到可执行文件')).toBeInTheDocument()
    expect(screen.getByText('已停用')).toBeInTheDocument()
    expect(screen.getByText('不可用 · 8ms')).toBeInTheDocument()
    expect(screen.getByText('负载 0/4')).toBeInTheDocument()
    expect(screen.getByText('排队 2')).toBeInTheDocument()
  })

  it('statuses 缺该运行时 use runtime.maxConcurrent 兜底', async () => {
    setup({ runtimes: [makeRuntime({ maxConcurrent: 3 })], statuses: [] })

    render(<RuntimeManager />)
    expect(await screen.findByText('负载 0/3')).toBeInTheDocument()
  })

  it('清单读取失败展示错误', async () => {
    setup()
    kernel.failView('runtimes.all', undefined, 'boom')

    render(<RuntimeManager />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('检测清单区分支持/不支持/已添加', async () => {
    setup({
      runtimes: [makeRuntime({ command: 'dsh' })],
      detected: [
        makeDetected({ command: 'dsh', label: 'DeepSeek Harness', supported: true }),
        makeDetected({ command: 'codex', label: 'Codex CLI', supported: true }),
        makeDetected({ command: 'claude', label: 'Claude Code', supported: false }),
      ],
    })

    render(<RuntimeManager />)

    expect(await screen.findByText('已添加')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '使用' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '不支持' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '不支持' })).toHaveAttribute(
      'title',
      expect.stringContaining('DSH'),
    )
  })

  it('扫描中显示进行态，未检测到 CLI 时给出提示', async () => {
    setup()
    const slow = deferred<unknown>()
    const original = kernel.store.query
    kernel.store.query = <T extends ViewId>(
      view: T,
      params?: ViewParams<T>,
    ): Promise<ViewResult<T>> => {
      if (view === 'runtimes.detected') return slow.promise as Promise<ViewResult<T>>
      return original(view, params)
    }

    render(<RuntimeManager />)

    expect(await screen.findByText('正在扫描本机 PATH…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '扫描中…' })).toBeDisabled()

    await act(async () => {
      slow.resolve([])
    })
    expect(await screen.findByText(/未检测到 CLI/)).toBeInTheDocument()
  })

  it('重新扫描拉取到结果；扫描失败展示错误', async () => {
    setup({ detected: [] })
    const queries = recordQueries()
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText(/未检测到 CLI/)

    kernel.setView('runtimes.detected', undefined, [
      makeDetected({ command: 'codex', label: 'Codex CLI', path: 'C:/codex.exe' }),
    ])
    await user.click(screen.getByRole('button', { name: '重新扫描' }))
    expect(await screen.findByText('Codex CLI')).toBeInTheDocument()
    expect(queries.filter((entry) => entry.view === 'runtimes.detected')).toHaveLength(2)
  })

  it('检测失败与重新扫描失败都展示错误', async () => {
    setup({ detected: [] })
    kernel.failView('runtimes.detected', undefined, 'detect-boom')
    const user = userEvent.setup()
    render(<RuntimeManager />)

    expect(await screen.findByText('detect-boom')).toBeInTheDocument()
    kernel.failView('runtimes.detected', undefined, 'rescan-boom')
    await user.click(screen.getByRole('button', { name: '重新扫描' }))
    expect(await screen.findByText('rescan-boom')).toBeInTheDocument()
  })

  it('执行器清单读取失败：页面级错误兼容非 Error 异常（字符串）', async () => {
    setup({ detected: [] })
    const original = kernel.store.query
    kernel.store.query = <T extends ViewId>(view: T, params?: ViewParams<T>) => {
      if (view === 'runtimes.executors') return Promise.reject('executors-down')
      return original(view, params)
    }
    render(<RuntimeManager />)

    expect(await screen.findByText('executors-down')).toBeInTheDocument()
  })

  it('检测结果缺执行器键：使用后按默认执行器预填', async () => {
    setup({
      detected: [
        makeDetected({ command: 'weird', label: 'Weird CLI', executorKey: '', supported: true }),
      ],
    })
    const user = userEvent.setup()
    render(<RuntimeManager />)

    await user.click(await screen.findByRole('button', { name: '使用' }))
    expect(screen.getByLabelText('运行时名称')).toHaveValue('Weird CLI')
    expect(screen.getByLabelText('运行时命令')).toHaveValue('weird')
    expect(screen.getByRole('combobox', { name: '运行时执行器' })).toHaveTextContent(
      'DeepSeek Harness',
    )
  })

  it('检测结果「使用」预填新建表单（名称不冲突）', async () => {
    setup({
      runtimes: [makeRuntime({ name: 'ds' })],
      detected: [makeDetected({ command: 'codex', label: 'Codex CLI', path: 'C:/codex.exe' })],
    })
    const user = userEvent.setup()
    render(<RuntimeManager />)

    await user.click(await screen.findByRole('button', { name: '使用' }))

    expect(screen.getByLabelText('运行时名称')).toHaveValue('Codex CLI')
    expect(screen.getByLabelText('运行时命令')).toHaveValue('codex')
    // profile 由弹窗从执行器清单首项的 manifest 默认值预填（不再写死在 newRuntimeInput）
    await waitFor(() => expect(screen.getByLabelText('运行时 profile')).toHaveValue('multica'))
    expect(screen.getByRole('combobox', { name: '运行时执行器' })).toHaveTextContent(
      'DeepSeek Harness',
    )
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('运行时名称')).not.toBeInTheDocument()
  })

  it('检测结果「使用」带入 executorKey（支持项），提交时携带', async () => {
    setup({
      runtimes: [],
      detected: [makeDetected({ command: 'dsh', label: 'DeepSeek Harness', executorKey: 'dsh' })],
    })
    const user = userEvent.setup()
    render(<RuntimeManager />)

    await user.click(await screen.findByRole('button', { name: '使用' }))
    expect(await screen.findByRole('combobox', { name: '运行时执行器' })).toHaveTextContent(
      'DeepSeek Harness',
    )
    await waitFor(() => expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh'))
    await user.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'runtime.create',
      input: {
        executorKey: 'dsh',
        command: 'dsh',
        profile: 'multica',
        argsTemplate: '',
      },
    })
  })

  it('检测结果名称与既有运行时冲突时带命令后缀', async () => {
    setup({
      runtimes: [makeRuntime({ name: 'Codex CLI', command: 'old' })],
      detected: [makeDetected({ command: 'codex', label: 'Codex CLI', supported: true })],
    })
    const user = userEvent.setup()
    render(<RuntimeManager />)

    await user.click(await screen.findByRole('button', { name: '使用' }))
    expect(screen.getByLabelText('运行时名称')).toHaveValue('Codex CLI (codex)')
  })

  it('新建运行时：默认值提交、成功后关闭并刷新', async () => {
    setup({ runtimes: [makeRuntime()] })
    handleDispatch((command) => {
      if (command.type === 'runtime.create') {
        kernel.setView('runtimes.all', undefined, [
          makeRuntime(),
          makeRuntime({ id: 'r2', name: command.input.name }),
        ])
        return { facts: [], value: makeRuntime({ id: 'r2', name: command.input.name }) }
      }
      return { facts: [], value: null }
    })
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '新建运行时' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('新建运行时')
    // 执行器与 command/profile 由弹窗从 executors 清单首项预填
    await waitFor(() => expect(screen.getByLabelText('运行时命令')).toHaveValue('dsh'))
    await user.type(screen.getByLabelText('运行时名称'), '新的')
    await user.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'runtime.create',
      input: {
        name: '新的',
        executorKey: 'dsh',
        command: 'dsh',
        profile: 'multica',
        argsTemplate: '',
        permissionMode: 'workspace-write',
        model: null,
        reasoningEffort: null,
        workdir: null,
        maxConcurrent: 1,
        enabled: true,
      },
    })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '添加' })).not.toBeInTheDocument(),
    )
    // 视图随事实失效重取：新运行时出现在清单里
    expect(await screen.findByText('新的')).toBeInTheDocument()
  })

  it('新建失败在弹窗内展示错误并保持打开', async () => {
    setup({ runtimes: [makeRuntime()] })
    handleDispatch((command) =>
      command.type === 'runtime.create'
        ? Promise.reject(new Error('create-fail'))
        : { facts: [], value: null },
    )
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '新建运行时' }))
    await user.type(screen.getByLabelText('运行时名称'), 'x')
    await user.click(screen.getByRole('button', { name: '添加' }))

    expect(await screen.findByText('create-fail')).toBeInTheDocument()
    expect(screen.getByLabelText('运行时名称')).toBeInTheDocument()
  })

  it('编辑运行时：预填、读取模型目录、提交 update 后关闭并刷新', async () => {
    setup({
      runtimes: [makeRuntime({ name: 'ds', maxConcurrent: 3, enabled: true, workdir: 'D:/work' })],
    })
    kernel.setView('runtimes.models', { runtimeId: 'r1' }, [
      {
        id: 'deepseek/chat',
        label: 'DeepSeek Chat',
        provider: 'deepseek',
        default: true,
        thinkingLevels: ['low', 'high'],
        defaultThinkingLevel: 'low',
      },
    ])
    const queries = recordQueries()
    handleDispatch((command) => {
      if (command.type !== 'runtime.update') return { facts: [], value: null }
      const updated = makeRuntime({ ...command.patch, name: command.patch.name ?? 'ds' })
      kernel.setView('runtimes.all', undefined, [updated])
      return { facts: [], value: updated }
    })
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '编辑运行时 ds' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('编辑运行时')
    expect(queries).toContainEqual({ view: 'runtimes.models', params: { runtimeId: 'r1' } })
    expect(screen.getByLabelText('运行时名称')).toHaveValue('ds')
    expect(screen.getByLabelText('运行时工作目录')).toHaveValue('D:/work')
    expect(screen.getByLabelText('运行时并发上限')).toHaveValue(3)

    await user.clear(screen.getByLabelText('运行时名称'))
    await user.type(screen.getByLabelText('运行时名称'), 'ds2')
    await user.click(screen.getByRole('checkbox', { name: '启用运行时' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({ type: 'runtime.update', id: 'r1' })
    expect(kernel.dispatched[0]).toMatchObject({
      patch: {
        name: 'ds2',
        executorKey: 'dsh',
        argsTemplate: '',
        maxConcurrent: 3,
        enabled: false,
        workdir: 'D:/work',
      },
    })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument(),
    )
    // 视图随 runtime.updated 失效重取：清单显示新名称
    expect(await screen.findByText('ds2')).toBeInTheDocument()
  })

  it('编辑失败也在弹窗内展示错误', async () => {
    setup()
    handleDispatch((command) =>
      command.type === 'runtime.update'
        ? Promise.reject(new Error('update-fail'))
        : { facts: [], value: null },
    )
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '编辑运行时 ds' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('update-fail')).toBeInTheDocument()
    expect(screen.getByLabelText('运行时名称')).toBeInTheDocument()
  })

  it('测试成功：测试中禁用并展示新耗时，其他行状态独立', async () => {
    setup({
      runtimes: [
        makeRuntime({ id: 'r1', name: 'ds', lastProbe: null }),
        makeRuntime({ id: 'r2', name: 'claude', command: 'claude', lastProbe: null }),
      ],
      statuses: [makeStatus('r1'), makeStatus('r2')],
    })
    const slow = deferred<RuntimeProbe>()
    handleDispatch((command) => {
      if (command.type !== 'runtime.probe') return { facts: [], value: null }
      return slow.promise.then((probe) => {
        kernel.setView('runtimes.all', undefined, [
          makeRuntime({ id: 'r1', name: 'ds', lastProbe: probe }),
          makeRuntime({ id: 'r2', name: 'claude', command: 'claude', lastProbe: null }),
        ])
        return { facts: [], value: probe }
      })
    })
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '测试运行时 ds' }))
    expect(kernel.dispatched[0]).toMatchObject({ type: 'runtime.probe', id: 'r1' })
    expect(screen.getByRole('button', { name: '测试运行时 ds' })).toBeDisabled()
    expect(screen.getByText('测试中…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试运行时 claude' })).toBeEnabled()

    await act(async () => {
      slow.resolve(makeProbe({ elapsedMs: 42 }))
    })
    expect(await screen.findByText('可用 · 42ms')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试运行时 ds' })).toBeEnabled()
    expect(screen.getByText('未检测')).toBeInTheDocument()
  })

  it('测试失败（不可用）可点开详情查看原因与输出', async () => {
    setup({ runtimes: [makeRuntime({ lastProbe: null })], statuses: [makeStatus('r1')] })
    const probe = makeProbe({
      state: 'unavailable',
      elapsedMs: 8,
      error: '登录态失效',
      output: 'stderr 尾部',
      cliVersion: null,
      path: null,
    })
    handleDispatch((command) => {
      if (command.type !== 'runtime.probe') return { facts: [], value: null }
      kernel.setView('runtimes.all', undefined, [makeRuntime({ lastProbe: probe })])
      return { facts: [], value: probe }
    })
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
    expect(screen.getByText('未找到可执行文件')).toBeInTheDocument()

    await user.click(badge)
    expect(screen.queryByText('登录态失效')).not.toBeInTheDocument()
  })

  it('探测失败缺原因时详情用兜底文案', async () => {
    setup({ runtimes: [makeRuntime({ lastProbe: null })], statuses: [makeStatus('r1')] })
    const probe = makeProbe({ state: 'unavailable', error: null, output: '' })
    handleDispatch((command) => {
      if (command.type !== 'runtime.probe') return { facts: [], value: null }
      kernel.setView('runtimes.all', undefined, [makeRuntime({ lastProbe: probe })])
      return { facts: [], value: probe }
    })
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '测试运行时 ds' }))
    await user.click(await screen.findByRole('button', { name: /不可用 ·/ }))
    expect(screen.getByText('未知错误')).toBeInTheDocument()
  })

  it('探测调用抛错展示页面级错误', async () => {
    setup()
    handleDispatch((command) =>
      command.type === 'runtime.probe'
        ? Promise.reject(new Error('probe-boom'))
        : { facts: [], value: null },
    )
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '测试运行时 ds' }))
    expect(await screen.findByText('probe-boom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试运行时 ds' })).toBeEnabled()
  })

  it('删除运行时：成功刷新并清掉展开的探测详情', async () => {
    let store: Runtime[] = [
      makeRuntime({
        lastProbe: makeProbe({ state: 'unavailable', error: '坏了', output: 'tail' }),
      }),
    ]
    setup({ runtimes: store, statuses: [makeStatus('r1')] })
    handleDispatch((command) => {
      if (command.type !== 'runtime.remove') return { facts: [], value: null }
      store = []
      kernel.setView('runtimes.all', undefined, store)
      return { facts: [], value: null }
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
    let store: Runtime[] = [
      makeRuntime({
        id: 'r1',
        name: 'ds',
        lastProbe: makeProbe({ state: 'unavailable', error: '坏了', output: '' }),
      }),
      makeRuntime({ id: 'r2', name: 'claude', command: 'claude' }),
    ]
    setup({ runtimes: store, statuses: [makeStatus('r1'), makeStatus('r2')] })
    handleDispatch((command) => {
      if (command.type !== 'runtime.remove') return { facts: [], value: null }
      store = store.filter((r) => r.id !== command.id)
      kernel.setView('runtimes.all', undefined, store)
      return { facts: [], value: null }
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
    setup()
    handleDispatch((command) =>
      command.type === 'runtime.remove'
        ? Promise.reject(new Error('remove-fail'))
        : { facts: [], value: null },
    )
    const user = userEvent.setup()
    render(<RuntimeManager />)
    await screen.findByText('ds')

    await user.click(screen.getByRole('button', { name: '删除运行时 ds' }))
    expect(await screen.findByText('remove-fail')).toBeInTheDocument()
    expect(screen.getByText('ds')).toBeInTheDocument()
  })

  it('加载未完成即卸载不报错', async () => {
    setup()
    const slow = deferred<unknown>()
    const original = kernel.store.query
    kernel.store.query = <T extends ViewId>(
      view: T,
      params?: ViewParams<T>,
    ): Promise<ViewResult<T>> => {
      if (view === 'runtimes.executors') return slow.promise as Promise<ViewResult<T>>
      return original(view, params)
    }
    const { unmount } = render(<RuntimeManager />)
    unmount()
    await act(async () => {
      slow.resolve(EXECUTORS)
    })
  })

  /**
   * 首屏的定时器是「下一个宏任务才发请求」：先让它真的跑起来（查询已挂起），
   * 再卸载，之后才结算——这才走到 effect 里的 alive 守卫。
   */
  it('执行器清单在卸载后才返回：迟到的成功被丢弃，不写状态', async () => {
    setup()
    let queried = false
    let resolveLate!: (value: RuntimeExecutorChoice[]) => void
    const original = kernel.store.query
    kernel.store.query = <T extends ViewId>(
      view: T,
      params?: ViewParams<T>,
    ): Promise<ViewResult<T>> => {
      if (view === 'runtimes.executors') {
        queried = true
        return new Promise<RuntimeExecutorChoice[]>((resolve) => {
          resolveLate = resolve
        }) as Promise<ViewResult<T>>
      }
      return original(view, params)
    }
    const { container, unmount } = render(<RuntimeManager />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    unmount()
    await act(async () => {
      resolveLate(EXECUTORS)
      await Promise.resolve()
    })
    expect(queried).toBe(true)
    expect(container).toBeEmptyDOMElement()
  })

  it('执行器清单在卸载后才失败：迟到的失败被丢弃，不报错', async () => {
    setup()
    let queried = false
    let rejectLate!: (error: unknown) => void
    const original = kernel.store.query
    kernel.store.query = <T extends ViewId>(
      view: T,
      params?: ViewParams<T>,
    ): Promise<ViewResult<T>> => {
      if (view === 'runtimes.executors') {
        queried = true
        return new Promise<RuntimeExecutorChoice[]>((_resolve, reject) => {
          rejectLate = reject
        }) as Promise<ViewResult<T>>
      }
      return original(view, params)
    }
    const { container, unmount } = render(<RuntimeManager />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    unmount()
    await act(async () => {
      rejectLate(new Error('late-executors'))
      await Promise.resolve()
    })
    expect(queried).toBe(true)
    expect(container).toBeEmptyDOMElement()
  })
})
