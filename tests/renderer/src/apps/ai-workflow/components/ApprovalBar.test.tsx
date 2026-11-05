import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../../../../../src/shared/ai-workflow-api'
import { ApprovalBar } from '../../../../../../src/renderer/src/apps/ai-workflow/components/ApprovalBar'

const card: Card = {
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '继续吗',
  text: '选一个',
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

interface FakeApi {
  cards: {
    open: ReturnType<typeof vi.fn>
    answer: ReturnType<typeof vi.fn>
  }
  onChanged: ReturnType<typeof vi.fn>
}

/** 只注入 ApprovalBar 真正用到的两个卡片方法与 onChanged。 */
function install(options: {
  open: () => Promise<Card[]>
  answer: (cardId: string, optionIndex: number) => Promise<unknown>
}): FakeApi {
  const api: FakeApi = {
    cards: {
      open: vi.fn(options.open),
      answer: vi.fn(options.answer),
    },
    onChanged: vi.fn(() => () => {}),
  }
  ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = api
  return api
}

beforeEach(() => {
  delete (window as unknown as { aiWorkflow?: unknown }).aiWorkflow
})

describe('ApprovalBar', () => {
  it('有 open 卡：渲染标题 / 正文摘要 / 选项按钮', async () => {
    install({ open: async () => [card], answer: async () => card })
    render(<ApprovalBar />)

    expect(await screen.findByRole('region', { name: '待审批' })).toBeInTheDocument()
    expect(screen.getByText('继续吗')).toBeInTheDocument()
    expect(screen.getByText('选一个')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument()
  })

  it('点击选项：调 cards.answer(cardId, index)，重拉后卡片消失', async () => {
    let open: Card[] = [card]
    const api = install({
      open: async () => open,
      answer: async () => {
        open = []
        return card
      },
    })
    render(<ApprovalBar />)

    fireEvent.click(await screen.findByRole('button', { name: '停止' }))
    await waitFor(() => expect(api.cards.answer).toHaveBeenCalledWith('card-1', 1))
    await waitFor(() => expect(screen.queryByText('继续吗')).not.toBeInTheDocument())
  })

  it('回答失败：显示后端文案，卡片仍保留、不崩', async () => {
    install({
      open: async () => [card],
      answer: async () => {
        throw new Error('卡片已回答或已关闭: card-1')
      },
    })
    render(<ApprovalBar />)

    fireEvent.click(await screen.findByRole('button', { name: '继续' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('卡片已回答或已关闭: card-1')
    expect(screen.getByText('继续吗')).toBeInTheDocument()
  })

  it('信息卡（options 为空 / 无正文）：只展示标题，不渲染选项按钮', async () => {
    install({
      open: async () => [{ ...card, options: [], text: '' }],
      answer: async () => card,
    })
    render(<ApprovalBar />)

    expect(await screen.findByText('继续吗')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('回答进行中：选项按钮禁用，避免重复点击', async () => {
    let resolveAnswer: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      resolveAnswer = resolve
    })
    install({
      open: async () => [card],
      answer: () => pending,
    })
    render(<ApprovalBar />)

    fireEvent.click(await screen.findByRole('button', { name: '继续' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '继续' })).toBeDisabled())

    resolveAnswer(card)
    await waitFor(() => expect(screen.getByRole('button', { name: '继续' })).toBeEnabled())
  })

  it('无 open 卡：渲染 null', async () => {
    const api = install({ open: async () => [], answer: async () => undefined })
    const { container } = render(<ApprovalBar />)

    await waitFor(() => expect(api.cards.open).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('重拉失败（changed 触发的刷新）：保留卡片并展示后端文案', async () => {
    const api = install({ open: async () => [card], answer: async () => card })
    render(<ApprovalBar />)
    expect(await screen.findByText('继续吗')).toBeInTheDocument()

    // 非 Error 值也要有文案（errMsg 走 String 兜底）
    api.cards.open.mockRejectedValueOnce('重拉失败')
    act(() => {
      ;(api.onChanged.mock.calls[0][0] as () => void)()
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('重拉失败')
    expect(screen.getByText('继续吗')).toBeInTheDocument()
  })

  it('初次加载失败：不渲染、不崩（错误只在有卡可答时才有展示语境）', async () => {
    const api = install({
      open: async () => {
        throw new Error('读取待审批失败')
      },
      answer: async () => card,
    })
    const { container } = render(<ApprovalBar />)

    await waitFor(() => expect(api.cards.open).toHaveBeenCalledTimes(1))
    expect(container).toBeEmptyDOMElement()
  })

  it('卸载后才返回的失败：不更新已卸载组件', async () => {
    let rejectOpen: (reason: unknown) => void = () => {}
    const api = install({
      open: () =>
        new Promise<Card[]>((_resolve, reject) => {
          rejectOpen = reject
        }),
      answer: async () => card,
    })
    const { container, unmount } = render(<ApprovalBar />)
    await waitFor(() => expect(api.cards.open).toHaveBeenCalledTimes(1))

    unmount()
    rejectOpen(new Error('晚到的失败'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 组件已卸载：没有状态更新、没有报错边界触发
    expect(container).toBeEmptyDOMElement()
  })
})
