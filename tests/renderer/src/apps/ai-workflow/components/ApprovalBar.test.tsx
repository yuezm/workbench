import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Card } from '../../../../../../src/protocol/entities'
import { ApprovalBar } from '../../../../../../src/renderer/src/apps/ai-workflow/components/ApprovalBar'

const card: Card = {
  id: 'card-1',
  runId: 'run-1',
  taskId: 't-1',
  conversationId: null,
  title: '包名怎么定',
  text: '事实：裸名已被他人发布过 0.2.0；同一作者的同题材插件仍在发。选哪个？',
  kind: 'ask',
  options: ['裸名', '带前缀'],
  key: 'k',
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  deliveryAttempts: 0,
  nextDeliveryAt: null,
  deliveryGivenUp: false,
  optionIndex: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
}

describe('ApprovalBar', () => {
  it('只列标题：不展示卡片正文与选项按钮（正文与选择留到任务内部）', () => {
    render(<ApprovalBar cards={[card]} onOpen={vi.fn()} />)

    const pending = screen.getByRole('region', { name: '待审批' })
    expect(within(pending).getByText('包名怎么定')).toBeInTheDocument()
    expect(within(pending).queryByText(card.text)).toBeNull()
    expect(within(pending).queryByRole('button', { name: '裸名' })).toBeNull()
    expect(within(pending).queryByRole('button', { name: '带前缀' })).toBeNull()
    // 只留「有 N 项待选」的信息与落点提示
    expect(within(pending).getByText('2 项待选')).toBeInTheDocument()
    expect(within(pending).getByText('任务')).toBeInTheDocument()
  })

  it('点条目：把卡片交给上层，由上层进任务详情', () => {
    const onOpen = vi.fn()
    render(<ApprovalBar cards={[card]} onOpen={onOpen} />)

    fireEvent.click(screen.getByRole('button', { name: /包名怎么定/ }))
    expect(onOpen).toHaveBeenCalledWith(card)
  })

  it('信息卡进「通知」栏：也给入口，但通知条里不出现「知道了」', () => {
    const notice: Card = { ...card, id: 'card-2', options: [], kind: 'notice', title: '顺带说一句' }
    const onOpen = vi.fn()
    render(<ApprovalBar cards={[notice]} onOpen={onOpen} />)

    const notices = screen.getByRole('region', { name: '通知' })
    expect(screen.queryByRole('region', { name: '待审批' })).toBeNull()
    expect(within(notices).queryByRole('button', { name: '知道了' })).toBeNull()
    expect(within(notices).queryByText(/项待选/)).toBeNull()

    fireEvent.click(within(notices).getByRole('button', { name: /顺带说一句/ }))
    expect(onOpen).toHaveBeenCalledWith(notice)
  })

  it('两栏并存：各自计数，互不串栏', () => {
    const notice: Card = { ...card, id: 'card-2', options: [], kind: 'notice', title: '版本不一致' }
    render(<ApprovalBar cards={[card, notice]} onOpen={vi.fn()} />)

    const pending = screen.getByRole('region', { name: '待审批' })
    const notices = screen.getByRole('region', { name: '通知' })
    expect(within(pending).getByText('1')).toBeInTheDocument()
    expect(within(notices).getByText('1')).toBeInTheDocument()
    expect(within(pending).getByText('包名怎么定')).toBeInTheDocument()
    expect(within(notices).getByText('版本不一致')).toBeInTheDocument()
  })

  it('聊天卡落点写「对话」，并能把卡片交给上层切会话', () => {
    const chatCard: Card = { ...card, id: 'card-3', taskId: null, conversationId: 'c-1' }
    const onOpen = vi.fn()
    render(<ApprovalBar cards={[chatCard]} onOpen={onOpen} />)

    const pending = screen.getByRole('region', { name: '待审批' })
    expect(within(pending).getByText('对话')).toBeInTheDocument()

    fireEvent.click(within(pending).getByRole('button', { name: /包名怎么定/ }))
    expect(onOpen).toHaveBeenCalledWith(chatCard)
  })

  it('没有落点的卡（既无任务也无会话）：行禁用，点了不跳转', () => {
    const orphan: Card = { ...card, id: 'card-4', taskId: null, conversationId: null }
    const onOpen = vi.fn()
    render(<ApprovalBar cards={[orphan]} onOpen={onOpen} />)

    const row = screen.getByRole('button', { name: /包名怎么定/ })
    expect(row).toBeDisabled()
    fireEvent.click(row)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('多张卡按视图顺序列出，计数徽标等于条数', () => {
    const second: Card = { ...card, id: 'card-1b', title: '发布分支用哪个' }
    render(<ApprovalBar cards={[card, second]} onOpen={vi.fn()} />)

    const pending = screen.getByRole('region', { name: '待审批' })
    const rows = within(pending).getAllByRole('button')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('包名怎么定')
    expect(rows[1]).toHaveTextContent('发布分支用哪个')
    expect(pending).toHaveTextContent('2')
  })

  it('标题单行截断：容器带 truncate，正文不进入通知条', () => {
    render(<ApprovalBar cards={[card]} onOpen={vi.fn()} />)

    const title = screen.getByText('包名怎么定')
    expect(title.className).toContain('truncate')
    expect(title.textContent).not.toContain('裸名')
    expect(screen.queryByText(/事实：/)).toBeNull()
  })

  it('只有一项选项时徽标写「1 项待选」', () => {
    render(<ApprovalBar cards={[{ ...card, options: ['采纳'] }]} onOpen={vi.fn()} />)

    expect(screen.getByText('1 项待选')).toBeInTheDocument()
    expect(screen.queryByText('2 项待选')).toBeNull()
  })

  it('点一次条目只回调一次（整行是一个按钮，不重复触发）', () => {
    const onOpen = vi.fn()
    render(<ApprovalBar cards={[card]} onOpen={onOpen} />)

    fireEvent.click(screen.getByRole('button', { name: /包名怎么定/ }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen.mock.calls[0][0].id).toBe('card-1')
  })

  it('任务卡不写「对话」，聊天卡不写「任务」：落点标签互斥', () => {
    const chatCard: Card = { ...card, id: 'card-3', taskId: null, conversationId: 'c-1' }
    const { unmount } = render(<ApprovalBar cards={[card]} onOpen={vi.fn()} />)
    expect(screen.queryByText('对话')).toBeNull()
    unmount()

    render(<ApprovalBar cards={[chatCard]} onOpen={vi.fn()} />)
    expect(screen.queryByText('任务')).toBeNull()
    expect(screen.getByText('对话')).toBeInTheDocument()
  })

  it('无 open 卡：整块不渲染', () => {
    const { container } = render(<ApprovalBar cards={[]} onOpen={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('kind 是唯一判据：options 为空但 kind="ask" 的卡仍进「待审批」', () => {
    const askWithoutOptions: Card = { ...card, id: 'card-5', kind: 'ask', options: [] }
    render(<ApprovalBar cards={[askWithoutOptions]} onOpen={vi.fn()} />)

    const pending = screen.getByRole('region', { name: '待审批' })
    expect(within(pending).getByText('包名怎么定')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '通知' })).toBeNull()
    // 没有选项就不写「N 项待选」
    expect(within(pending).queryByText(/项待选/)).toBeNull()
  })

  it('kind="notice" 但 options 非空：以 kind 为准进「通知」栏，不渲染待选徽标', () => {
    const notice: Card = { ...card, id: 'card-6', kind: 'notice', options: ['知道了'] }
    render(<ApprovalBar cards={[notice]} onOpen={vi.fn()} />)

    const notices = screen.getByRole('region', { name: '通知' })
    expect(within(notices).getByText('包名怎么定')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '待审批' })).toBeNull()
    expect(within(notices).queryByText('知道了')).toBeNull()
  })

  it('两类卡并存：分栏按 kind 切分，互不串栏', () => {
    const notice: Card = { ...card, id: 'card-7', kind: 'notice', options: [], title: '知会一条' }
    render(<ApprovalBar cards={[card, notice]} onOpen={vi.fn()} />)

    const pending = screen.getByRole('region', { name: '待审批' })
    const notices = screen.getByRole('region', { name: '通知' })
    expect(within(pending).getByText('包名怎么定')).toBeInTheDocument()
    expect(within(notices).getByText('知会一条')).toBeInTheDocument()
    expect(within(pending).queryByText('知会一条')).toBeNull()
    expect(within(notices).queryByText('包名怎么定')).toBeNull()
  })

  it('同文案的信息卡合并成一行（×N），ask 仍一张一行', () => {
    const notice: Card = { ...card, id: 'card-2', kind: 'notice', options: [], title: '依赖已装' }
    render(<ApprovalBar cards={[card, notice, { ...notice, id: 'card-3' }]} onOpen={vi.fn()} />)

    const notices = screen.getByRole('region', { name: '通知' })
    expect(within(notices).getAllByRole('button')).toHaveLength(1)
    expect(within(notices).getByText('×2')).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: '待审批' })).getAllByRole('button'),
    ).toHaveLength(1)
  })

  it('聊天信息卡也按文案合并，落点仍写「对话」', () => {
    const notice: Card = {
      ...card,
      id: 'card-8',
      kind: 'notice',
      options: [],
      title: '聊完一句',
      taskId: null,
      conversationId: 'c-1',
    }
    render(<ApprovalBar cards={[notice, { ...notice, id: 'card-9' }]} onOpen={vi.fn()} />)

    const notices = screen.getByRole('region', { name: '通知' })
    expect(within(notices).getAllByRole('button')).toHaveLength(1)
    expect(within(notices).getByText('×2')).toBeInTheDocument()
    expect(within(notices).getByText('对话')).toBeInTheDocument()
  })

  it('缺 kind 的老数据：无选项按信息卡进「通知」，有选项仍进「待审批」', () => {
    const legacyNotice = { ...card, id: 'card-2', options: [], title: '旧知会' } as {
      kind?: string
    }
    delete legacyNotice.kind
    const legacyAsk = { ...card, id: 'card-3' } as { kind?: string }
    delete legacyAsk.kind

    render(<ApprovalBar cards={[legacyNotice as never, legacyAsk as never]} onOpen={vi.fn()} />)

    expect(
      within(screen.getByRole('region', { name: '通知' })).getByText('旧知会'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: '待审批' })).getByText('包名怎么定'),
    ).toBeInTheDocument()
  })
})
