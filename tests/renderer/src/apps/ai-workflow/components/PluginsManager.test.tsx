import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ConfigField } from '../../../../../../src/protocol/manifest'
import type { PluginView } from '../../../../../../src/protocol/plugins'
import { PluginsManager } from '../../../../../../src/renderer/src/apps/ai-workflow/components/PluginsManager'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

/** webhook 来源插件的 config 字段：覆盖 text / number / boolean / select / secret 五种 */
const configFields: ConfigField[] = [
  { key: 'port', label: '端口', type: 'number', default: 47615 },
  { key: 'path', label: '路径', type: 'text', default: '/webhook' },
  { key: 'mode', label: '模式', type: 'select', options: ['json', 'text'], default: 'json' },
  { key: 'secure', label: '校验签名', type: 'boolean', default: true },
  { key: 'secret', label: '密钥', type: 'secret' },
]

function makePlugin(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: 'webhook',
    kind: 'source',
    name: 'webhook',
    version: '1.0.0',
    description: '接收本机 POST 事件',
    builtin: false,
    enabled: true,
    declared: ['net'],
    granted: [],
    configFields,
    config: { port: 47615, path: '/webhook', mode: 'json', secure: true },
    secretKeys: [],
    status: 'unauthorized',
    error: null,
    ...overrides,
  }
}

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

afterEach(() => {
  stopFakeKernel()
})

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  combobox: string,
  option: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: combobox }))
  await user.click(await screen.findByRole('option', { name: option }))
}

/** 从列表进入某个插件的详情页 */
async function openDetail(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: `插件 ${name} 详情` }))
}

