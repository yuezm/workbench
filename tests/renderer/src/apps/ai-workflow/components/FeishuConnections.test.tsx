import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Command } from '../../../../../../src/protocol/commands'
import type { Agent } from '../../../../../../src/protocol/entities'
import type { CommandDispatchResult } from '../../../../../../src/protocol/ipc'
import type { LarkAdminAction, LarkStatusView } from '../../../../../../src/protocol/ipc'
import type { PluginView } from '../../../../../../src/protocol/plugins'
import type { ViewId, ViewParams, ViewResult } from '../../../../../../src/protocol/views'
import {
  agentLabelOf,
  answerersTextOf,
  connectionHealthOf,
  connectionLabel,
  connectionOfForm,
  connectionsOf,
  connectionTarget,
  FeishuConnections,
  statusToneOf,
  targetKindOf,
} from '../../../../../../src/renderer/src/apps/ai-workflow/components/FeishuConnections'
import { toast } from '../../../../../../src/renderer/src/components/ui/toast'
import type { WorkbenchApi } from '../../../../../../src/shared/workbench-api'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

/**
 * 成功提示走轻提示（toast），不走错误条。面板这边的职责只是「把话交出去」：
 * 真实渲染、语义与自动消失由 `components/ui/toast.test.tsx` 覆盖，这里断言文案对得上。
 */
vi.mock('../../../../../../src/renderer/src/components/ui/toast', () => ({
  toast: vi.fn(),
  ToastHost: (): null => null,
}))

const toastMock = vi.mocked(toast)

const STATUS: LarkStatusView = {
  ok: true,
  program: '/usr/local/bin/lark-cli',
  error: null,
  workspace: 'local',
  appId: 'cli_workbench',
  identity: 'bot',
  available: true,
  tokenStatus: 'ready',
  profiles: [
    {
      name: 'workbench',
      appId: 'cli_workbench',
      brand: 'feishu',
      active: true,
      user: '岳智明',
      tokenStatus: 'ready',
    },
  ],
  foreign: null,
  conflict: false,
  hint: null,
}

/** 智能体清单里的一项（面板只用到 id / name，其余字段给足形状即可） */
function agentOf(id: string, name: string): Agent {
  return {
    id,
    name,
    description: '',
    runtimeId: 'rt-1',
    systemPrompt: '',
    model: null,
    reasoningEffort: null,
    maxConcurrent: 1,
    permissionMode: 'workspace-write',
    workdir: null,
    env: {},
    createdAt: '2026-11-15T00:00:00.000Z',
  }
}

function pluginOf(overrides: Partial<PluginView> = {}): PluginView {
  return {
    id: 'feishu',
    kind: 'channel',
    name: '飞书',
    version: '1.1.0',
    description: '经本机 lark-cli 收发',
    builtin: true,
    enabled: true,
    declared: ['spawn'],
    granted: ['spawn'],
    configFields: [],
    config: {},
    secretKeys: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

let kernel: FakeKernel
type LarkMock = ReturnType<typeof vi.fn<(action: LarkAdminAction) => Promise<unknown>>>
let larkMock: LarkMock

const statusResult = (over: Partial<LarkStatusView> = {}): LarkStatusView => ({
  ...STATUS,
  ...over,
})

/** 只装本面板用到的桥接：内核三动词由 fake-kernel 提供（组件走 getKernelStore），lark 走 mock。 */
function stubBridge(): void {
  larkMock = vi.fn<(action: LarkAdminAction) => Promise<unknown>>((action) =>
    Promise.resolve(action.action === 'status' ? statusResult() : { ok: true }),
  )
  const api: WorkbenchApi = {
    dispatch: <C extends Command>(): Promise<CommandDispatchResult<C>> =>
      Promise.reject(new Error('本面板不用 dispatch')),
    query: <T extends ViewId>(_view: T, _params?: ViewParams<T>): Promise<ViewResult<T>> =>
      Promise.reject(new Error('本面板不用 query')),
    subscribe: () => () => {},
    onNotice: () => () => {},
    listDirs: () => Promise.resolve({ path: '/', parent: null, entries: [] }),
    info: () => Promise.reject(new Error('本面板不用 info')),
    lark: ((action: LarkAdminAction) => larkMock(action)) as unknown as WorkbenchApi['lark'],
    notify: () => {},
  }
  window.workbench = api
}

beforeEach(() => {
  kernel = installFakeKernel()
  stubBridge()
})

afterEach(() => {
  stopFakeKernel()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

/** 打开「管理本机应用」弹窗 */
async function openAppDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: '管理本机应用' }))
}

