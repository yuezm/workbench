import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AuthorityView } from '@workbench/protocol/views'
import { AuthorityPanel } from '@workbench/client-app-ai-workflow/components/AuthorityPanel'

const compat: AuthorityView = {
  mode: 'compat',
  sources: [],
  assessorAgentId: null,
  assessBatch: 8,
  assessWindowMs: 5000,
  policyVersion: 3,
}

const configured: AuthorityView = {
  mode: 'observe',
  sources: [
    {
      id: 'github',
      allowed: ['octocat'],
      bots: ['dependabot[bot]'],
      receiveAll: false,
      admission: {
        listedAddressed: 'explicit',
        listedUnaddressed: 'inferred',
        unlistedAddressed: 'ignore',
        unlistedUnaddressed: 'ignore',
        botAddressed: 'inferred',
      },
    },
  ],
  assessorAgentId: null,
  assessBatch: 8,
  assessWindowMs: 5000,
  policyVersion: 7,
}

const setup = (view: AuthorityView | null) => {
  const onSave = vi.fn<(authority: unknown) => Promise<void>>(async () => {})
  render(<AuthorityPanel view={view} busy={false} onSave={onSave} />)
  return { onSave, user: userEvent.setup() }
}

describe('AuthorityPanel', () => {
  it('兼容模式：报「兼容」与策略版本，无改动时保存不可点', () => {
    setup(compat)
    expect(screen.getByRole('tab', { name: '兼容', selected: true })).toBeTruthy()
    expect(screen.getByText('策略 v3')).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存准入' })).toHaveProperty('disabled', true)
  })

  it('切到「关闭推断」：给出来源空态说明，保存发 authority 对象', async () => {
    const { onSave, user } = setup(compat)
    await user.click(screen.getByRole('tab', { name: '关闭推断' }))
    expect(screen.getByText(/还没有来源策略/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '保存准入' }))
    expect(onSave).toHaveBeenCalledWith({
      mode: 'off',
      sources: [],
      assessorAgentId: null,
      assessBatch: 8,
      assessWindowMs: 5000,
    })
  })

  it('有配置时回显来源与名单，且未改动不可保存', () => {
    setup(configured)
    expect(screen.getByLabelText('来源 1 的 id')).toHaveProperty('value', 'github')
    expect(screen.getByLabelText('来源 1 的允许名单')).toHaveProperty('value', 'octocat')
    expect(screen.getByLabelText('来源 1 的机器人名单')).toHaveProperty('value', 'dependabot[bot]')
    expect(screen.getByRole('tab', { name: '只观察', selected: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存准入' })).toHaveProperty('disabled', true)
  })

  it('新增来源不填 id：就地报错且不调用保存', async () => {
    const { onSave, user } = setup(configured)
    await user.click(screen.getByRole('button', { name: '添加来源' }))
    await user.click(screen.getByRole('button', { name: '保存准入' }))
    expect(screen.getByRole('alert').textContent).toContain('来源 id')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('逗号与换行混合的名单拆成数组、空项丢弃', async () => {
    const { onSave, user } = setup(configured)
    await user.click(screen.getByRole('button', { name: '添加来源' }))
    await user.type(screen.getByLabelText('来源 2 的 id'), 'feishu')
    await user.type(screen.getByLabelText('来源 2 的允许名单'), 'ou_1, ou_2\n ou_3 \n')
    await user.click(screen.getByRole('button', { name: '保存准入' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'observe',
        sources: [
          expect.objectContaining({ id: 'github' }),
          expect.objectContaining({ id: 'feishu', allowed: ['ou_1', 'ou_2', 'ou_3'] }),
        ],
      }),
    )
  })

  it('来源 id 重复：报错并不保存', async () => {
    const { onSave, user } = setup(configured)
    await user.click(screen.getByRole('button', { name: '添加来源' }))
    await user.type(screen.getByLabelText('来源 2 的 id'), 'github')
    await user.click(screen.getByRole('button', { name: '保存准入' }))
    expect(screen.getByRole('alert').textContent).toContain('不能重复')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('切回兼容并保存：显式发 null（清除），不是「没改」', async () => {
    const { onSave, user } = setup(configured)
    await user.click(screen.getByRole('tab', { name: '兼容' }))
    await user.click(screen.getByRole('button', { name: '保存准入' }))
    expect(onSave).toHaveBeenCalledWith(null)
  })
})
