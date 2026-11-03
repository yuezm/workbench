import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TaskDialog } from './TaskDialog'

describe('TaskDialog', () => {
  it('填写标题/描述后创建；取消回调', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<TaskDialog workflowId="w1" onSave={onSave} onCancel={onCancel} />)
    await user.type(screen.getByLabelText('任务标题'), '做点事')
    await user.type(screen.getByLabelText('任务描述'), '描述')
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toMatchObject({
      title: '做点事',
      description: '描述',
      workflowId: 'w1',
    })
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('标题为空不提交', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(<TaskDialog workflowId="w1" onSave={onSave} onCancel={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Esc 关闭弹窗', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<TaskDialog workflowId="w1" onSave={vi.fn()} onCancel={onCancel} />)
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
  })

  it('右上角关闭按钮回调取消', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<TaskDialog workflowId="w1" onSave={vi.fn()} onCancel={onCancel} />)
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
