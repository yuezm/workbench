import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LarkProfileView } from '@workbench/protocol/ipc'
import { FeishuConnectionDialog } from '@workbench/client-app-ai-workflow/components/FeishuConnectionDialog'

const profile = (over: Partial<LarkProfileView> = {}): LarkProfileView => ({
  name: 'workbench',
  appId: 'cli_w',
  brand: 'feishu',
  active: true,
  user: 'ou_1',
  tokenStatus: 'ready',
  ...over,
})

const setup = (props: {
  connection?: { label?: string; profile?: string; answerers?: string | string[] }
  profiles?: LarkProfileView[]
}) => {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  render(
    <FeishuConnectionDialog
      {...(props.connection === undefined ? {} : { connection: props.connection })}
      profiles={props.profiles ?? [profile()]}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  )
  return { onSubmit, onCancel, user: userEvent.setup() }
}

describe('FeishuConnectionDialog', () => {
  it('编辑态回显：拍板人名单是数组时拼成一行逗号分隔', () => {
    setup({ connection: { label: '工作台', answerers: ['ou_1', 'ou_2'] } })
    expect(screen.getByLabelText('飞书连接名')).toHaveValue('工作台')
    expect(screen.getByLabelText('飞书连接拍板人')).toHaveValue('ou_1, ou_2')
  })

  it('本机一个 profile 都没有：下拉占位写「没有 profile」', () => {
    setup({ profiles: [] })
    expect(screen.getByText('没有 profile')).toBeInTheDocument()
  })

  it('profile 下拉：未在用的那条不带「（在用）」后缀', async () => {
    const { user } = setup({
      profiles: [profile({ name: 'a', active: true }), profile({ name: 'b', active: false })],
    })
    await user.click(screen.getByRole('combobox', { name: '飞书 profile' }))
    const options = await screen.findAllByRole('option')
    const texts = options.map((option) => option.textContent)
    expect(texts).toContain('a（在用）')
    // 未在用的 profile 只显示名字
    expect(texts).toContain('b')
  })

  it('按 Esc 关闭弹窗：受控弹窗没有触发器，dismiss 直接收口到 onCancel', async () => {
    const { onCancel, user } = setup({ connection: { label: '工作台' } })
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
  })

  it('填连接名 + 选私聊接收人：提交带出接收人 open_id', async () => {
    const { onSubmit, user } = setup({ profiles: [profile()] })
    await user.type(screen.getByLabelText('飞书连接名'), '助手')
    await user.click(screen.getByRole('tab', { name: '私聊某人' }))
    await user.type(screen.getByLabelText('飞书连接接收人'), 'ou_9')
    await user.click(screen.getByRole('button', { name: '保存连接' }))
    expect(onSubmit).toHaveBeenCalledWith({ label: '助手', user: 'ou_9' })
  })
})
