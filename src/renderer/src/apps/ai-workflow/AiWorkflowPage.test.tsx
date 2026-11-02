import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiWorkflowPage } from './AiWorkflowPage'

beforeEach(() => {
  ;(window as unknown as { aiWorkflow: unknown }).aiWorkflow = {
    runtimes: { list: vi.fn().mockResolvedValue([]) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    workflows: { list: vi.fn().mockResolvedValue([]) },
    onChanged: vi.fn(() => () => {}),
  }
})

describe('AiWorkflowPage', () => {
  it('渲染标题、管理分区与空态提示', async () => {
    render(<AiWorkflowPage />)
    expect(screen.getByRole('heading', { name: 'AI 工作流' })).toBeInTheDocument()
    expect(screen.getByText('运行时', { selector: 'summary' })).toBeInTheDocument()
    expect(screen.getByText('智能体', { selector: 'summary' })).toBeInTheDocument()
    expect(screen.getByText(/尚无工作流/)).toBeInTheDocument()
    expect(await screen.findByText('暂无运行时')).toBeInTheDocument()
  })
})
