import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  Project,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../../../../src/protocol/entities'
import { TaskDialog } from '../../../../../../src/renderer/src/apps/ai-workflow/components/TaskDialog'

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
    handoffWorkflowId: null,
    handoffStageId: null,
  }
}

const wf: WorkflowWithStages = {
  id: 'w1',
  name: '研发',
  description: '',
  createdAt: 't',
  stages: [stage('s0', '待办', 0), stage('s1', '进行中', 1)],
}

const project: Project = {
  id: 'p1',
  name: '工作台',
  path: 'D:\\Codes\\workbench',
  description: '',
  createdAt: 't',
  updatedAt: 't',
}

describe('TaskDialog', () => {
  it('填写标题/描述后创建，默认从首阶段开始，并带上所属项目；取消回调', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<TaskDialog workflow={wf} project={project} onSave={onSave} onCancel={onCancel} />)
    expect(screen.getByRole('combobox', { name: '起始阶段' })).toHaveTextContent('待办')

    await user.type(screen.getByLabelText('任务标题'), '做点事')
    await user.type(screen.getByLabelText('任务描述'), '描述')
    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toMatchObject({
      title: '做点事',
      description: '描述',
      workflowId: 'w1',
      stageId: 's0',
      projectId: 'p1',
    })
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('所属项目是只读展示：项目名 + 文件夹路径', () => {
    render(<TaskDialog workflow={wf} project={project} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText('工作台')).toBeInTheDocument()
    expect(screen.getByText('D:\\Codes\\workbench')).toBeInTheDocument()
    // 项目在任务栏选好了，弹窗里没有可改项目的控件
    expect(screen.queryByRole('combobox', { name: '所属项目' })).not.toBeInTheDocument()
  })

  it('可以指定从其它阶段开始', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<TaskDialog workflow={wf} project={project} onSave={onSave} onCancel={vi.fn()} />)
    await user.type(screen.getByLabelText('任务标题'), '从进行中开始')
    await user.click(screen.getByRole('combobox', { name: '起始阶段' }))
    await user.click(await screen.findByRole('option', { name: '进行中' }))
    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toMatchObject({ stageId: 's1', projectId: 'p1' })
  })

  it('标题为空不提交', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(<TaskDialog workflow={wf} project={project} onSave={onSave} onCancel={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('工作流没有阶段时兜底为空起始阶段', () => {
    render(
      <TaskDialog
        workflow={{ ...wf, stages: [] }}
        project={project}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: '起始阶段' })).toHaveTextContent('请选择')
  })

  it('Esc 关闭弹窗', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<TaskDialog workflow={wf} project={project} onSave={vi.fn()} onCancel={onCancel} />)
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
  })

  it('右上角关闭按钮回调取消', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<TaskDialog workflow={wf} project={project} onSave={vi.fn()} onCancel={onCancel} />)
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
