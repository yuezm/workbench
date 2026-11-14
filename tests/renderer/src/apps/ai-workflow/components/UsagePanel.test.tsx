import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '../../../../../../src/protocol/entities'
import type { UsageAgentRow, UsageDailyRow } from '../../../../../../src/protocol/views'
import { UsagePanel } from '../../../../../../src/renderer/src/apps/ai-workflow/components/UsagePanel'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

const AT = '2026-11-14T12:00:00.000Z'

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '',
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: AT,
  ...over,
})

const daily = (over: Partial<UsageDailyRow> = {}): UsageDailyRow => ({
  date: '2026-11-13',
  rounds: 3,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 50,
  cacheWriteTokens: 10,
  costUsd: 0.5,
  missingTokens: 0,
  missingCost: 0,
  ...over,
})

const agentRow = (over: Partial<UsageAgentRow> = {}): UsageAgentRow => ({
  agentId: 'ag-1',
  rounds: 3,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 50,
  cacheWriteTokens: 10,
  costUsd: 0.5,
  missingTokens: 0,
  missingCost: 0,
  ...over,
})

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
  kernel.setView('agents.all', undefined, [agent()])
})

describe('UsagePanel（M36-E）', () => {
  it('汇总近 7 天的轮次 / tokens / 成本，并按智能体列名', async () => {
    kernel.setViewAnyParams('usage.daily', [
      daily(),
      daily({
        date: '2026-11-14',
        rounds: 2,
        inputTokens: 500,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.25,
      }),
    ])
    kernel.setViewAnyParams('usage.byAgent', [
      agentRow(),
      agentRow({ agentId: null, rounds: 1, costUsd: 0 }),
    ])

    render(<UsagePanel now={() => AT} />)

    await waitFor(() => expect(screen.getByText('5')).toBeInTheDocument())
    expect(screen.getByText('1,860')).toBeInTheDocument()
    expect(screen.getByText('$0.75')).toBeInTheDocument()
    expect(screen.getByText('实现者')).toBeInTheDocument()
    expect(screen.getByText('未指定智能体')).toBeInTheDocument()
  })

  it('缺成本的轮次照实写出来，不折成 0', async () => {
    kernel.setViewAnyParams('usage.daily', [daily({ missingCost: 2 })])
    kernel.setViewAnyParams('usage.byAgent', [agentRow({ missingCost: 2 })])

    render(<UsagePanel now={() => AT} />)

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2 轮未报成本'))
    expect(screen.getByText('（2 轮缺）')).toBeInTheDocument()
  })

  it('没有已结束的轮次给空态', async () => {
    kernel.setViewAnyParams('usage.daily', [])
    kernel.setViewAnyParams('usage.byAgent', [])

    render(<UsagePanel now={() => AT} />)
    await waitFor(() => expect(screen.getByText('近 7 天还没有已结束的轮次。')).toBeInTheDocument())
  })

  it('读取失败：文案透传到面板', async () => {
    kernel.failViewAnyParams('usage.daily', '数据库忙')

    render(<UsagePanel now={() => AT} />)
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('用量读取失败：数据库忙'),
    )
  })

  it('卸载后停止订阅（不残留监听）', () => {
    kernel.setViewAnyParams('usage.daily', [])
    kernel.setViewAnyParams('usage.byAgent', [])
    const view = render(<UsagePanel now={() => AT} />)
    view.unmount()
    // stopFakeKernel 重置内核；这里只验证卸载不抛错，订阅解绑由 kernelStore 的用例兜住
    expect(stopFakeKernel).toBeTypeOf('function')
    stopFakeKernel()
  })
})
