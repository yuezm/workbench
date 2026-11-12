import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  Task,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../../../../src/protocol/entities'
import { ArchivedTasksDialog } from '../../../../../../src/renderer/src/apps/ai-workflow/components/ArchivedTasksDialog'

function stage(id: string, name: string, position: number): WorkflowStage {
  return {
    id,
    workflowId: 'w1',
    name,
    position,
    entryMode: 'none',
    agentId: null,
    onCompleteStageId: null,
    onRejectStageId: null,
    handoffs: [],
  }
}

const wf: WorkflowWithStages = {
  id: 'w1',
  name: '研发',
  description: '',
  createdAt: 't',
  stages: [stage('s0', '待办', 0), stage('s1', '审核', 1)],
}

function task(id: string, title: string, updatedAt: string, currentStageId = 's1'): Task {
  return {
    id,
    title,
    description: '',
    workflowId: 'w1',
    projectId: 'p1',
    currentStageId,
    status: 'completed',
    origin: 'manual',
    ruleId: null,
    externalRef: null,
    labels: [],
    threadId: null,
    parentTaskId: null,
    handoffFromTaskId: null,
    handoffFromStageId: null,
    handoffFromRunId: null,
    createdAt: 't',
    updatedAt,
  }
}

describe('ArchivedTasksDialog', () => {
  it('按最近更新倒序列出已完成任务，带阶段名与计数', () => {
    render(
      <ArchivedTasksDialog
        workflow={wf}
        tasks={[
          task('t1', '早完成的', '2026-11-01T10:00:00.000Z'),
          task('t2', '晚完成的', '2026-11-08T10:00:00.000Z', 's0'),
        ]}
        onOpenTask={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('工作流「研发」已完成 2 个任务')
    const rows = within(screen.getByLabelText('归档任务列表')).getAllByRole('button')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('晚完成的')
    expect(rows[0]).toHaveTextContent('待办')
    expect(rows[1]).toHaveTextContent('早完成的')
    expect(rows[1]).toHaveTextContent('审核')
  })

  it('点一行进任务详情并关掉弹窗', async () => {
    const onOpenTask = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <ArchivedTasksDialog
        workflow={wf}
        tasks={[task('t1', '要回看的任务', '2026-11-01T10:00:00.000Z')]}
        onOpenTask={onOpenTask}
        onClose={onClose}
      />,
    )
    await user.click(screen.getByRole('button', { name: '打开归档任务：要回看的任务' }))
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('没有给打开回调时行只读（禁用）', () => {
    render(
      <ArchivedTasksDialog
        workflow={wf}
        tasks={[task('t1', '只读任务', '2026-11-01T10:00:00.000Z')]}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: '打开归档任务：只读任务' })).toBeDisabled()
  })

  it('空列表给空态，不渲染清单', () => {
    render(<ArchivedTasksDialog workflow={wf} tasks={[]} onOpenTask={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('还没有归档任务。')).toBeInTheDocument()
    expect(screen.queryByLabelText('归档任务列表')).not.toBeInTheDocument()
  })

  it('阶段被删 / 缺失时阶段名退化为未知阶段', () => {
    render(
      <ArchivedTasksDialog
        workflow={wf}
        tasks={[task('t1', '老任务', '2026-11-01T10:00:00.000Z', 's-gone')]}
        onOpenTask={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('归档任务列表')).toHaveTextContent('未知阶段')
  })

  it('Esc 与右上角关闭都回调关闭', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(
      <ArchivedTasksDialog
        workflow={wf}
        tasks={[task('t1', '任务', '2026-11-01T10:00:00.000Z')]}
        onOpenTask={vi.fn()}
        onClose={onClose}
      />,
    )
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
