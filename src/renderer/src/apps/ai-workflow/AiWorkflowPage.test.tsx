import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AiWorkflowPage } from './AiWorkflowPage'

describe('AiWorkflowPage', () => {
  it('渲染标题与空态提示', () => {
    render(<AiWorkflowPage />)
    expect(screen.getByRole('heading', { name: 'AI 工作流' })).toBeInTheDocument()
    expect(screen.getByText(/尚无工作流/)).toBeInTheDocument()
  })
})
