import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../../../../../../src/protocol/entities'
import { ApprovalCards } from '../../../../../../src/renderer/src/apps/ai-workflow/components/ApprovalCards'
import { installFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

const card: Card = {
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '继续吗',
  text: '选一个',
  kind: 'ask',
  options: ['继续', '停止'],
  key: 'k',
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
}

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

describe('ApprovalCards', () => {
  it('任务内部完整展示：标题 / 正文 / 选项按钮', () => {
    render(<ApprovalCards cards={[card]} />)

    expect(screen.getByRole('region', { name: '待处理卡' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /待审批/ })).toBeInTheDocument()
    expect(screen.getByText('继续吗')).toBeInTheDocument()
    expect(screen.getByText('选一个')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument()
  })

  it('正文按原样换行展示（长事实清单不被截断）', () => {
    const long = '事实：裸名已被他人发布过 0.2.0\n分支：默认分支是 master'
    render(<ApprovalCards cards={[{ ...card, text: long }]} />)

    const body = screen.getByText(/裸名已被他人发布过/)
    expect(body.textContent).toBe(long)
    expect(body.className).toContain('whitespace-pre-wrap')
  })

  it('选项一行一个：每个选项独占列表项、整行可点、序号只做视觉锚点', () => {
    render(
      <ApprovalCards
        cards={[{ ...card, options: ['裸名', '换成带前缀的 scope', '先用私有 registry'] }]}
      />,
    )

    const options = screen.getByRole('list', { name: '可选项' })
    const rows = within(options).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    // 每一行只有一个按钮，且铺满整行（竖排，不并排挤在一起）
    for (const row of rows) {
      const button = within(row).getByRole('button')
      expect(button.className).toContain('w-full')
    }
    // 序号是装饰：可访问名仍是纯选项文案，不做「1 裸名」
    expect(within(options).getByRole('button', { name: '裸名' })).toBeInTheDocument()
    // 提交即生效的提醒写在选项上方
    expect(screen.getByText('点一行即提交，不能撤回')).toBeInTheDocument()
  })

  it('点选项：dispatch card.answer(cardId, index, via=ui)', async () => {
    render(<ApprovalCards cards={[card]} />)

    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({
          type: 'card.answer',
          cardId: 'card-1',
          optionIndex: 1,
          via: 'ui',
        }),
      ),
    )
  })

  it('补充说明：先写再选，随 card.answer 一起提交（M13）', async () => {
    render(<ApprovalCards cards={[card]} />)

    fireEvent.change(screen.getByRole('textbox', { name: '补充说明：继续吗' }), {
      target: { value: '  第 2 条我不同意  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({
          type: 'card.answer',
          cardId: 'card-1',
          optionIndex: 1,
          via: 'ui',
          note: '第 2 条我不同意',
        }),
      ),
    )
  })

  it('补充说明留空：card.answer 不带 note 字段（续接提示词与没有附言时一致）', async () => {
    render(<ApprovalCards cards={[card]} />)

    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect('note' in kernel.dispatched[0]!).toBe(false)
  })

  it('回答失败：显示后端文案，卡片仍保留、不崩', async () => {
    kernel.onDispatch(() => Promise.reject(new Error('卡片已回答或已关闭: card-1')))
    render(<ApprovalCards cards={[card]} />)

    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('卡片已回答或已关闭: card-1')
    expect(screen.getByText('继续吗')).toBeInTheDocument()
  })

  it('回答失败为非 Error 时按字符串展示', async () => {
    kernel.onDispatch(() => Promise.reject('回答纯文本失败'))
    render(<ApprovalCards cards={[card]} />)

    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('回答纯文本失败')
  })

  it('信息卡（options 为空）进「通知」栏：只给 × 关闭，不当待审批', () => {
    render(<ApprovalCards cards={[{ ...card, options: [], kind: 'notice' }]} />)

    expect(screen.getByRole('heading', { name: /通知/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /待审批/ })).toBeNull()
    expect(screen.getByText('继续吗')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull()
    expect(screen.getByRole('button', { name: '关闭通知：继续吗' })).toBeInTheDocument()
  })

  it('两栏并存：阻塞卡出选项、信息卡出一个 × 关闭', () => {
    render(
      <ApprovalCards
        cards={[
          card,
          {
            ...card,
            id: 'card-2',
            title: '顺带说一句',
            options: [],
            kind: 'notice',
            text: '版本不一致',
          },
        ]}
      />,
    )

    expect(screen.getByRole('heading', { name: /待审批/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /通知/ })).toBeInTheDocument()
    expect(screen.getByText('版本不一致')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭通知：顺带说一句' })).toBeInTheDocument()
  })

  it('点 × ：dispatch card.resolve', async () => {
    render(<ApprovalCards cards={[{ ...card, options: [], kind: 'notice' }]} />)

    fireEvent.click(screen.getByRole('button', { name: '关闭通知：继续吗' }))
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({ type: 'card.resolve', cardId: 'card-1' }),
      ),
    )
  })

  it('关闭失败：显示后端文案，通知仍在', async () => {
    kernel.onDispatch(() => Promise.reject(new Error('卡片不存在: card-1')))
    render(<ApprovalCards cards={[{ ...card, options: [], kind: 'notice' }]} />)

    fireEvent.click(screen.getByRole('button', { name: '关闭通知：继续吗' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('卡片不存在: card-1')
    expect(screen.getByText('继续吗')).toBeInTheDocument()
  })

  it('回答进行中：选项按钮禁用，避免重复点击', async () => {
    let resolveAnswer: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      resolveAnswer = resolve
    })
    kernel.onDispatch(() => pending as Promise<never>)
    render(<ApprovalCards cards={[card]} />)

    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '继续' })).toBeDisabled())

    resolveAnswer({ facts: [], value: null })
    await waitFor(() => expect(screen.getByRole('button', { name: '继续' })).toBeEnabled())
  })

  it('无卡：不占版面', () => {
    const { container } = render(<ApprovalCards cards={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('同文案的信息卡合并成一行：带 ×N，点一次 × 整组关闭', async () => {
    const notice = { ...card, options: [], kind: 'notice' as const, text: '依赖已安装' }
    render(
      <ApprovalCards
        cards={[
          notice,
          { ...notice, id: 'card-2' },
          { ...notice, id: 'card-3' },
          { ...notice, id: 'card-4', text: '另一句知会' },
        ]}
      />,
    )

    const notices = screen.getByRole('region', { name: '通知' })
    // 三张同文案 + 一张不同文案 = 两行
    expect(within(notices).getAllByRole('listitem')).toHaveLength(2)
    expect(within(notices).getByText('×3')).toBeInTheDocument()
    expect(within(notices).getAllByRole('button', { name: /^关闭通知：/ })).toHaveLength(2)

    fireEvent.click(
      within(notices).getAllByRole('button', { name: /^关闭通知：/ })[0] as HTMLElement,
    )
    await waitFor(() =>
      expect(kernel.dispatched.filter((command) => command.type === 'card.resolve')).toHaveLength(
        3,
      ),
    )
  })

  it('ask 永不合并：同标题同选项的两张卡各占一条', () => {
    render(<ApprovalCards cards={[card, { ...card, id: 'card-2' }]} />)

    const pending = screen.getByRole('region', { name: '待审批' })
    expect(within(pending).getAllByRole('button', { name: '继续' })).toHaveLength(2)
    expect(within(pending).getAllByText('继续吗')).toHaveLength(2)
    expect(screen.queryByText(/^×/)).toBeNull()
  })

  it('信息卡与待审批卡样式分开：通知只留一个 ×（带 aria-label），待审批没有关闭按钮', () => {
    const notice = { ...card, id: 'card-2', options: [], kind: 'notice' as const, title: '知会' }
    render(<ApprovalCards cards={[card, notice]} />)

    const notices = screen.getByRole('region', { name: '通知' })
    expect(within(notices).getAllByRole('button')).toHaveLength(1)
    expect(within(notices).getByRole('button', { name: '关闭通知：知会' })).toBeInTheDocument()
    expect(within(notices).queryByRole('button', { name: '知道了' })).toBeNull()
    expect(screen.queryByRole('button', { name: '关闭通知：继续吗' })).toBeNull()
  })

  it('缺 kind 的老数据：无选项按信息卡归到通知栏，有选项仍进待审批', () => {
    const legacyNotice = { ...card, id: 'card-2', options: [] } as { kind?: string }
    delete legacyNotice.kind
    const legacyAsk = { ...card, id: 'card-3' } as { kind?: string }
    delete legacyAsk.kind

    render(<ApprovalCards cards={[legacyNotice as never, legacyAsk as never]} />)

    const notices = screen.getByRole('region', { name: '通知' })
    const pending = screen.getByRole('region', { name: '待审批' })
    expect(within(notices).getByRole('button', { name: '关闭通知：继续吗' })).toBeInTheDocument()
    expect(within(pending).getByRole('button', { name: '继续' })).toBeInTheDocument()
  })
})
