import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

/** 选中一行再提交（新交互：选中不提交，提交要按一次「提交所选」） */
async function pickAndSubmit(option: string): Promise<void> {
  fireEvent.click(screen.getByRole('radio', { name: option }))
  fireEvent.click(screen.getByRole('button', { name: '提交所选' }))
}

describe('ApprovalCards', () => {
  it('任务内部完整展示：标题 / 正文 / 选项（单选行）', () => {
    render(<ApprovalCards cards={[card]} />)

    expect(screen.getByRole('region', { name: '待处理卡' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /待审批/ })).toBeInTheDocument()
    expect(screen.getByText('继续吗')).toBeInTheDocument()
    expect(screen.getByText('选一个')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '继续' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '停止' })).toBeInTheDocument()
    expect(screen.getByText('待你决定')).toBeInTheDocument()
    expect(screen.getByText('2 个选项')).toBeInTheDocument()
  })

  it('正文按原样换行展示（长事实清单不被截断）', () => {
    const long = '事实：裸名已被他人发布过 0.2.0\n分支：默认分支是 master'
    render(<ApprovalCards cards={[{ ...card, text: long }]} />)

    const body = screen.getByText(/裸名已被他人发布过/)
    expect(body.textContent).toBe(long)
    expect(body.className).toContain('whitespace-pre-wrap')
  })

  it('选项竖排、整行可点、序号只做视觉锚点', () => {
    render(
      <ApprovalCards
        cards={[{ ...card, options: ['裸名', '换成带前缀的 scope', '先用私有 registry'] }]}
      />,
    )

    const group = screen.getByRole('radiogroup', { name: '选项：继续吗' })
    const options = within(group).getAllByRole('radio')
    expect(options).toHaveLength(3)
    for (const option of options) {
      expect(option.className).toContain('w-full')
      expect(option.className).toContain('text-left')
    }
    // 序号是装饰：可访问名仍是纯选项文案，不做「2 换成带前缀的 scope」
    expect(within(group).getByRole('radio', { name: '换成带前缀的 scope' })).toBeInTheDocument()
  })

  it('选中不提交：点一行只把它标成选中，命令一条都不发', () => {
    render(<ApprovalCards cards={[card]} />)

    fireEvent.click(screen.getByRole('radio', { name: '停止' }))

    expect(screen.getByRole('radio', { name: '停止' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '继续' })).toHaveAttribute('aria-checked', 'false')
    expect(kernel.dispatched).toHaveLength(0)
    // 提交前明确告诉人「还差一步」
    expect(screen.getByRole('button', { name: '提交所选' })).toBeEnabled()
  })

  it('没选就提交：按钮禁用，并写明原因', () => {
    render(<ApprovalCards cards={[card]} />)

    expect(screen.getByRole('button', { name: '提交所选' })).toBeDisabled()
    expect(screen.getByText('先选一项，再提交')).toBeInTheDocument()
  })

  it('选中后提交：dispatch card.answer(cardId, index, via=ui)', async () => {
    render(<ApprovalCards cards={[card]} />)

    await pickAndSubmit('停止')
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
    await pickAndSubmit('停止')
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

    await pickAndSubmit('继续')
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect('note' in kernel.dispatched[0]!).toBe(false)
  })

  it('「说点其他的」类选项：不写内容就提交，命令不发、就地报错并把焦点送回输入框', () => {
    render(<ApprovalCards cards={[{ ...card, options: ['继续', '停止', '说点其他的'] }]} />)

    fireEvent.click(screen.getByRole('radio', { name: '说点其他的' }))
    // 必填口径写在标签与输入框语义上，不是靠按钮灰着猜
    expect(screen.getByText('补充说明（必填）：写下你选这一项的具体内容')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '补充说明：继续吗' })).toHaveAttribute(
      'aria-required',
      'true',
    )
    expect(screen.getByText('这一项要写下具体内容才能提交')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '提交所选' }))

    expect(kernel.dispatched).toHaveLength(0)
    expect(screen.getByRole('alert')).toHaveTextContent('这一项要写下具体内容再提交')
    expect(screen.getByRole('textbox', { name: '补充说明：继续吗' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: '补充说明：继续吗' })).toHaveAttribute(
      'aria-invalid',
      'true',
    )
  })

  it('「说点其他的」写清内容后可提交：note 带上那段文字，错误提示随之消失', async () => {
    render(<ApprovalCards cards={[{ ...card, options: ['继续', '说点其他的'] }]} />)

    fireEvent.click(screen.getByRole('radio', { name: '说点其他的' }))
    fireEvent.click(screen.getByRole('button', { name: '提交所选' }))
    expect(screen.getByRole('alert')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: '补充说明：继续吗' }), {
      target: { value: '  换个思路：先发私有 registry  ' },
    })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '提交所选' }))

    await waitFor(() =>
      expect(kernel.dispatched).toContainEqual(
        expect.objectContaining({
          type: 'card.answer',
          cardId: 'card-1',
          optionIndex: 1,
          note: '换个思路：先发私有 registry',
        }),
      ),
    )
  })

  it('英文 other 选项同样按必填处理（措辞判定不分语言）', () => {
    render(<ApprovalCards cards={[{ ...card, options: ['Keep it', 'Something else'] }]} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Something else' }))
    expect(screen.getByText('补充说明（必填）：写下你选这一项的具体内容')).toBeInTheDocument()
  })

  it('键盘：方向键换选中项并把焦点带过去，Home / End 直达两端', () => {
    render(<ApprovalCards cards={[{ ...card, options: ['一', '二', '三'] }]} />)

    const group = screen.getByRole('radiogroup', { name: '选项：继续吗' })
    fireEvent.keyDown(group, { key: 'ArrowDown' })
    expect(screen.getByRole('radio', { name: '二' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '二' })).toHaveFocus()

    fireEvent.keyDown(group, { key: 'ArrowUp' })
    expect(screen.getByRole('radio', { name: '一' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.keyDown(group, { key: 'End' })
    expect(screen.getByRole('radio', { name: '三' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.keyDown(group, { key: 'Home' })
    expect(screen.getByRole('radio', { name: '一' })).toHaveAttribute('aria-checked', 'true')

    // 非导航键不接管：选项组里的普通按键仍按浏览器默认行为处理
    fireEvent.keyDown(group, { key: 'a' })
    expect(screen.getByRole('radio', { name: '一' })).toHaveAttribute('aria-checked', 'true')
  })

  it('回答失败：显示后端文案，卡片仍保留、不崩', async () => {
    kernel.onDispatch(() => Promise.reject(new Error('卡片已回答或已关闭: card-1')))
    render(<ApprovalCards cards={[card]} />)

    await pickAndSubmit('继续')
    expect(await screen.findByRole('alert')).toHaveTextContent('卡片已回答或已关闭: card-1')
    expect(screen.getByText('继续吗')).toBeInTheDocument()
  })

  it('回答失败为非 Error 时按字符串展示', async () => {
    kernel.onDispatch(() => Promise.reject('回答纯文本失败'))
    render(<ApprovalCards cards={[card]} />)

    await pickAndSubmit('继续')
    expect(await screen.findByRole('alert')).toHaveTextContent('回答纯文本失败')
  })

  it('回答进行中：选项与提交按钮禁用，避免重复点击', async () => {
    let resolveAnswer: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      resolveAnswer = resolve
    })
    kernel.onDispatch(() => pending as Promise<never>)
    render(<ApprovalCards cards={[card]} />)

    await pickAndSubmit('继续')
    await waitFor(() => expect(screen.getByRole('button', { name: '提交中…' })).toBeDisabled())
    expect(screen.getByRole('radio', { name: '继续' })).toBeDisabled()

    resolveAnswer({ facts: [], value: null })
    await waitFor(() => expect(screen.getByRole('button', { name: '提交所选' })).toBeEnabled())
  })

  it('点通知进来的定位：滚到该卡并高亮，高亮到时自己收掉', () => {
    vi.useFakeTimers()
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      render(<ApprovalCards cards={[card]} focusCardId="card-1" />)

      const anchor = document.getElementById('approval-card-card-1')
      expect(anchor).not.toBeNull()
      expect(anchor).toHaveAttribute('data-card-id', 'card-1')
      expect(anchor).toHaveAttribute('data-focused', 'true')
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })

      act(() => {
        vi.advanceTimersByTime(2400)
      })
      expect(anchor).not.toHaveAttribute('data-focused')
    } finally {
      Element.prototype.scrollIntoView = original
      vi.useRealTimers()
    }
  })

  it('点通知条里的「通知」进来：定位到合并后的那一行', () => {
    const notice = { ...card, id: 'n-1', kind: 'notice' as const, options: [], text: '依赖已装' }
    render(<ApprovalCards cards={[notice]} focusCardId="n-1" />)

    const anchor = screen.getByText('继续吗').closest('[data-card-id]')
    expect(anchor).toHaveAttribute('data-card-id', 'n-1')
    expect(anchor).toHaveAttribute('data-focused', 'true')
  })

  it('定位的卡不在这一处：不滚也不高亮，其它卡照常渲染', () => {
    render(<ApprovalCards cards={[card]} focusCardId="card-none" />)

    const anchor = document.getElementById('approval-card-card-1')
    expect(anchor).not.toHaveAttribute('data-focused')
    expect(screen.getByText('继续吗')).toBeInTheDocument()
  })

  it('空选项的 ask 卡（脏投影兜底）：不渲染选项，方向键也不炸', () => {
    render(<ApprovalCards cards={[{ ...card, kind: 'ask', options: [] }]} />)

    const group = screen.getByRole('radiogroup', { name: '选项：继续吗' })
    expect(within(group).queryAllByRole('radio')).toHaveLength(0)
    fireEvent.keyDown(group, { key: 'ArrowDown' })
    expect(screen.getByRole('button', { name: '提交所选' })).toBeDisabled()
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('卡片原地更新后选项变少：越界的旧选中项按「不是自由输入」处理，不炸也不误判', () => {
    const { rerender } = render(
      <ApprovalCards cards={[{ ...card, options: ['一', '二', '说点其他的'] }]} />,
    )
    fireEvent.click(screen.getByRole('radio', { name: '说点其他的' }))
    expect(screen.getByText('补充说明（必填）：写下你选这一项的具体内容')).toBeInTheDocument()

    // 同一张卡 version+1、选项缩到一个：旧下标 2 越界，`options[2]` 不存在
    rerender(<ApprovalCards cards={[{ ...card, options: ['只剩一项'], version: 2 }]} />)
    expect(
      screen.getByText('补充说明（可选）：有异议或想追问的写在这里，会随所选项一起交给它'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交所选' })).toBeEnabled()
  })

  it('没有定位目标（null）：不高亮、不滚，卡片照常可用', () => {
    render(<ApprovalCards cards={[card]} focusCardId={null} />)

    expect(document.getElementById('approval-card-card-1')).not.toHaveAttribute('data-focused')
    expect(screen.getByRole('radio', { name: '继续' })).toBeInTheDocument()
  })

  it('信息卡（options 为空）进「通知」栏：只给 × 关闭，不当待审批', () => {
    render(<ApprovalCards cards={[{ ...card, options: [], kind: 'notice' }]} />)

    expect(screen.getByRole('heading', { name: /通知/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /待审批/ })).toBeNull()
    expect(screen.getByText('继续吗')).toBeInTheDocument()
    expect(screen.queryByRole('radio')).toBeNull()
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

  it('ask 永不合并：同标题同选项的两张卡各占一条，各自独立选中', () => {
    render(<ApprovalCards cards={[card, { ...card, id: 'card-2' }]} />)

    const pending = screen.getByRole('region', { name: '待审批' })
    expect(within(pending).getAllByRole('radio', { name: '继续' })).toHaveLength(2)
    expect(within(pending).getAllByText('继续吗')).toHaveLength(2)
    expect(screen.queryByText(/^×/)).toBeNull()

    // 选中第一张不影响第二张
    fireEvent.click(within(pending).getAllByRole('radio', { name: '继续' })[0] as HTMLElement)
    expect(within(pending).getAllByRole('radio', { name: '继续' })[0]).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(pending).getAllByRole('radio', { name: '继续' })[1]).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('信息卡与待审批卡样式分开：通知只留一个 ×（带 aria-label）', () => {
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
    expect(within(pending).getByRole('radio', { name: '继续' })).toBeInTheDocument()
  })

  it('运行环境没有 scrollIntoView（老 WebView / 非浏览器宿主）：跳过滚动，仍标出定位态', () => {
    vi.useFakeTimers()
    const original = Element.prototype.scrollIntoView
    // 宿主可能根本没有这个方法：这里把它拿掉，验证定位不会因此崩掉
    Element.prototype.scrollIntoView = undefined as unknown as typeof original
    try {
      render(<ApprovalCards cards={[card]} focusCardId="card-1" />)

      const anchor = document.getElementById('approval-card-card-1')
      expect(anchor).not.toBeNull()
      expect(anchor).toHaveAttribute('data-focused', 'true')

      act(() => {
        vi.advanceTimersByTime(2400)
      })
      expect(anchor).not.toHaveAttribute('data-focused')
    } finally {
      Element.prototype.scrollIntoView = original
      vi.useRealTimers()
    }
  })
})
