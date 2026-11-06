import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Card } from '../../../../../../src/protocol/entities'
import { ApprovalBar } from '../../../../../../src/renderer/src/apps/ai-workflow/components/ApprovalBar'
import { installFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

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

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

describe('ApprovalBar', () => {
  it('有 open 卡：渲染标题 / 正文摘要 / 选项按钮', async () => {
    kernel.setView('cards.open', undefined, [card])
    render(<ApprovalBar />)

    expect(await screen.findByRole('region', { name: '待审批' })).toBeInTheDocument()
    expect(screen.getByText('继续吗')).toBeInTheDocument()
    expect(screen.getByText('选一个')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止' })).toBeInTheDocument()
  })

  it('点击选项：dispatch card.answer(cardId, index)，卡片随视图刷新消失', async () => {
    kernel.setView('cards.open', undefined, [card])
    kernel.onDispatch((command) => {
      if (command.type === 'card.answer') kernel.setView('cards.open', undefined, [])
      return { facts: [], value: null }
    })
    render(<ApprovalBar />)

    fireEvent.click(await screen.findByRole('button', { name: '停止' }))
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
    await waitFor(() => expect(screen.queryByText('继续吗')).not.toBeInTheDocument())
  })

  it('回答失败：显示后端文案，卡片仍保留、不崩', async () => {
    kernel.setView('cards.open', undefined, [card])
    kernel.onDispatch(() => Promise.reject(new Error('卡片已回答或已关闭: card-1')))
    render(<ApprovalBar />)

    fireEvent.click(await screen.findByRole('button', { name: '继续' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('卡片已回答或已关闭: card-1')
    expect(screen.getByText('继续吗')).toBeInTheDocument()
  })

  it('回答失败为非 Error 时按字符串展示', async () => {
    kernel.setView('cards.open', undefined, [card])
    kernel.onDispatch(() => Promise.reject('回答纯文本失败'))
    render(<ApprovalBar />)

    fireEvent.click(await screen.findByRole('button', { name: '继续' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('回答纯文本失败')
    expect(screen.getByText('继续吗')).toBeInTheDocument()
  })

  it('信息卡（options 为空 / 无正文）：只展示标题，不渲染选项按钮', async () => {
    kernel.setView('cards.open', undefined, [{ ...card, options: [], text: '' }])
    render(<ApprovalBar />)

    expect(await screen.findByText('继续吗')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('回答进行中：选项按钮禁用，避免重复点击', async () => {
    kernel.setView('cards.open', undefined, [card])
    let resolveAnswer: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      resolveAnswer = resolve
    })
    kernel.onDispatch(() => pending as Promise<never>)
    render(<ApprovalBar />)

    fireEvent.click(await screen.findByRole('button', { name: '继续' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '继续' })).toBeDisabled())

    resolveAnswer({ facts: [], value: null })
    await waitFor(() => expect(screen.getByRole('button', { name: '继续' })).toBeEnabled())
  })

  it('无 open 卡：渲染 null', async () => {
    kernel.setView('cards.open', undefined, [])
    const { container } = render(<ApprovalBar />)

    await waitFor(() => expect(screen.queryByRole('region', { name: '待审批' })).toBeNull())
    expect(container).toBeEmptyDOMElement()
  })

  it('重拉失败（事实触发的刷新）：保留卡片并展示后端文案', async () => {
    kernel.setView('cards.open', undefined, [card])
    render(<ApprovalBar />)
    expect(await screen.findByText('继续吗')).toBeInTheDocument()

    kernel.failView('cards.open', undefined, '重拉失败')
    expect(await screen.findByRole('alert')).toHaveTextContent('重拉失败')
    expect(screen.getByText('继续吗')).toBeInTheDocument()
  })

  it('初次加载失败：不渲染、不崩（错误只在有卡可答时才有展示语境）', async () => {
    kernel.failView('cards.open', undefined, '读取待审批失败')
    const { container } = render(<ApprovalBar />)

    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByRole('region', { name: '待审批' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(container).toBeEmptyDOMElement()
  })

  it('查询失败恢复后按最新卡片渲染，错误文案消失', async () => {
    kernel.failView('cards.open', undefined, '读取待审批失败')
    const { container } = render(<ApprovalBar />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(container).toBeEmptyDOMElement()

    kernel.setView('cards.open', undefined, [card])
    await act(async () => {
      await Promise.resolve()
    })
    kernel.clearFailure('cards.open', undefined)
    expect(await screen.findByText('继续吗')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
