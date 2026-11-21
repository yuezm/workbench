import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Task, WorkflowStage, WorkflowWithStages } from '@workbench/protocol/entities'
import { ArchivedTasksDialog } from '@workbench/client-app-ai-workflow/components/ArchivedTasksDialog'

function stage(
  id: string,
  name: string,
  position: number,
  builtin: WorkflowStage['builtin'] = null,
): WorkflowStage {
  return {
    id,
    workflowId: 'w1',
    name,
    position,
    entryMode: 'none',
    agentId: null,
    builtin,
    exits: {},
    judge: null,
    handoffs: [],
  }
}

const wf: WorkflowWithStages = {
  id: 'w1',
  name: '研发',
  description: '',
  createdAt: 't',
  stages: [
    stage('s0', '待办', 0),
    stage('s1', '审核', 1),
    stage('s2', '已完成', 2, 'done'),
    stage('s3', '已取消', 3, 'cancelled'),
  ],
}

function task(id: string, title: string, updatedAt: string, currentStageId = 's1'): Task {
  return {
    id,
    title,
    description: '',
    workflowId: 'w1',
    projectId: 'p1',
    currentStageId,
    archivedAt: 'archived-at',
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
  it('按最近更新倒序列出已归档任务，带阶段名与计数', () => {
    render(
      <ArchivedTasksDialog
        workflow={wf}
        tasks={[
          task('t1', '早归档的', '2026-11-01T10:00:00.000Z'),
          task('t2', '晚归档的', '2026-11-08T10:00:00.000Z', 's0'),
        ]}
        onOpenTask={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('工作流「研发」已归档 2 个任务')
    const rows = within(screen.getByLabelText('归档任务列表')).getAllByRole('button')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('晚归档的')
    expect(rows[0]).toHaveTextContent('待办')
    expect(rows[1]).toHaveTextContent('早归档的')
    expect(rows[1]).toHaveTextContent('审核')
  })

  it('徽标按阶段类别渲染：归档 ≠ 完成（M53）', () => {
    render(
      <ArchivedTasksDialog
        workflow={wf}
        tasks={[
          task('t1', '做完了的', '2026-11-08T10:00:00.000Z', 's2'),
          task('t2', '取消掉的', '2026-11-07T10:00:00.000Z', 's3'),
          task('t3', '没做完就不跟了', '2026-11-06T10:00:00.000Z', 's1'),
        ]}
        onOpenTask={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const rows = within(screen.getByLabelText('归档任务列表')).getAllByRole('button')
    const phaseOf = (row: HTMLElement): string | null =>
      row.querySelector('[data-task-phase]')?.getAttribute('data-task-phase') ?? null
    expect(phaseOf(rows[0])).toBe('finished')
    expect(rows[0]).toHaveTextContent('已完成')
    expect(phaseOf(rows[1])).toBe('cancelled')
    expect(rows[1]).toHaveTextContent('已取消')
    expect(phaseOf(rows[2])).toBe('active')
    expect(rows[2]).toHaveTextContent('进行中')
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
