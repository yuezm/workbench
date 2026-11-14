import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { RulePreview } from '../../../../../../src/protocol/rules'
import { RulePreviewPanel } from '../../../../../../src/renderer/src/apps/ai-workflow/components/RulePreviewPanel'
import { installFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

let kernel: FakeKernel

const match = (
  over: Partial<RulePreview['matches'][number]> = {},
): RulePreview['matches'][number] => ({
  ruleId: 'rule-1',
  ruleName: 'Issue 进研发',
  enabled: true,
  workflowId: 'wf-1',
  stageId: 'st-1',
  title: '#42 示例',
  threadKey: '#42 示例',
  ...over,
})

beforeEach(() => {
  kernel = installFakeKernel()
})

describe('RulePreviewPanel（M36-F）', () => {
  it('填样本 → 试跑 → 列出会接的规则与落点', async () => {
    kernel.setViewAnyParams('rules.preview', { matches: [match()], wouldCreate: true })
    render(<RulePreviewPanel />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '试跑' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('会建任务'))
    expect(screen.getByText('Issue 进研发')).toBeInTheDocument()
    expect(screen.getByText('→ st-1')).toBeInTheDocument()
    expect(screen.getByText('标题：#42 示例')).toBeInTheDocument()
  })

  it('没有规则命中：明说「没有规则会接」', async () => {
    kernel.setViewAnyParams('rules.preview', { matches: [], wouldCreate: false })
    render(<RulePreviewPanel />)
    await userEvent.click(screen.getByRole('button', { name: '试跑' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('没有规则会接这条事件。'),
    )
  })

  it('停用规则与失效落点照实标注', async () => {
    kernel.setViewAnyParams('rules.preview', {
      matches: [
        match({ enabled: false }),
        match({ ruleId: 'rule-2', ruleName: '旧规则', workflowId: null, stageId: null }),
      ],
      wouldCreate: false,
    })
    render(<RulePreviewPanel />)

    await userEvent.click(screen.getByRole('button', { name: '试跑' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('不会建任务'))
    expect(screen.getByText('已停用')).toBeInTheDocument()
    expect(screen.getByText('落点已失效')).toBeInTheDocument()
  })

  it('样本字段可改：来源 / 类型 / 对象都跟着输入走', async () => {
    kernel.setViewAnyParams('rules.preview', { matches: [], wouldCreate: false })
    render(<RulePreviewPanel />)

    const source = screen.getByLabelText('事件来源')
    const type = screen.getByLabelText('事件类型')
    const subject = screen.getByLabelText('事件对象')
    await userEvent.clear(source)
    await userEvent.type(source, 'gitlab')
    await userEvent.clear(type)
    await userEvent.type(type, 'merge_request.opened')
    await userEvent.clear(subject)
    await userEvent.type(subject, '!7')

    expect(source).toHaveValue('gitlab')
    expect(type).toHaveValue('merge_request.opened')
    expect(subject).toHaveValue('!7')

    await userEvent.click(screen.getByRole('button', { name: '试跑' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('没有规则会接这条事件。'),
    )
  })
})
