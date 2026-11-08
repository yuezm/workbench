import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type FormEvent, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TaskCommentForm } from '../../../../../../src/renderer/src/apps/ai-workflow/components/TaskCommentForm'

interface HarnessProps {
  initialValue?: string
  initialRerun?: boolean
  canRerun?: boolean
  busy?: boolean
  error?: string | null
  onSubmit?: (event: FormEvent) => void
}

/** 受控包装：真组件只收 value/onChange，这里用本地 state 复现任务详情页的用法 */
function Harness({
  initialValue = '',
  initialRerun = true,
  canRerun = true,
  busy = false,
  error = null,
  onSubmit = () => {},
}: HarnessProps): ReactElement {
  const [value, setValue] = useState(initialValue)
  const [rerun, setRerun] = useState(initialRerun)
  return (
    <TaskCommentForm
      value={value}
      onChange={setValue}
      rerun={rerun}
      onRerunChange={setRerun}
      canRerun={canRerun}
      busy={busy}
      error={error}
      onSubmit={onSubmit}
    />
  )
}

describe('TaskCommentForm', () => {
  it('空反馈：按钮可点，点了就地提示并聚焦输入框，不透传提交', async () => {
    const onSubmit = vi.fn((event: FormEvent): void => event.preventDefault())
    const user = userEvent.setup()
    render(<Harness onSubmit={onSubmit} />)

    const send = screen.getByRole('button', { name: '发送反馈' })
    expect(send).toBeEnabled()

    await user.click(send)
    expect(await screen.findByRole('alert')).toHaveTextContent('写点内容再发送')
    expect(screen.getByLabelText('反馈内容')).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()

    // 一开始输入，提示就撤掉
    await user.type(screen.getByLabelText('反馈内容'), '补背景')
    expect(screen.queryByText(/写点内容再发送/)).not.toBeInTheDocument()
    await user.click(send)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('纯空格按空处理：仍然就地提示，不提交', async () => {
    const onSubmit = vi.fn((event: FormEvent): void => event.preventDefault())
    const user = userEvent.setup()
    render(<Harness initialValue="   " onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: '发送反馈' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('写点内容再发送')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('有内容时把提交事件交给上层', async () => {
    const onSubmit = vi.fn((event: FormEvent): void => event.preventDefault())
    const user = userEvent.setup()
    render(<Harness initialValue="按钮改成粉色" onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: '发送反馈' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('提交中：输入、勾选框与按钮全禁用，按钮文案改成「发送中…」', () => {
    render(<Harness initialValue="写很久" busy />)

    expect(screen.getByLabelText('反馈内容')).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: '同时让智能体接着做' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送中…' })).toBeDisabled()
  })

  it('非 agent 阶段：勾选框禁用且不勾选，并说明反馈只作上下文', () => {
    render(<Harness canRerun={false} initialRerun />)

    const rerun = screen.getByRole('checkbox', { name: '同时让智能体接着做' })
    expect(rerun).toBeDisabled()
    expect(rerun).not.toBeChecked()
    expect(screen.getByText(/当前阶段不交给智能体/)).toBeInTheDocument()
  })

  it('agent 阶段：勾选框可切换，说明里写明会立刻再跑一轮', async () => {
    const user = userEvent.setup()
    render(<Harness canRerun initialRerun />)

    const rerun = screen.getByRole('checkbox', { name: '同时让智能体接着做' })
    expect(rerun).toBeChecked()
    expect(screen.getByText(/会立刻再跑一轮/)).toBeInTheDocument()

    await user.click(rerun)
    expect(rerun).not.toBeChecked()
  })

  it('后端拒绝文案用 role=alert 就地展示', () => {
    render(<Harness error="反馈写不进去" />)

    expect(screen.getByRole('alert')).toHaveTextContent('反馈写不进去')
  })

  it('输入透传：受控值随输入变化', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText('反馈内容'), '补背景')
    expect(screen.getByLabelText('反馈内容')).toHaveValue('补背景')
  })
})
