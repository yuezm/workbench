import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StartupFailure } from '../../../../../src/renderer/src/shell/components/StartupFailure'

describe('StartupFailure', () => {
  it('缺省指向 preload 桥接缺失，并给出可操作建议', () => {
    render(<StartupFailure />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('界面没有加载成功')
    expect(alert).toHaveTextContent('window.workbench 未注入（preload 未加载）')
    expect(alert).toHaveTextContent('重新安装')
  })

  it('可自定义原因（保留同一套兜底文案）', () => {
    render(<StartupFailure message="内核启动失败：DB 被占用" />)
    expect(screen.getByRole('alert')).toHaveTextContent('内核启动失败：DB 被占用')
    expect(screen.getByText('界面没有加载成功')).toBeInTheDocument()
  })
})