describe('PluginsManager', () => {
  it('列表只展示概览：名称/状态/种类版本/内置标记/一行描述；能力与错误进详情', async () => {
    kernel.setView('plugins.all', undefined, [
      makePlugin(),
      makePlugin({
        id: 'remote',
        kind: 'executor',
        name: 'remote',
        version: '0.2.0',
        builtin: true,
        enabled: false,
        declared: [],
        granted: [],
        configFields: [],
        status: 'disabled',
      }),
      makePlugin({
        id: 'notify',
        kind: 'channel',
        name: 'notify',
        status: 'manifest_error',
        error: '清单缺少入口文件',
        declared: [],
        granted: [],
        configFields: [],
        description: '',
      }),
      makePlugin({
        id: 'board',
        kind: 'app',
        name: 'board',
        status: 'ready',
        builtin: true,
        declared: ['net'],
        granted: ['net'],
      }),
      makePlugin({ id: 'memo', kind: 'app', name: 'memo', status: 'error', error: '子进程崩溃' }),
      makePlugin({
        id: 'legacy',
        kind: 'app',
        name: 'legacy',
        version: '0.1.0',
        builtin: false,
        declared: [],
        granted: [],
        configFields: [
          { key: 'suffix', label: '后缀', type: 'text' },
          { key: 'variant', label: '变体', type: 'select' },
          { key: 'retry', label: '重试', type: 'number', default: 3 },
          { key: 'flag', label: '开关', type: 'boolean' },
          { key: 'token', label: '令牌', type: 'secret' },
        ],
        config: {},
        secretKeys: [],
        status: 'disabled',
        description: '',
      }),
    ])
    const user = userEvent.setup()
    render(<PluginsManager />)

    expect(await screen.findByText('webhook')).toBeInTheDocument()
    expect(screen.getByText('未授权')).toBeInTheDocument()
    expect(screen.getAllByText('外部')).toHaveLength(4)
    expect(screen.getByText('来源 · v1.0.0')).toBeInTheDocument()
    expect(await screen.findByText('remote')).toBeInTheDocument()
    expect(screen.getAllByText('已停用')).toHaveLength(2)
    expect(screen.getByText('执行器 · v0.2.0')).toBeInTheDocument()
    expect(screen.getByText('通道 · v1.0.0')).toBeInTheDocument()
    expect(screen.getByText('清单不合法')).toBeInTheDocument()
    expect(screen.getAllByText('应用 · v1.0.0')).toHaveLength(2)
    expect(screen.getAllByText('内置').length).toBeGreaterThan(0)
    expect(screen.getAllByText('可用').length).toBeGreaterThan(0)
    expect(screen.getByText('异常')).toBeInTheDocument()
    expect(screen.getAllByText('接收本机 POST 事件').length).toBeGreaterThan(0)
    expect(screen.getByText('共 6 个')).toBeInTheDocument()

    // 列表不出现详情内容：错误原因、授权勾选、config 表单、保存按钮
    expect(screen.queryByText('清单缺少入口文件')).toBeNull()
    expect(screen.queryByText('子进程崩溃')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /^保存插件/ })).toBeNull()

    // 详情里才有错误原因与声明能力；返回后回到概览列表
    await openDetail(user, 'notify')
    expect(screen.getByRole('alert')).toHaveTextContent('清单缺少入口文件')
    expect(screen.getByRole('button', { name: '返回插件列表' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '返回插件列表' }))
    expect(screen.getByText('共 6 个')).toBeInTheDocument()

    await openDetail(user, 'webhook')
    expect(screen.getByRole('checkbox', { name: 'webhook 授权 net' })).toBeInTheDocument()
    expect(screen.getByLabelText('webhook 端口')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存插件 webhook' })).toBeInTheDocument()
  })

  it('启停开关 dispatch plugin.set；失败在列表上方展示 IPC 错误', async () => {
    kernel.setView('plugins.all', undefined, [makePlugin()])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('webhook')

    const toggle = screen.getByRole('switch', { name: '启用插件 webhook' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'plugin.set',
      pluginId: 'webhook',
      enabled: false,
    })
  })

  it('启停失败：错误留在页面上，开关保持视图值', async () => {
    kernel.onDispatch(() => Promise.reject(new Error('插件不存在: webhook')))
    kernel.setView('plugins.all', undefined, [makePlugin()])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('webhook')

    await user.click(screen.getByRole('switch', { name: '启用插件 webhook' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('插件不存在: webhook')
    expect(screen.getByRole('switch', { name: '启用插件 webhook' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    // 启停失败可手动关掉
    await user.click(screen.getByRole('button', { name: '关闭错误提示' }))
    expect(screen.queryByText('插件不存在: webhook')).not.toBeInTheDocument()
  })

  it('详情里同样能启停，失败留在详情内；插件从视图消失时回到列表', async () => {
    kernel.setView('plugins.all', undefined, [makePlugin()])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('webhook')
    await openDetail(user, 'webhook')

    await user.click(screen.getByRole('switch', { name: '启用插件 webhook' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({ type: 'plugin.set', enabled: false })

    // 详情里的启停失败：错误就地展示（不回列表）
    kernel.onDispatch(() => Promise.reject(new Error('启停失败')))
    await user.click(screen.getByRole('switch', { name: '启用插件 webhook' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('启停失败')
    expect(screen.getByRole('button', { name: '保存插件 webhook' })).toBeInTheDocument()

    // 插件被移除（视图里没了）：详情自动回落到列表
    kernel.setView('plugins.all', undefined, [
      makePlugin({ id: 'other', name: 'other', description: '' }),
    ])
    expect(await screen.findByText('other')).toBeInTheDocument()
    expect(screen.getByText('共 1 个')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '返回插件列表' })).toBeNull()
  })

  it('保存：一次 dispatch 合并授权 / config / secret，secret 只写不回显', async () => {
    kernel.setView('plugins.all', undefined, [
      makePlugin({ declared: ['net', 'fs.read'], granted: ['fs.read'] }),
    ])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('webhook')
    await openDetail(user, 'webhook')

    // 授权：取消未声明的旧授权、勾选 net（只提交 declared 范围内的能力）
    await user.click(screen.getByRole('checkbox', { name: 'webhook 授权 fs.read' }))
    await user.click(screen.getByRole('checkbox', { name: 'webhook 授权 net' }))
    // config：改数字 / 文本 / 下拉 / 布尔
    await user.clear(screen.getByLabelText('webhook 端口'))
    await user.type(screen.getByLabelText('webhook 端口'), '47616')
    await user.clear(screen.getByLabelText('webhook 路径'))
    await user.type(screen.getByLabelText('webhook 路径'), '/hook')
    await choose(user, 'webhook 模式', 'text')
    await user.click(screen.getByRole('checkbox', { name: 'webhook 校验签名' }))
    // secret：输入后保存，草稿清空（先输入再清空，覆盖空值不提交的路径）
    const secret = screen.getByLabelText('webhook 密钥')
    expect(secret).toHaveAttribute('type', 'password')
    await user.type(secret, 'x')
    await user.clear(secret)
    await user.type(secret, 's3cr3t')

    await user.click(screen.getByRole('button', { name: '保存插件 webhook' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    const command = kernel.dispatched[0]
    expect(command).toMatchObject({
      type: 'plugin.set',
      pluginId: 'webhook',
      enabled: true,
      granted: ['net'],
      config: { port: 47616, path: '/hook', mode: 'text', secure: false },
      secrets: { secret: 's3cr3t' },
    })
    const config = (command as { config: Record<string, unknown> }).config
    expect(typeof config.port).toBe('number')
    expect(config.secure).toBe(false)
    expect(secret).toHaveValue('')
  })

  it('缺省值缺失的字段按 manifest default 回显；空文本不写入 config', async () => {
    kernel.setView('plugins.all', undefined, [
      makePlugin({
        id: 'legacy',
        kind: 'app',
        name: 'legacy',
        declared: [],
        granted: [],
        configFields: [
          { key: 'suffix', label: '后缀', type: 'text' },
          { key: 'variant', label: '变体', type: 'select' },
          { key: 'retry', label: '重试', type: 'number', default: 3 },
          { key: 'flag', label: '开关', type: 'boolean' },
          { key: 'token', label: '令牌', type: 'secret' },
        ],
        config: {},
        secretKeys: [],
        status: 'disabled',
      }),
    ])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('legacy')
    await openDetail(user, 'legacy')

    expect(screen.getByLabelText('legacy 后缀')).toHaveValue('')
    expect(screen.getByLabelText('legacy 重试')).toHaveValue('3')
    expect(screen.getByRole('combobox', { name: 'legacy 变体' })).toHaveTextContent('未设置')
    expect(screen.getByLabelText('legacy 开关')).not.toBeChecked()
    expect(screen.getByLabelText('legacy 令牌')).toHaveAttribute('placeholder', '未设置')

    await user.click(screen.getByRole('button', { name: '保存插件 legacy' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({ config: { retry: 3, flag: false } })
    const config = (kernel.dispatched[0] as { config: Record<string, unknown> }).config
    expect(config).not.toHaveProperty('suffix')
    expect(config).not.toHaveProperty('variant')
    expect(config).not.toHaveProperty('token')
  })

  it('已写入的 secret 显示「已设置」；留空保存不带 secrets 字段', async () => {
    kernel.setView('plugins.all', undefined, [
      makePlugin({ secretKeys: ['secret'], status: 'ready', granted: ['net'] }),
    ])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('webhook')
    await openDetail(user, 'webhook')

    expect(screen.getByText('已设置')).toBeInTheDocument()
    expect(screen.getByLabelText('webhook 密钥')).toHaveAttribute(
      'placeholder',
      '已设置，留空不修改',
    )

    await user.click(screen.getByRole('button', { name: '保存插件 webhook' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).not.toHaveProperty('secrets')
    expect(kernel.dispatched[0]).toMatchObject({ granted: ['net'] })
  })

  it('保存失败：展示 IPC 错误 message', async () => {
    // 桥接可能抛出非 Error 值：错误文案统一转成字符串
    kernel.onDispatch(() => Promise.reject('secret 存储不可用'))
    kernel.setView('plugins.all', undefined, [makePlugin()])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('webhook')
    await openDetail(user, 'webhook')

    await user.click(screen.getByRole('button', { name: '保存插件 webhook' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('secret 存储不可用')
  })

  it('数字字段填了非数字：就地报错且不提交，草稿保留', async () => {
    kernel.setView('plugins.all', undefined, [makePlugin()])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('webhook')
    await openDetail(user, 'webhook')

    const port = screen.getByLabelText('webhook 端口')
    await user.clear(port)
    await user.type(port, 'abc')
    await user.click(screen.getByRole('button', { name: '保存插件 webhook' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('必须是数字，留空用缺省值')
    expect(kernel.dispatched).toHaveLength(0)
    expect(port).toHaveValue('abc')

    // 改回合法值后红字撤掉，保存可用
    await user.clear(port)
    await user.type(port, '47616')
    expect(screen.queryByText('必须是数字，留空用缺省值')).toBeNull()
    await user.click(screen.getByRole('button', { name: '保存插件 webhook' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({ config: { port: 47616 } })
  })

  it('数字字段留空：按缺省值处理，不写空串也不报警', async () => {
    kernel.setView('plugins.all', undefined, [makePlugin()])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('webhook')
    await openDetail(user, 'webhook')

    expect(screen.getByText('只填数字；留空用缺省值')).toBeInTheDocument()
    await user.clear(screen.getByLabelText('webhook 端口'))
    await user.click(screen.getByRole('button', { name: '保存插件 webhook' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    const config = (kernel.dispatched[0] as { config: Record<string, unknown> }).config
    expect(config).not.toHaveProperty('port')
  })

  it('未授权的插件在详情里说明为什么不会启动', async () => {
    kernel.setView('plugins.all', undefined, [makePlugin()])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('webhook')
    await openDetail(user, 'webhook')

    expect(screen.getByText(/勾选声明的能力并保存后才会启动/)).toBeInTheDocument()
  })

  it('保存进行中禁用开关与保存按钮（不并发提交）', async () => {
    kernel.onDispatch(() => new Promise(() => {}))
    kernel.setView('plugins.all', undefined, [makePlugin()])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('webhook')
    await openDetail(user, 'webhook')

    await user.click(screen.getByRole('button', { name: '保存插件 webhook' }))
    expect(await screen.findByRole('switch', { name: '启用插件 webhook' })).toBeDisabled()
    // 禁用要交代原因：按钮文案自己说「正在保存」
    expect(screen.getByRole('button', { name: '保存插件 webhook' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存插件 webhook' })).toHaveTextContent('保存中…')
  })

  it('未就绪显示加载中；空清单显示空态', async () => {
    render(<PluginsManager />)
    expect(await screen.findByText('正在读取插件清单…')).toBeInTheDocument()

    kernel.setView('plugins.all', undefined, [])
    expect(await screen.findByText('未发现插件')).toBeInTheDocument()
    expect(screen.getByText('共 0 个')).toBeInTheDocument()
  })

  it('plugins.all 读取失败展示错误文案', async () => {
    kernel.failView('plugins.all', undefined, '插件视图不可用')
    render(<PluginsManager />)
    expect(await screen.findByText('插件视图不可用')).toBeInTheDocument()
  })

  it('内置插件无声明能力 / 无 config 字段：不出表单，保存提交空授权与空 config', async () => {
    kernel.setView('plugins.all', undefined, [
      makePlugin({
        id: 'ticker',
        kind: 'app',
        name: 'ticker',
        version: '2.0.0',
        builtin: true,
        enabled: true,
        declared: [],
        granted: [],
        configFields: [],
        config: {},
        status: 'ready',
        description: '',
      }),
    ])
    const user = userEvent.setup()
    render(<PluginsManager />)
    await screen.findByText('ticker')
    await openDetail(user, 'ticker')

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存插件 ticker' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'plugin.set',
      pluginId: 'ticker',
      granted: [],
      config: {},
    })
    expect(kernel.dispatched[0]).not.toHaveProperty('secrets')
  })
})
