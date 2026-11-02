import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Run } from '../../../../../shared/ai-workflow-api'
import { RunLog } from './RunLog'

const run: Run = {
  id: 'r1',
  taskId: 't1',
  stageId: 's1',
  agentId: 'a1',
  status: 'succeeded',
  prompt: 'p',
  output: 'hello',
  error: null,
  startedAt: '2026-11-03T00:00:00Z',
  endedAt: '2026-11-03T00:01:00Z',
  createdAt: 't',
}

describe('RunLog', () => {
  it('无运行记录时提示', () => {
    render(<RunLog runs={[]} />)
    expect(screen.getByText('暂无运行记录')).toBeInTheDocument()
  })

  it('渲染状态、时间、输出与错误；无 startedAt 回落到 createdAt', () => {
    render(
      <RunLog
        runs={[
          run,
          {
            ...run,
            id: 'r2',
            status: 'failed',
            error: 'boom',
            output: '',
            startedAt: null,
            createdAt: '2026-01-01',
          },
        ]}
      />,
    )
    expect(screen.getByText('succeeded')).toBeInTheDocument()
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(screen.getByText('2026-01-01')).toBeInTheDocument()
  })
})
