import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Runtime } from '../../../../../shared/ai-workflow-api'
import { AgentDialog } from './AgentDialog'

const rt: Runtime = {
  id: 'r1',
  name: 'ds',
  kind: 'deepseek-harness',
  command: 'dsh',
  args: [],
  promptMode: 'arg',
  workdir: null,
  createdAt: 't',
}

const empty = { name: '', description: '', runtimeId: '', systemPrompt: '' }

describe('AgentDialog', () => {
  it('无运行时时给出提示并禁用提交', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<AgentDialog runtimes={[]} initial={empty} onSubmit={onSubmit} onCancel={vi.fn()} />)

    expect(screen.getByText(/请先在上方添加一个运行时/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加智能体' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '添加智能体' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('运行时列表为空时清空已选运行时', async () => {
    render(<AgentDialog runtimes={[]} initial={empty} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('智能体运行时')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: '智能体运行时' })).toHaveTextContent('（无）')
  })

  it('有运行时时默认选中第一个并可提交', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<AgentDialog runtimes={[rt]} initial={empty} onSubmit={onSubmit} onCancel={vi.fn()} />)

    await waitFor(() => expect(screen.getByLabelText('智能体运行时')).toHaveValue('r1'))
    await user.type(screen.getByLabelText('智能体名称'), 'coder')
    await user.click(screen.getByRole('button', { name: '添加智能体' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'coder', runtimeId: 'r1' })
  })
})
