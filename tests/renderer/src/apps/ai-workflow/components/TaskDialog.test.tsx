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

const DEFAULT_PATH = 'C:\\Users\\me\\.workbench'

describe('TaskDialog', () => {
  it('填写标题/描述后创建，默认从首阶段开始，并带上所属项目；取消回调', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={onCancel}
      />,
    )
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
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('工作台')).toBeInTheDocument()
    expect(screen.getByText('D:\\Codes\\workbench')).toBeInTheDocument()
    // 项目在工作台顶层选好了，弹窗里没有可改项目的控件
    expect(screen.queryByRole('combobox', { name: '所属项目' })).not.toBeInTheDocument()
  })

  it('默认目录：展示默认目录与宿主路径，创建时 projectId 传 null', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <TaskDialog workflow={wf} defaultPath={DEFAULT_PATH} onSave={onSave} onCancel={vi.fn()} />,
    )
    const row = screen.getByLabelText('所属项目')
    expect(row).toHaveTextContent('默认目录')
    expect(row).toHaveTextContent(DEFAULT_PATH)

    await user.type(screen.getByLabelText('任务标题'), '落在默认目录')
    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toMatchObject({ projectId: null })
  })

  it('默认目录路径未知时给兜底文案', () => {
    render(<TaskDialog workflow={wf} defaultPath="" onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('所属项目')).toHaveTextContent('未配置项目时的工作目录')
  })

  it('可以指定从其它阶段开始', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    await user.type(screen.getByLabelText('任务标题'), '从进行中开始')
    await user.click(screen.getByRole('combobox', { name: '起始阶段' }))
    await user.click(await screen.findByRole('option', { name: '进行中' }))
    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toMatchObject({ stageId: 's1', projectId: 'p1' })
  })

  it('标题为空：就地给出必填错误并聚焦标题，不提交', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(onSave).not.toHaveBeenCalled()
    // 反馈必须可见：不是「点了没反应」
    expect(screen.getByRole('alert')).toHaveTextContent('任务标题必填')
    const input = screen.getByLabelText('任务标题')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveFocus()
  })

  it('标题与描述带上协议上限：超长在输入阶段就挡住', () => {
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('任务标题')).toHaveAttribute('maxLength', '200')
    expect(screen.getByLabelText('任务描述')).toHaveAttribute('maxLength', '2000')
  })

  it('必填标识常驻：任务标题带星号与读屏说明', () => {
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('*')).toBeInTheDocument()
    expect(screen.getByText('必填')).toBeInTheDocument()
  })

  it('改了标题就撤掉必填错误', async () => {
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.type(screen.getByLabelText('任务标题'), 'a')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('任务标题')).toHaveAttribute('aria-invalid', 'false')
  })

  it('标题与描述提交前去首尾空白', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    await user.type(screen.getByLabelText('任务标题'), '  带空白  ')
    await user.type(screen.getByLabelText('任务描述'), '  背景  ')
    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: '带空白', description: '背景' })
  })

  it('命令被拒：错误留在弹窗里（role=alert），输入不丢', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('工作流不存在: w1'))
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    await user.type(screen.getByLabelText('任务标题'), '会失败')
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('工作流不存在: w1')
    expect(screen.getByLabelText('任务标题')).toHaveValue('会失败')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('命令被拒为非 Error 时按字符串展示', async () => {
    const onSave = vi.fn().mockRejectedValue('纯文本失败')
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    await user.type(screen.getByLabelText('任务标题'), 'x')
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('纯文本失败')
  })

  it('工作流没有阶段时兜底为空起始阶段', () => {
    render(
      <TaskDialog
        workflow={{ ...wf, stages: [] }}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: '起始阶段' })).toHaveTextContent('请选择')
  })

  it('Esc 关闭弹窗', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={vi.fn()}
        onCancel={onCancel}
      />,
    )
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalled()
  })

  it('右上角关闭按钮回调取消', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflow={wf}
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={vi.fn()}
        onCancel={onCancel}
      />,
    )
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onCancel).toHaveBeenCalled()
  })
})