describe('FeishuConnections：配置解析', () => {
  it('connectionsOf：坏 JSON / 非数组 / 空值都给空列表', () => {
    expect(connectionsOf(undefined)).toEqual([])
    expect(connectionsOf('')).toEqual([])
    expect(connectionsOf('{')).toEqual([])
    expect(connectionsOf('{"a":1}')).toEqual([])
    expect(connectionsOf('[1, null, {"label":"a"}]')).toEqual([{ label: 'a' }])
  })

  it('connectionLabel：label → profile → 兜底序号', () => {
    expect(connectionLabel({ label: ' 工作台 ' }, 0)).toBe('工作台')
    expect(connectionLabel({ profile: 'wb' }, 1)).toBe('wb')
    expect(connectionLabel({}, 2)).toBe('连接 3')
  })

  it('connectionTarget：群优先，其次私聊，最后跟随登录人', () => {
    expect(connectionTarget({ chat: 'oc_1', user: 'ou_1' })).toBe('群 oc_1')
    expect(connectionTarget({ user: 'ou_1' })).toBe('私聊 ou_1')
    expect(connectionTarget({})).toBe('登录人（默认）')
  })

  it('targetKindOf：与 connectionTarget 同一优先级（群 → 私聊 → 跟随登录人）', () => {
    expect(targetKindOf({ chat: 'oc_1', user: 'ou_1' })).toBe('chat')
    expect(targetKindOf({ user: 'ou_1' })).toBe('user')
    expect(targetKindOf({ chat: '  ', user: '  ' })).toBe('current')
    expect(targetKindOf({})).toBe('current')
  })

  it('answerersTextOf：数组与字符串都归一成一行', () => {
    expect(answerersTextOf({ answerers: ['ou_1', 'ou_2'] })).toBe('ou_1, ou_2')
    expect(answerersTextOf({ answerers: 'ou_3' })).toBe('ou_3')
    expect(answerersTextOf({})).toBe('')
  })

  it('agentLabelOf：id 查名字；旧配置存名字照旧显示；认不出来原样给；没绑就是「只发不接」', () => {
    const agents = [agentOf('ag-1', '管家（Moos）'), agentOf('ag-2', '产品经理')]
    expect(agentLabelOf(agents, 'ag-2')).toBe('产品经理')
    expect(agentLabelOf(agents, '产品经理')).toBe('产品经理')
    expect(agentLabelOf(agents, 'ag-gone')).toBe('ag-gone')
    expect(agentLabelOf(agents, undefined)).toBe('只发不接')
    expect(agentLabelOf(agents, '  ')).toBe('只发不接')
  })

  it('connectionOfForm：空字段不写入；名单按分隔符归一', () => {
    const filled = connectionOfForm({
      label: ' 工作台 ',
      profile: 'wb',
      agent: ' ',
      user: '',
      chat: 'oc_1',
      answerers: 'ou_1, ou_2， ou_1',
    })
    expect(filled.label).toBe('工作台')
    expect(filled.profile).toBe('wb')
    expect(filled.chat).toBe('oc_1')
    expect(filled.agent).toBeUndefined()
    expect(filled.user).toBeUndefined()
    expect(filled.answerers).toEqual(['ou_1', 'ou_2'])
    expect(
      connectionOfForm({ label: '', profile: '', agent: '', user: '', chat: '', answerers: ' ' }),
    ).toEqual({})
  })

  it('connectionHealthOf：探测中 / 跟随当前登录 / 未登录 / profile 不在本机 / 就绪', () => {
    expect(connectionHealthOf({ profile: 'wb' }, null).text).toBe('探测中')
    expect(connectionHealthOf({}, STATUS).text).toBe('跟随当前登录')
    expect(connectionHealthOf({}, { ...STATUS, available: false }).text).toBe('未登录')
    expect(connectionHealthOf({ profile: 'gone' }, STATUS).text).toBe('本机没有这个 profile')
    expect(
      connectionHealthOf(
        { profile: 'workbench' },
        {
          ...STATUS,
          profiles: [
            {
              name: 'workbench',
              appId: 'cli',
              brand: 'feishu',
              active: false,
              user: null,
              tokenStatus: null,
            },
          ],
        },
      ).text,
    ).toBe('未登录')
    expect(connectionHealthOf({ profile: 'workbench' }, STATUS).text).toBe('就绪')
  })

  it('statusToneOf：未探测无错误 = 无色；探测失败 / 未授权 / 撞车 / 可用各一档', () => {
    expect(statusToneOf(null, null)).toBeNull()
    expect(statusToneOf(null, '找不到 lark-cli')?.text).toBe('未就绪')
    expect(statusToneOf({ ...STATUS, ok: false }, null)?.text).toBe('未就绪')
    expect(statusToneOf({ ...STATUS, conflict: true }, null)?.text).toBe('与别的 agent 撞车')
    expect(statusToneOf({ ...STATUS, available: false }, null)?.text).toBe('待登录')
    expect(statusToneOf(STATUS, null)?.text).toBe('可用')
  })
})

