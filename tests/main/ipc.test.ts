// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotifyPayload } from '../../src/shared/workbench-api'
import { NOTIFY_CHANNEL } from '../../src/shared/workbench-api'
import {
  WORKBENCH_DISPATCH_CHANNEL,
  WORKBENCH_PICK_FOLDER_CHANNEL,
  WORKBENCH_QUERY_CHANNEL,
} from '../../src/protocol/ipc'
import { StoreError } from '../../src/host/store/index'

const { ipcMainMock, notificationMock, showMock, dialogMock, windowMock } = vi.hoisted(() => {
  const showMock = vi.fn()
  // 需可被 new：用普通函数而非箭头函数
  const notificationMock = vi.fn(function mockNotification() {
    return { show: showMock }
  })
  const dialogMock = { showOpenDialog: vi.fn() }
  // 测试里没有真实窗口：fromWebContents 返回 null，走无父窗口的分支
  const windowMock = { fromWebContents: vi.fn((_sender: unknown): unknown => null) }
  return { ipcMainMock: { handle: vi.fn() }, notificationMock, showMock, dialogMock, windowMock }
})

vi.mock('electron', () => ({
  ipcMain: ipcMainMock,
  Notification: notificationMock,
  dialog: dialogMock,
  BrowserWindow: windowMock,
}))

import { ipcMain } from 'electron'
import { registerIpcHandlers } from '../../src/main/ipc'
import type { CommandRouter } from '../../src/host/commands'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const router: CommandRouter = {
  dispatch: vi.fn(async () => ({ facts: [], value: null })),
  query: vi.fn(async () => []),
}

function handlerFor(channel: string): Handler {
  const calls = vi.mocked(ipcMain.handle).mock.calls.filter(([name]) => name === channel)
  expect(calls).toHaveLength(1)
  return calls[0][1] as Handler
}

describe('main 进程 IPC（M5 三动词 + 通知）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerIpcHandlers({ router })
  })

  it('只在固定通道注册：notify + dispatch + query（subscribe 是单向推送，无 handler）', () => {
    const channels = vi
      .mocked(ipcMain.handle)
      .mock.calls.map(([name]) => name)
      .sort()
    expect(channels).toEqual(
      [NOTIFY_CHANNEL, WORKBENCH_DISPATCH_CHANNEL, WORKBENCH_QUERY_CHANNEL, WORKBENCH_PICK_FOLDER_CHANNEL].sort(),
    )
  })

  it('notify：payload 完整透传给系统通知并展示；body 缺省时透传 undefined', () => {
    const handler = handlerFor(NOTIFY_CHANNEL)
    handler({}, { title: '番茄时钟', body: '已进入短休息（5 分钟）' })
    expect(notificationMock).toHaveBeenCalledWith({
      title: '番茄时钟',
      body: '已进入短休息（5 分钟）',
    })
    expect(showMock).toHaveBeenCalledTimes(1)

    expect(() => handler({}, { title: '仅标题' } satisfies NotifyPayload)).not.toThrow()
    expect(notificationMock).toHaveBeenCalledWith({ title: '仅标题', body: undefined })
  })

  it('dispatch：成功包成 {ok:true,value}；命令原样交给路由', async () => {
    vi.mocked(router.dispatch).mockResolvedValueOnce({
      facts: [{ seq: 1, type: 'task.created', at: 't' }],
      value: { id: 't-1' },
    })
    const response = await handlerFor(WORKBENCH_DISPATCH_CHANNEL)(
      {},
      {
        commandId: 'c-1',
        type: 'task.create',
        input: { title: 't', workflowId: 'wf-1' },
      },
    )
    expect(response).toEqual({
      ok: true,
      value: { facts: [{ seq: 1, type: 'task.created', at: 't' }], value: { id: 't-1' } },
    })
    expect(router.dispatch).toHaveBeenCalledWith({
      commandId: 'c-1',
      type: 'task.create',
      input: { title: 't', workflowId: 'wf-1' },
    })
  })

  it('dispatch：StoreError 转 {ok:false,error:{code,message}}，不外泄异常栈', async () => {
    vi.mocked(router.dispatch).mockRejectedValueOnce(new StoreError('conflict', '该对话正在执行中'))
    expect(await handlerFor(WORKBENCH_DISPATCH_CHANNEL)({}, {})).toEqual({
      ok: false,
      error: { code: 'conflict', message: '该对话正在执行中' },
    })
  })

  it('dispatch：非 StoreError 归 internal，message 保留', async () => {
    vi.mocked(router.dispatch).mockRejectedValueOnce(new Error('执行器插件未注册: x'))
    expect(await handlerFor(WORKBENCH_DISPATCH_CHANNEL)({}, {})).toEqual({
      ok: false,
      error: { code: 'internal', message: '执行器插件未注册: x' },
    })
  })

  it('dispatch：非 Error 拒绝按 String 归一 message（不丢原因、不抛）', async () => {
    vi.mocked(router.dispatch).mockRejectedValueOnce('执行器插件未注册: x')
    expect(await handlerFor(WORKBENCH_DISPATCH_CHANNEL)({}, {})).toEqual({
      ok: false,
      error: { code: 'internal', message: '执行器插件未注册: x' },
    })
  })

  it('query：view 与 params 原样传给路由，成功同样包信封', async () => {
    vi.mocked(router.query).mockResolvedValueOnce([{ id: 'wf-1' }])
    const response = await handlerFor(WORKBENCH_QUERY_CHANNEL)({}, 'tasks.byWorkflow', {
      workflowId: 'wf-1',
    })
    expect(response).toEqual({ ok: true, value: [{ id: 'wf-1' }] })
    expect(router.query).toHaveBeenCalledWith('tasks.byWorkflow', { workflowId: 'wf-1' })
  })

  it('query：未知视图的拒绝也包成错误信封', async () => {
    vi.mocked(router.query).mockRejectedValueOnce(new StoreError('invalid_input', '未知视图: x'))
    expect(await handlerFor(WORKBENCH_QUERY_CHANNEL)({}, 'x')).toEqual({
      ok: false,
      error: { code: 'invalid_input', message: '未知视图: x' },
    })
  })
  it('pickFolder：系统文件夹选择器；取消返回 null，选中返回绝对路径', async () => {
    const handler = handlerFor(WORKBENCH_PICK_FOLDER_CHANNEL)

    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await handler({ sender: {} })).toEqual({ ok: true, value: null })

    dialogMock.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:/codes/workbench'],
    })
    expect(await handler({ sender: {} })).toEqual({ ok: true, value: 'D:/codes/workbench' })
    // 没有父窗口时按 options 调用（不传父窗口）
    expect(dialogMock.showOpenDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }),
    )
  })

  it('pickFolder：有父窗口时挂在窗口上弹框（模态）', async () => {
    const parent = { id: 'win-1' }
    windowMock.fromWebContents.mockReturnValueOnce(parent)
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['D:/x'] })

    expect(await handlerFor(WORKBENCH_PICK_FOLDER_CHANNEL)({ sender: {} })).toEqual({
      ok: true,
      value: 'D:/x',
    })
    expect(dialogMock.showOpenDialog).toHaveBeenLastCalledWith(
      parent,
      expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }),
    )
  })

  it('pickFolder：对话框抛错包成 internal 错误信封', async () => {
    dialogMock.showOpenDialog.mockRejectedValueOnce(new Error('对话框不可用'))
    expect(await handlerFor(WORKBENCH_PICK_FOLDER_CHANNEL)({ sender: {} })).toEqual({
      ok: false,
      error: { code: 'internal', message: '对话框不可用' },
    })
  })
})