import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Panel } from '../../../../../src/renderer/src/components/ui/panel'

describe('Panel', () => {
  it('渲染统一玻璃面板样式与子内容', () => {
    render(
      <Panel data-testid="p" className="p-5">
        <span>内容</span>
      </Panel>,
    )
    const panel = screen.getByTestId('p')
    expect(panel).toHaveClass('rounded-xl', 'border-line', 'bg-surface', 'p-5')
    expect(screen.getByText('内容')).toBeInTheDocument()
  })
})
