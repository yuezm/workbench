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

  it('信息卡（options 为空）进「通知」栏：只给「知道了」，不当待审批', () => {
    render(<ApprovalCards cards={[{ ...card, options: [], kind: 'notice' }]} />)

    expect(screen.getByRole('heading', { name: /通知/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /待审批/ })).toBeNull()
    expect(screen.getByText('继续吗')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull()
    expect(screen.getByRole('button', { name: '知道了' })).toBeInTheDocument()
  })

  it('两栏并存：阻塞卡出选项、信息卡出「知道了」', () => {
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
    expect(screen.getByRole('button', { name: '知道了' })).toBeInTheDocument()
  })

  it('点「知道了」：dispatch card.resolve', async () => {
    render(<ApprovalCards cards={[{ ...card, options: [], kind: 'notice' }]} />)

    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({ type: 'card.resolve', cardId: 'card-1' }),
      ),
    )
  })

  it('关闭失败：显示后端文案，通知仍在', async () => {
    kernel.onDispatch(() => Promise.reject(new Error('卡片不存在: card-1')))
    render(<ApprovalCards cards={[{ ...card, options: [], kind: 'notice' }]} />)

    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
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
})
