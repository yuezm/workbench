import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { AppDefinition } from '../../../../src/renderer/src/shell/types'
import { Workbench } from '../../../../src/renderer/src/shell/Workbench'

function FakeIcon(): null {
  return null
}

function makeApp(id: string, name: string, content: string): AppDefinition {
  return { id, name, icon: FakeIcon, component: () => <div>{content}</div> }
}

const fakeApps = [makeApp('app-a', '应用A', '内容A'), makeApp('app-b', '应用B', '内容B')]

describe('Workbench 外壳', () => {
  it('默认挂载第一个 app 的内容', () => {
    render(<Workbench apps={fakeApps} />)
    expect(screen.getByText('内容A')).toBeInTheDocument()
    expect(screen.queryByText('内容B')).not.toBeInTheDocument()
  })

  it('点击顶部标签切换内容区 app，且无整页刷新', async () => {
    render(<Workbench apps={fakeApps} />)
    await userEvent.click(screen.getByRole('button', { name: '应用B' }))
    expect(screen.getByText('内容B')).toBeInTheDocument()
    expect(screen.queryByText('内容A')).not.toBeInTheDocument()
  })
})