describe('FeishuConnections：状态卡', () => {
  it('挂载即探测本机 CLI：显示工作区 / 应用 / 身份与 profile 数量', async () => {
    render(<FeishuConnections plugin={pluginOf()} />)

    expect(await screen.findByText('cli_workbench')).toBeTruthy()
    expect(screen.getByText('local')).toBeTruthy()
    expect(screen.getByText('bot · ready')).toBeTruthy()
    expect(screen.getByText('可用')).toBeTruthy()
    expect(larkMock).toHaveBeenCalledWith({ action: 'status' })
    // 事件/回调必须先在这个应用里订阅一次（否则点击与私聊收不到）：面板直接给入口
    const link = screen.getByRole('link', { name: /打开「cli_workbench」的事件与回调/ })
    expect(link.getAttribute('href')).toBe('https://open.feishu.cn/app/cli_workbench/event')
  })

  it('探测失败：状态卡降为「未就绪」，原因由错误条播报，不炸面板', async () => {
    larkMock.mockRejectedValue(new Error('找不到 lark-cli'))
    render(<FeishuConnections plugin={pluginOf()} />)

    expect(await screen.findByText('找不到 lark-cli')).toBeTruthy()
    expect(screen.getByText('未就绪')).toBeTruthy()
  })

  it('与别的 agent 撞车：红条提示且带换应用建议', async () => {
    larkMock.mockResolvedValue(
      statusResult({
        conflict: true,
        foreign: { workspace: 'hermes', appId: 'cli_hermes' },
        hint: '工作台与别的 agent 用的是同一个飞书应用',
      }),
    )
    render(<FeishuConnections plugin={pluginOf()} />)

    expect(await screen.findByText('与别的 agent 撞车')).toBeTruthy()
    expect(screen.getByText(/hermes/)).toBeTruthy()
    expect(screen.getByText(/同一个飞书应用/)).toBeTruthy()
  })

  it('重新探测：再问一次 CLI（状态卡上的按钮）', async () => {
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await user.click(screen.getByRole('button', { name: '重新探测' }))
    await waitFor(() => {
      expect(larkMock.mock.calls.filter(([action]) => action.action === 'status').length).toBe(2)
    })
  })
})

