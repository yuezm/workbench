import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Command } from '../../../../../../src/protocol/commands'
import type { WorkflowWithStages } from '../../../../../../src/protocol/entities'
import type { DispatchResult } from '../../../../../../src/protocol/ipc'
import { WorkflowManager } from '../../../../../../src/renderer/src/apps/ai-workflow/components/WorkflowManager'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

function wf(id: string, name: string, stages = 0, description = ''): WorkflowWithStages {
  return {
    id,
    name,
    description,
    createdAt: 't',
    stages: Array.from({ length: stages }, (_, i) => ({
      id: `${id}-s${i}`,
      workflowId: id,
      name: `阶段${i + 1}`,
      position: i,
      entryMode: 'none' as const,
      agentId: null,
      onCompleteStageId: null,
      onRejectStageId: null,
      handoffWorkflowId: null,
      handoffStageId: null,
    })),
  }
}

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

afterEach(() => {
  stopFakeKernel()
})

/** dispatch 注入：绕过 onDispatch 的泛型签名，测试里按命令 type 分支 */
function handleDispatch(
  handler: (command: Command) => Promise<DispatchResult<unknown>> | DispatchResult<unknown>,
): void {
  kernel.onDispatch(handler as unknown as Parameters<FakeKernel['onDispatch']>[0])
}

describe('WorkflowManager', () => {
  it('列出工作流：首个为当前，点击行切换选中，点击编辑打开定义弹窗', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发', 3, '日常研发'), wf('w2', '写作')])
    const user = userEvent.setup()
    render(<WorkflowManager />)

    expect(await screen.findByText('3 阶段 · 日常研发')).toBeInTheDocument()
    const first = screen.getByRole('button', { name: /研发/ })
    expect(within(first).getByText('当前')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /写作/ }))
    expect(
      within(screen.getByRole('button', { name: /写作/ })).getByText('当前'),
    ).toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /研发/ })).queryByText('当前')).toBeNull()

    await user.click(screen.getAllByRole('button', { name: '编辑' })[0])
    expect(screen.getByRole('dialog')).toHaveTextContent('工作流定义')
    expect(screen.getByLabelText('工作流名称')).toHaveValue('研发')
  })

  it('空清单显示空态；新建工作流打开空表单', async () => {
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowManager />)

    expect(await screen.findByText('暂无工作流')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('工作流定义')
    expect(screen.getByLabelText('工作流名称')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('新建保存：dispatch workflow.create，并用返回值选中新建项', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发')])
    const created = wf('w2', '新建流', 1)
    handleDispatch((command) => {
      if (command.type === 'workflow.create') {
        kernel.setView('workflows.all', undefined, [wf('w1', '研发'), created])
        return { facts: [], value: created }
      }
      return { facts: [], value: null }
    })
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    await user.type(screen.getByLabelText('工作流名称'), '新建流')
    await user.click(screen.getByRole('button', { name: '保存工作流' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'workflow.create',
      input: { name: '新建流' },
    })
    // 保存后选中新建项：新行带「当前」
    const createdRow = await screen.findByRole('button', { name: /新建流/ })
    expect(within(createdRow).getByText('当前')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('编辑保存：dispatch workflow.update；失败保持弹窗并展示错误', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发')])
    handleDispatch(() => Promise.reject(new Error('update-fail')))
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.clear(screen.getByLabelText('工作流名称'))
    await user.type(screen.getByLabelText('工作流名称'), '研发2')
    await user.click(screen.getByRole('button', { name: '保存工作流' }))

    expect(await screen.findByText('update-fail')).toBeInTheDocument()
    expect(kernel.dispatched[0]).toMatchObject({ type: 'workflow.update', id: 'w1' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('工作流视图读取失败展示错误', async () => {
    kernel.failView('workflows.all', undefined, 'wf-down')
    render(<WorkflowManager />)
    expect(await screen.findByText('wf-down')).toBeInTheDocument()
  })

  it('编辑弹窗按 Esc 关闭：走 Dialog onClose，不 dispatch', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发')])
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(kernel.dispatched).toHaveLength(0)
  })
})
