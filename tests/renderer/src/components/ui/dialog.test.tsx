import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from '../../../../../src/renderer/src/components/ui/dialog'

describe('Dialog', () => {
  it('渲染标题与内容，关闭按钮回调', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Dialog title="新建运行时" onClose={onClose}>
        <p>表单内容</p>
      </Dialog>,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '新建运行时' })).toBeInTheDocument()
    expect(screen.getByText('表单内容')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('Esc 关闭弹窗', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <Dialog title="新建运行时" onClose={onClose}>
        <p>表单内容</p>
      </Dialog>,
    )
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('无标题时不渲染标题栏', () => {
    render(
      <Dialog onClose={vi.fn()}>
        <p>自带标题的内容</p>
      </Dialog>,
    )
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.getByText('自带标题的内容')).toBeInTheDocument()
  })

  it('卸载后不再监听键盘事件', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    const { unmount } = render(
      <Dialog title="t" onClose={onClose}>
        <p>x</p>
      </Dialog>,
    )
    unmount()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })
})