describe('FeishuConnections：连接列表', () => {
  it('空态：没有连接时给一句话说明，主入口仍是「添加连接」', async () => {
    render(<FeishuConnections plugin={pluginOf({ config: { connections: '[]' } })} />)
    expect(await screen.findByText(/还没有连接/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '添加连接' })).toBeTruthy()
  })

  it('列出已有连接：名称 + 健康度 + profile/目标/智能体', async () => {
    render(
      <FeishuConnections
        plugin={pluginOf({
          config: {
            connections: JSON.stringify([
              { label: '工作台', profile: 'wb', user: 'ou_me', agent: '小酱' },
            ]),
          },
        })}
      />,
    )

    expect(await screen.findByText('工作台')).toBeTruthy()
    expect(screen.getByText('wb · 私聊 ou_me · 小酱')).toBeTruthy()
    // profile 不在本机：行内直接标出来，用户不用去命令行核对
    expect(screen.getByText('本机没有这个 profile')).toBeTruthy()
  })

  it('连接绑的 profile 在本机且已登录：行内标「就绪」', async () => {
    render(
      <FeishuConnections
        plugin={pluginOf({
          config: { connections: JSON.stringify([{ label: '工作台', profile: 'workbench' }]) },
        })}
      />,
    )

    expect(await screen.findByText('就绪')).toBeTruthy()
  })

  it('移除连接：把剩下的写回去', async () => {
    const user = userEvent.setup()
    render(
      <FeishuConnections
        plugin={pluginOf({
          config: {
            connections: JSON.stringify([
              { label: 'A', profile: 'a', user: 'ou_1' },
              { label: 'B', profile: 'b', user: 'ou_2' },
            ]),
          },
        })}
      />,
    )

    await user.click(await screen.findByRole('button', { name: '移除连接 A' }))
    await waitFor(() => {
      expect(kernel.dispatched).toHaveLength(1)
    })
    expect(kernel.dispatched[0]).toMatchObject({
      config: { connections: JSON.stringify([{ label: 'B', profile: 'b', user: 'ou_2' }]) },
    })
  })

  it('保存失败：把后端文案贴在面板里', async () => {
    kernel.onDispatch(() => Promise.reject(new Error('设置写不进去')))
    const user = userEvent.setup()
    render(
      <FeishuConnections
        plugin={pluginOf({
          config: { connections: JSON.stringify([{ label: 'A', profile: 'a', user: 'ou_1' }]) },
        })}
      />,
    )

    await user.click(await screen.findByRole('button', { name: '移除连接 A' }))
    expect(await screen.findByText('设置写不进去')).toBeTruthy()
  })
})

