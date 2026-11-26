import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LarkAdminAction, LarkProfileView } from '@workbench/protocol/ipc'
import type { WorkbenchApi } from '@workbench/contract-api'
import { FeishuAppDialog } from '@workbench/client-app-ai-workflow/components/FeishuAppDialog'

/**
 * 本机飞书应用管理弹窗：一张 profile 表 + 新建 / 登录 / 删除。
 *
 * 缺口集中在「lark-cli 只回 ok:false 不给原因」与「设备码没回来」这两条失败路径——
 * 真实环境里 CLI 报半截结果很常见，弹窗必须给出可读文案而不是空白。
 */
const originalBridge = window.workbench

let larkMock: ReturnType<typeof vi.fn<(action: LarkAdminAction) => Promise<unknown>>>

const profile = (over: Partial<LarkProfileView> = {}): LarkProfileView => ({
  name: 'workbench',
  appId: 'cli_w',
  brand: 'feishu',
  active: true,
  user: 'ou_1',
  tokenStatus: 'ready',
  ...over,
})

function stubLark(impl: (action: LarkAdminAction) => Promise<unknown>): void {
  larkMock = vi.fn(impl)
  window.workbench = {
    lark: ((action: LarkAdminAction) => larkMock(action)) as unknown as WorkbenchApi['lark'],
  } as unknown as WorkbenchApi
}

const setup = (profiles: LarkProfileView[]) => {
  const onChanged = vi.fn()
  const onClose = vi.fn()
  render(<FeishuAppDialog profiles={profiles} onChanged={onChanged} onClose={onClose} />)
  return { onChanged, onClose, user: userEvent.setup() }
}

beforeEach(() => {
  stubLark(() => Promise.resolve({ ok: true }))
})

afterEach(() => {
  vi.restoreAllMocks()
  window.workbench = originalBridge
})

describe('FeishuAppDialog', () => {
  it('profile 没报 appId：应用一格写「—」而不是空白', () => {
    setup([profile({ appId: '' })])
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('新建 profile 只回 ok:false（没有原因）：给兜底文案', async () => {
    stubLark(() => Promise.resolve({ ok: false }))
    const { user } = setup([profile()])
    await user.click(screen.getByRole('button', { name: '新建 profile' }))
    await user.click(screen.getByRole('button', { name: '创建 profile' }))
    expect(await screen.findByText('新建 profile 失败')).toBeInTheDocument()
  })

  it('发起登录只回 ok:false（没有原因）：给兜底文案', async () => {
    stubLark(() => Promise.resolve({ ok: false }))
    const { user } = setup([profile()])
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))
    expect(await screen.findByText('发起登录失败')).toBeInTheDocument()
  })

  it('设备码没回来（只有授权链接）：点「我已完成授权」直接收口，不发轮询', async () => {
    stubLark((action) =>
      Promise.resolve(
        action.action === 'login-start'
          ? { ok: true, verificationUrl: 'https://open/x' }
          : { ok: true },
      ),
    )
    const { user } = setup([profile()])
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))
    const done = await screen.findByRole('button', { name: '我已完成授权' })
    await user.click(done)
    // 没有 deviceCode 就没有轮询调用
    expect(larkMock.mock.calls.map(([a]) => a.action)).not.toContain('login-poll')
  })

  it('轮询授权只回 ok:false（没有原因）：提示稍后再点', async () => {
    stubLark((action) => {
      if (action.action === 'login-start')
        return Promise.resolve({ ok: true, verificationUrl: 'https://open/x', deviceCode: 'dc1' })
      return Promise.resolve({ ok: false })
    })
    const { user } = setup([profile()])
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))
    await user.click(await screen.findByRole('button', { name: '我已完成授权' }))
    expect(await screen.findByText('还没完成授权，稍后再点一次')).toBeInTheDocument()
  })

  it('轮询被非 Error 拒绝：原因字符串化后展示', async () => {
    stubLark((action) => {
      if (action.action === 'login-start')
        return Promise.resolve({ ok: true, verificationUrl: 'https://open/x', deviceCode: 'dc1' })
      return Promise.reject('网络断了')
    })
    const { user } = setup([profile()])
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))
    await user.click(await screen.findByRole('button', { name: '我已完成授权' }))
    expect(await screen.findByText('网络断了')).toBeInTheDocument()
  })

  it('删除 profile 只回 ok:false（没有原因）：给兜底文案', async () => {
    stubLark(() => Promise.resolve({ ok: false }))
    const { user } = setup([profile()])
    await user.click(screen.getByRole('button', { name: '删除 profile workbench' }))
    await user.click(screen.getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText('删除 profile 失败')).toBeInTheDocument()
  })

  it('错误条可手动关掉', async () => {
    stubLark(() => Promise.resolve({ ok: false }))
    const { user } = setup([profile()])
    await user.click(screen.getByRole('button', { name: '登录 profile workbench' }))
    await screen.findByText('发起登录失败')
    await user.click(screen.getByRole('button', { name: '关闭错误提示' }))
    await waitFor(() => expect(screen.queryByText('发起登录失败')).toBeNull())
  })
})
