import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../../../../src/renderer/src/components/ui/dialog'

/**
 * Radix Dialog 打开时给 body 加 pointer-events: none，jsdom 下需关掉这层检查，
 * 才能真实模拟「点遮罩关闭」等交互。
 */
const setupUser = () => userEvent.setup({ pointerEventsCheck: 0 })

describe('Dialog（shadcn 基座）', () => {
  it('渲染标题与内容，关闭按钮回调', async () => {
    const onOpenChange = vi.fn()
    const user = setupUser()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建运行时</DialogTitle>
          </DialogHeader>
          <p>表单内容</p>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '新建运行时' })).toBeInTheDocument()
    expect(screen.getByText('表单内容')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('Esc 关闭弹窗', async () => {
    const onOpenChange = vi.fn()
    const user = setupUser()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>新建运行时</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    await user.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('无标题时不渲染标题栏', () => {
    render(
      <Dialog open onOpenChange={vi.fn()}>
        <DialogContent>
          <p>自带标题的内容</p>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(screen.getByText('自带标题的内容')).toBeInTheDocument()
  })

  it('卸载后不再监听键盘事件', async () => {
    const onOpenChange = vi.fn()
    const user = setupUser()
    const { unmount } = render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>t</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    unmount()
    await user.keyboard('{Escape}')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('关闭时把焦点交还给触发器', async () => {
    const user = setupUser()
    render(
      <Dialog>
        <DialogTrigger>打开</DialogTrigger>
        <DialogContent>
          <DialogTitle>标题</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const trigger = screen.getByRole('button', { name: '打开' })
    await user.click(trigger)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('描述走 DialogDescription，关联到弹窗', () => {
    render(
      <Dialog open onOpenChange={vi.fn()}>
        <DialogContent>
          <DialogTitle>新建规则</DialogTitle>
          <DialogDescription>规则用于判定任务是否需要人工确认</DialogDescription>
        </DialogContent>
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog')
    expect(screen.getByText('规则用于判定任务是否需要人工确认')).toBeInTheDocument()
    expect(dialog).toHaveAccessibleDescription('规则用于判定任务是否需要人工确认')
  })

  it('页脚可放置关闭按钮', async () => {
    const onOpenChange = vi.fn()
    const user = setupUser()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>标题</DialogTitle>
          <DialogFooter showCloseButton>
            <button type="button">确定</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.getByRole('button', { name: '确定' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('DialogClose 可主动关闭弹窗', async () => {
    const onOpenChange = vi.fn()
    const user = setupUser()
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>标题</DialogTitle>
          <DialogClose>取消</DialogClose>
        </DialogContent>
      </Dialog>,
    )
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('内容区可关闭右上角关闭按钮', () => {
    render(
      <Dialog open onOpenChange={vi.fn()}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>标题</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    expect(screen.queryByRole('button', { name: '关闭' })).not.toBeInTheDocument()
  })
})