describe('FeishuConnections：连接弹窗', () => {
  it('添加连接：弹窗里填完写回 connections JSON（不碰其它字段）', async () => {
    kernel.setView('agents.all', undefined, [agentOf('ag-1', '管家（Moos）')])
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await user.click(screen.getByRole('button', { name: '添加连接' }))
    expect(screen.getByText('添加飞书连接')).toBeTruthy()

    await user.type(screen.getByLabelText('飞书连接名'), '工作台')
    await user.click(screen.getByRole('combobox', { name: '飞书 profile' }))
    await user.click(await screen.findByRole('option', { name: /workbench/ }))
    await user.click(screen.getByRole('tab', { name: '私聊某人' }))
    await user.type(screen.getByLabelText('飞书连接接收人'), 'ou_me')
    await user.click(screen.getByRole('combobox', { name: '飞书连接默认智能体' }))
    await user.click(await screen.findByRole('option', { name: '管家（Moos）' }))
    await user.click(screen.getByRole('button', { name: '保存连接' }))

    await waitFor(() => {
      expect(kernel.dispatched).toHaveLength(1)
    })
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'plugin.set',
      pluginId: 'feishu',
      enabled: true,
      config: {
        connections: JSON.stringify([
          { label: '工作台', profile: 'workbench', agent: 'ag-1', user: 'ou_me' },
        ]),
      },
    })
    // 保存成功只浮一句轻提示：不是红色错误条，也不需要人再关一次
    expect(toastMock).toHaveBeenCalledWith('已保存 1 条连接')
  })

  it('落点字段跟着分段走：跟随登录人时不渲染地址输入，切「私聊 / 群」才出现', async () => {
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await user.click(screen.getByRole('button', { name: '添加连接' }))
    // 默认跟随登录人：不要两个并排的地址格子
    expect(screen.queryByLabelText('飞书连接接收人')).toBeNull()
    expect(screen.queryByLabelText('飞书连接群')).toBeNull()
    expect(screen.getByText(/消息发到 profile 的登录人/)).toBeTruthy()

    await user.click(screen.getByRole('tab', { name: '私聊某人' }))
    expect(screen.getByLabelText('飞书连接接收人')).toBeTruthy()
    expect(screen.queryByLabelText('飞书连接群')).toBeNull()

    await user.click(screen.getByRole('tab', { name: '发到群' }))
    expect(screen.getByLabelText('飞书连接群')).toBeTruthy()
    expect(screen.queryByLabelText('飞书连接接收人')).toBeNull()
  })

  it('选了落点却没填地址：就地报错，不把消息静默发给自己', async () => {
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await user.click(screen.getByRole('button', { name: '添加连接' }))
    await user.type(screen.getByLabelText('飞书连接名'), '工作台')
    await user.click(screen.getByRole('tab', { name: '私聊某人' }))
    await user.click(screen.getByRole('button', { name: '保存连接' }))

    expect(await screen.findByText(/填接收人的 open_id/)).toBeTruthy()
    expect(kernel.dispatched).toHaveLength(0)

    await user.click(screen.getByRole('tab', { name: '发到群' }))
    await user.click(screen.getByRole('button', { name: '保存连接' }))
    expect(await screen.findByText(/填群 chat_id/)).toBeTruthy()
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('什么都没填就保存：只提示，不发命令（profile 留空本身是合法的「当前 profile」）', async () => {
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await user.click(screen.getByRole('button', { name: '添加连接' }))
    await user.click(screen.getByRole('button', { name: '保存连接' }))

    expect(await screen.findByText(/至少填连接名/)).toBeTruthy()
    expect(kernel.dispatched).toHaveLength(0)
    // 弹窗不关：填的东西与报错都还在
    expect(screen.getByLabelText('飞书连接名')).toBeTruthy()
  })

  it('只填连接名也能加：profile 留空 = 用 lark-cli 当前 profile', async () => {
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await user.click(screen.getByRole('button', { name: '添加连接' }))
    await user.type(screen.getByLabelText('飞书连接名'), '当前应用')
    await user.click(screen.getByRole('button', { name: '保存连接' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      config: { connections: JSON.stringify([{ label: '当前应用' }]) },
    })
  })

  it('编辑连接：回填现有配置，改落点后写回同一条', async () => {
    const user = userEvent.setup()
    render(
      <FeishuConnections
        plugin={pluginOf({
          config: {
            connections: JSON.stringify([
              { label: 'A', profile: 'a', chat: 'oc_1' },
              { label: 'B', profile: 'b' },
            ]),
          },
        })}
      />,
    )

    await user.click(await screen.findByRole('button', { name: '编辑连接 A' }))
    expect(screen.getByText('编辑飞书连接')).toBeTruthy()
    // 配置里的 chat 决定分段停在「发到群」，地址已回填
    expect(screen.getByRole('tab', { name: '发到群' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('飞书连接群')).toHaveValue('oc_1')
    // 绑的 profile 已不在本机时也要显示出来：下拉不能退回「没选」
    await user.click(screen.getByRole('combobox', { name: '飞书 profile' }))
    expect(await screen.findByRole('option', { name: 'a（本机没有）' })).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await user.clear(screen.getByLabelText('飞书连接群'))
    await user.type(screen.getByLabelText('飞书连接群'), 'oc_2')
    await user.click(screen.getByRole('button', { name: '保存连接' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      config: {
        connections: JSON.stringify([
          { label: 'A', profile: 'a', chat: 'oc_2' },
          { label: 'B', profile: 'b' },
        ]),
      },
    })
  })

  it('取消编辑：不发命令，弹窗关掉', async () => {
    const user = userEvent.setup()
    render(
      <FeishuConnections
        plugin={pluginOf({ config: { connections: JSON.stringify([{ label: 'A' }]) } })}
      />,
    )

    await user.click(await screen.findByRole('button', { name: '编辑连接 A' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(kernel.dispatched).toHaveLength(0)
    await waitFor(() => expect(screen.queryByText('编辑飞书连接')).toBeNull())
  })
})

describe('FeishuConnections：本机应用弹窗', () => {
  it('默认不渲染：一张 profile 表 + 行内操作，点「管理本机应用」才出现', async () => {
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    expect(screen.queryByLabelText('飞书 App ID')).toBeNull()
    expect(screen.queryByRole('button', { name: '登录 profile workbench' })).toBeNull()

    await openAppDialog(user)
    // 一台机器上有哪几个应用、各自什么状态，一屏看全
    expect(screen.getByRole('columnheader', { name: 'profile' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '应用' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '登录人' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'token' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '操作' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: /workbench/ })).toBeTruthy()
    // 登录与删除是行内操作，不再切分段
    expect(screen.getByRole('button', { name: '登录 profile workbench' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '删除 profile workbench' })).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('有 profile 时新建表单默认收起；一个都没有时直接展开', async () => {
    const user = userEvent.setup()
    const first = render(<FeishuConnections plugin={pluginOf()} />)
    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    expect(screen.queryByLabelText('飞书 App ID')).toBeNull()
    first.unmount()

    larkMock.mockImplementation((action) =>
      Promise.resolve(action.action === 'status' ? statusResult({ profiles: [] }) : { ok: true }),
    )
    render(<FeishuConnections plugin={pluginOf()} />)
    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    // 一个应用都没有：空态直接给表单，不用再点一次「新建」
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByLabelText('飞书 App ID')).toBeTruthy()
    expect(dialog.getByText(/本机还没有 profile/)).toBeTruthy()
  })

  it('新建 profile：顶部展开表单，创建后收起并重探一次', async () => {
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '新建 profile' }))
    await user.type(screen.getByLabelText('新 profile 名'), 'workbench')
    await user.type(screen.getByLabelText('飞书 App ID'), 'cli_abc')
    await user.type(screen.getByLabelText('飞书 App Secret'), 'super-secret')
    await user.click(screen.getByRole('button', { name: '创建 profile' }))

    await waitFor(() => {
      expect(larkMock).toHaveBeenCalledWith({
        action: 'add-profile',
        name: 'workbench',
        appId: 'cli_abc',
        secret: 'super-secret',
      })
    })
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith('已新建 profile「workbench」')
    })
    expect(screen.queryByLabelText('飞书 App ID')).toBeNull()
    expect(larkMock.mock.calls.filter(([action]) => action.action === 'status').length).toBe(2)
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('新建 profile 失败：原因贴在弹窗里，输入不丢', async () => {
    larkMock.mockImplementation((action) =>
      Promise.resolve(
        action.action === 'add-profile' ? { ok: false, error: 'App ID 形状不对' } : statusResult(),
      ),
    )
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '新建 profile' }))
    await user.type(screen.getByLabelText('飞书 App ID'), 'cli_bad')
    await user.click(screen.getByRole('button', { name: '创建 profile' }))
    expect(await screen.findByText('App ID 形状不对')).toBeTruthy()
    expect(screen.getByLabelText('飞书 App ID')).toHaveValue('cli_bad')
  })

  it('新建 profile 桥接抛错：同样贴出原因', async () => {
    larkMock.mockImplementation((action) =>
      action.action === 'add-profile'
        ? Promise.reject(new Error('IPC 断了'))
        : Promise.resolve(statusResult()),
    )
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '新建 profile' }))
    await user.click(screen.getByRole('button', { name: '创建 profile' }))
    expect(await screen.findByText('IPC 断了')).toBeTruthy()
  })

  it('新建表单可以取消：收起且不发命令', async () => {
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '新建 profile' }))
    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByLabelText('飞书 App ID')).toBeNull()
    expect(larkMock.mock.calls.map(([action]) => action.action)).toEqual(['status'])
  })

  it('登录：行内发起，授权指引挂在该行下面，点「我已完成授权」再轮询', async () => {
    larkMock.mockImplementation((action) => {
      if (action.action === 'login-start') {
        return Promise.resolve({
          ok: true,
          verificationUrl: 'https://accounts.feishu.cn/verify',
          deviceCode: 'dc',
        })
      }
      return Promise.resolve(action.action === 'status' ? statusResult() : { ok: true })
    })
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))
    const link = await screen.findByRole('link', { name: '打开授权页' })
    expect(link.getAttribute('href')).toBe('https://accounts.feishu.cn/verify')
    // 链接文字是短标签：设备码 URL 很长且不可换行，直接铺开会把表格撑宽、挤掉右侧操作列；
    // 完整地址仍然给得到（title + href）
    expect(link.getAttribute('title')).toBe('https://accounts.feishu.cn/verify')
    expect(screen.getByText(/给「workbench」授权/)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '我已完成授权' }))
    await waitFor(() => {
      expect(larkMock).toHaveBeenCalledWith({
        action: 'login-poll',
        deviceCode: 'dc',
        profile: 'workbench',
      })
    })
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith('登录完成')
    })
    // 授权完成：指引收起
    await waitFor(() => expect(screen.queryByRole('link')).toBeNull())
  })

  it('登录只认点的那一行：两个 profile 时请求带对应名字', async () => {
    larkMock.mockImplementation((action) => {
      if (action.action === 'status') {
        return Promise.resolve(
          statusResult({
            profiles: [
              {
                name: 'workbench',
                appId: 'cli_workbench',
                brand: 'feishu',
                active: true,
                user: '岳智明',
                tokenStatus: 'ready',
              },
              {
                name: 'other',
                appId: 'cli_other',
                brand: 'feishu',
                active: false,
                user: null,
                tokenStatus: null,
              },
            ],
          }),
        )
      }
      if (action.action === 'login-start') {
        return Promise.resolve({ ok: true, verificationUrl: 'https://v', deviceCode: 'dc2' })
      }
      return Promise.resolve({ ok: true })
    })
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    // 未登录的那一行才标红；已登录的直接显示 token 状态
    expect(screen.getAllByText('未登录')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: '登录 profile other' }))

    await waitFor(() => {
      expect(larkMock).toHaveBeenCalledWith({ action: 'login-start', profile: 'other' })
    })
    expect(await screen.findByText(/给「other」授权/)).toBeTruthy()
  })

  it('登录发起失败 / 轮询失败 / 桥接抛错：都给可读提示', async () => {
    larkMock.mockImplementation((action) =>
      Promise.resolve(
        action.action === 'login-start' ? { ok: false, error: '应用没开长连接' } : statusResult(),
      ),
    )
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))
    expect(await screen.findByText('应用没开长连接')).toBeTruthy()

    larkMock.mockRejectedValueOnce(new Error('IPC 断了'))
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))
    expect(await screen.findByText('IPC 断了')).toBeTruthy()

    larkMock
      .mockResolvedValueOnce({ ok: true, verificationUrl: 'https://v', deviceCode: 'dc' })
      .mockResolvedValueOnce({ ok: false, error: '还没完成授权' })
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))
    await screen.findByRole('link', { name: '打开授权页' })
    await user.click(screen.getByRole('button', { name: '我已完成授权' }))
    expect(await screen.findByText('还没完成授权')).toBeTruthy()
  })

  it('登录发起中：该行按钮显示「发起中…」且不能重复点', async () => {
    larkMock.mockImplementation((action) => {
      if (action.action === 'login-start') return new Promise(() => {})
      return Promise.resolve(statusResult())
    })
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))

    const button = await screen.findByRole('button', { name: '登录 profile workbench' })
    await waitFor(() => expect(button).toHaveTextContent('发起中…'))
    expect(button).toBeDisabled()
  })

  it('删除 profile：行内抬确认态，确认后才调 remove-profile 并重新探测', async () => {
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '删除 profile workbench' }))
    // 一次点击不该删掉带凭据的 profile
    expect(larkMock).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'remove-profile' }))
    expect(screen.getByRole('button', { name: '取消删除' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => {
      expect(larkMock).toHaveBeenCalledWith({ action: 'remove-profile', name: 'workbench' })
    })
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith('已删除 profile「workbench」')
    })
    expect(larkMock.mock.calls.filter(([action]) => action.action === 'status').length).toBe(2)
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('删除 profile：点「取消删除」回到未确认态，不发命令', async () => {
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '删除 profile workbench' }))
    await user.click(screen.getByRole('button', { name: '取消删除' }))

    expect(screen.getByRole('button', { name: '删除 profile workbench' })).toBeTruthy()
    expect(larkMock).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'remove-profile' }))
  })

  it('删除失败 / 桥接抛错：把原因贴在弹窗里', async () => {
    larkMock.mockImplementation((action) =>
      Promise.resolve(
        action.action === 'remove-profile'
          ? { ok: false, error: 'profile "workbench" not found' }
          : statusResult(),
      ),
    )
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '删除 profile workbench' }))
    await user.click(screen.getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('profile "workbench" not found')).toBeTruthy()

    larkMock.mockRejectedValueOnce(new Error('删除时 IPC 断了'))
    await user.click(screen.getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('删除时 IPC 断了')).toBeTruthy()
  })

  it('删除进行中：该行显示「删除中…」', async () => {
    larkMock.mockImplementation((action) => {
      if (action.action === 'remove-profile') return new Promise(() => {})
      return Promise.resolve(statusResult())
    })
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '删除 profile workbench' }))
    await user.click(screen.getByRole('button', { name: '确认删除' }))
    expect(await screen.findByRole('button', { name: '删除中…' })).toBeDisabled()
  })

  it('删掉正在登录的那一行：授权指引一起收起', async () => {
    larkMock.mockImplementation((action) => {
      if (action.action === 'login-start') {
        return Promise.resolve({ ok: true, verificationUrl: 'https://v', deviceCode: 'dc' })
      }
      return Promise.resolve(action.action === 'status' ? statusResult() : { ok: true })
    })
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))
    await screen.findByRole('link', { name: '打开授权页' })

    await user.click(screen.getByRole('button', { name: '删除 profile workbench' }))
    await user.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => {
      expect(larkMock).toHaveBeenCalledWith({ action: 'remove-profile', name: 'workbench' })
    })
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('删掉别的行不动这一行的授权指引', async () => {
    larkMock.mockImplementation((action) => {
      if (action.action === 'status') {
        return Promise.resolve(
          statusResult({
            profiles: [
              {
                name: 'workbench',
                appId: 'cli_workbench',
                brand: 'feishu',
                active: true,
                user: '岳智明',
                tokenStatus: 'ready',
              },
              {
                name: 'other',
                appId: 'cli_other',
                brand: 'feishu',
                active: false,
                user: null,
                tokenStatus: null,
              },
            ],
          }),
        )
      }
      if (action.action === 'login-start') {
        return Promise.resolve({ ok: true, verificationUrl: 'https://v', deviceCode: 'dc' })
      }
      return Promise.resolve({ ok: true })
    })
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))
    await screen.findByRole('link', { name: '打开授权页' })

    await user.click(screen.getByRole('button', { name: '删除 profile other' }))
    await user.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => {
      expect(larkMock).toHaveBeenCalledWith({ action: 'remove-profile', name: 'other' })
    })
    expect(screen.getByRole('link', { name: '打开授权页' })).toBeTruthy()
  })

  it('关闭弹窗：不残留任何一次凭据调用', async () => {
    const user = userEvent.setup()
    render(<FeishuConnections plugin={pluginOf()} />)

    await screen.findByText('cli_workbench')
    await openAppDialog(user)
    await user.click(screen.getByRole('button', { name: '新建 profile' }))
    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByLabelText('飞书 App ID')).toBeNull())

    const calls = larkMock.mock.calls.map(([action]) => action.action)
    expect(calls).toEqual(['status'])
  })
})
