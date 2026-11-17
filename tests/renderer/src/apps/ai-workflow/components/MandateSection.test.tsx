import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mandate } from '@workbench/protocol/authority'
import { MandateSection } from '@workbench/client-app-ai-workflow/components/MandateSection'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

const AT = '2026-11-17T12:00:00.000Z'

const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  id: 'mandate-1',
  taskId: 'task-1',
  scope: {
    workflowId: 'wf-1',
    stageId: 'st-1',
    projectId: null,
    access: 'edit',
    maxRuns: null,
    maxTokens: null,
    expiresAt: null,
  },
  strength: 'explicit',
  basis: 'addressed',
  policyVersion: 7,
  ruleIds: ['rule-1'],
  by: {
    kind: 'identity',
    source: 'github',
    identity: { kind: 'human', id: 'octocat', addressed: true },
  },
  grantedAt: AT,
  revokedAt: null,
  revokedReason: null,
  legacy: false,
  ...over,
})

let fake: FakeKernel

beforeEach(() => {
  fake = installFakeKernel()
})

afterEach(() => {
  stopFakeKernel()
})

describe('MandateSection', () => {
  it('没有授权行：说明是兼容模式或历史任务，不显示空白', async () => {
    fake.setView('mandates.byTask', { taskId: 'task-1' }, null)
    render(<MandateSection taskId="task-1" scopeLabel="研发 · 实现" />)
    await waitFor(() => expect(screen.getByText('无记录')).toBeTruthy())
    expect(screen.getByText(/兼容模式/)).toBeTruthy()
  })

  it('有效授权：强度 / 依据 / 范围 / 权限上限 / 策略版本 / 命中规则', async () => {
    fake.setView('mandates.byTask', { taskId: 'task-1' }, mandate())
    render(<MandateSection taskId="task-1" scopeLabel="研发 · 实现" />)
    await waitFor(() => expect(screen.getByText('有效')).toBeTruthy())
    expect(screen.getByText('明确请求')).toBeTruthy()
    expect(screen.getByText('点名')).toBeTruthy()
    expect(screen.getByText('研发 · 实现')).toBeTruthy()
    expect(screen.getByText('可改')).toBeTruthy()
    expect(screen.getByText('策略 v7')).toBeTruthy()
    expect(screen.getByText('rule-1')).toBeTruthy()
    expect(screen.getByText(/github · octocat/)).toBeTruthy()
  })

  it('已撤销：给出撤销原因与时刻，而不是只把状态改灰', async () => {
    fake.setView(
      'mandates.byTask',
      { taskId: 'task-1' },
      mandate({ revokedAt: AT, revokedReason: 'revalidate' }),
    )
    render(<MandateSection taskId="task-1" scopeLabel="研发 · 实现" />)
    await waitFor(() => expect(screen.getByText('已撤销')).toBeTruthy())
    expect(screen.getByText(/重校验失败/)).toBeTruthy()
  })

  it('手工任务：规则一栏写「手工任务」，不冒充规则命中', async () => {
    fake.setView(
      'mandates.byTask',
      { taskId: 'task-1' },
      mandate({
        ruleIds: [],
        basis: 'manual',
        by: { kind: 'manual', via: 'ui' },
      }),
    )
    render(<MandateSection taskId="task-1" scopeLabel="研发 · 实现" />)
    await waitFor(() => expect(screen.getByText('手工')).toBeTruthy())
    expect(screen.getByText('无（手工任务）')).toBeTruthy()
    expect(screen.getByText(/本机手工创建/)).toBeTruthy()
  })
})
