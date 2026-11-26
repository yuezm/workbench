import { render, screen, within } from '@testing-library/react'
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

const withMode = (mode: AuthorityView['mode']): AuthorityView => ({ ...configured, mode })

describe('AuthorityPanel：来源清单的增删改', () => {
  it('删除来源：只留下别的来源，保存结果里没有它', async () => {
    const { onSave, user } = setup(configured)
    await user.click(screen.getByRole('button', { name: '删除来源 1' }))
    await user.click(screen.getByRole('button', { name: '保存准入' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mode: 'observe', sources: [] }))
  })

  it('改机器人名单 / 勾上「接收未点名」/ 改一格准入：都写进保存结果', async () => {
    const { onSave, user } = setup(configured)
    const bots = screen.getByLabelText('来源 1 的机器人名单')
    await user.clear(bots)
    await user.type(bots, 'bot-a\nbot-b')
    await user.click(screen.getByLabelText('来源 1 接收未点名消息'))
    const cell = within(screen.getByRole('tablist', { name: '来源 1 的「名单外 · 点名」准入格' }))
    await user.click(cell.getByRole('tab', { name: '明确' }))
    await user.click(screen.getByRole('button', { name: '保存准入' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            id: 'github',
            bots: ['bot-a', 'bot-b'],
            receiveAll: true,
            admission: expect.objectContaining({ unlistedAddressed: 'explicit' }),
          }),
        ],
      }),
    )
  })
})

describe('AuthorityPanel：保存失败与未就绪', () => {
  it('准入配置还没读到（view 为 null）：切到非兼容模式后保存被拦住', async () => {
    const { onSave, user } = setup(null)
    await user.click(screen.getByRole('tab', { name: '自动接单' }))
    await user.click(screen.getByRole('button', { name: '保存准入' }))
    expect(screen.getByRole('alert').textContent).toContain('准入配置还没读到')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('保存抛 Error：错误条用 message', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('后端拒绝了'))
    render(<AuthorityPanel view={configured} busy={false} onSave={onSave} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: '关闭推断' }))
    await user.click(screen.getByRole('button', { name: '保存准入' }))
    expect((await screen.findByRole('alert')).textContent).toContain('后端拒绝了')
  })

  it('保存抛非 Error：错误条退回字符串化', async () => {
    const onSave = vi.fn().mockRejectedValue('字符串故障')
    render(<AuthorityPanel view={configured} busy={false} onSave={onSave} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: '关闭推断' }))
    await user.click(screen.getByRole('button', { name: '保存准入' }))
    expect((await screen.findByRole('alert')).textContent).toContain('字符串故障')
  })
})

describe('AuthorityPanel：模式徽标与老视图缺字段', () => {
  /** 徽标在「准入」标题同一行：只在那一行里找，避免与分段控件的同名选项撞车 */
  const badge = (): HTMLElement => {
    const heading = screen.getByRole('heading', { name: '准入' })
    return within(heading.parentElement as HTMLElement).getByText(/兼容|关闭推断|只观察|自动接单/)
  }

  it.each([
    ['off', '关闭推断'],
    ['auto', '自动接单'],
  ] as const)('模式 %s 的徽标写「%s」', (mode, label) => {
    setup(withMode(mode))
    expect(badge().textContent).toBe(label)
  })

  it('视图里是枚举外的旧模式：徽标退回「兼容」，不炸面板', () => {
    setup({ ...configured, mode: 'legacy' as unknown as AuthorityView['mode'] })
    expect(badge().textContent).toBe('兼容')
  })

  it('老视图缺 assessBatch / assessWindowMs：保存按缺省 8 / 5000 补齐', async () => {
    const legacy = {
      mode: 'off',
      sources: [],
      assessorAgentId: null,
      policyVersion: 1,
    } as unknown as AuthorityView
    const onSave = vi.fn<(authority: unknown) => Promise<void>>(async () => {})
    render(<AuthorityPanel view={legacy} busy={false} onSave={onSave} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: '自动接单' }))
    await user.click(screen.getByRole('button', { name: '保存准入' }))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ assessorAgentId: null, assessBatch: 8, assessWindowMs: 5000 }),
    )
  })
})
