import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeDialog } from './RuntimeDialog'

const empty = { name: '', command: 'dsh', args: [], promptMode: 'arg' as const, workdir: null }

describe('RuntimeDialog', () => {
  it('按预填值渲染并提交解析后的参数', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <RuntimeDialog
        initial={{ ...empty, name: 'Codex CLI', command: 'codex' }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('运行时名称')).toHaveValue('Codex CLI')
    expect(screen.getByLabelText('运行时命令')).toHaveValue('codex')

    await user.type(screen.getByLabelText('运行时参数'), 'a b')
    await user.click(screen.getByRole('button', { name: '添加运行时' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: 'Codex CLI',
      command: 'codex',
      args: ['a', 'b'],
      promptMode: 'arg',
      workdir: null,
    })
  })

  it('提交失败在弹窗内展示错误并保持打开', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('create-fail'))
    const user = userEvent.setup()
    render(<RuntimeDialog initial={empty} onSubmit={onSubmit} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('运行时名称'), 'x')
    await user.click(screen.getByRole('button', { name: '添加运行时' }))
    expect(await screen.findByText('create-fail')).toBeInTheDocument()
    expect(screen.getByLabelText('运行时名称')).toBeInTheDocument()
  })

  it('取消与关闭按钮都回调 onCancel', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    const { unmount } = render(
      <RuntimeDialog initial={empty} onSubmit={vi.fn()} onCancel={onCancel} />,
    )
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
    unmount()
  })
})
