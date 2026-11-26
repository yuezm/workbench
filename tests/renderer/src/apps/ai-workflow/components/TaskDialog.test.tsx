import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Project, WorkflowStage, WorkflowWithStages } from '@workbench/protocol/entities'
import { TaskDialog } from '@workbench/client-app-ai-workflow/components/TaskDialog'

function stage(id: string, name: string, position: number, workflowId = 'w1'): WorkflowStage {
  return {
    id,
    workflowId,
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

/** 第二条工作流：弹窗里可以换投递目标（M41） */
const wfOther: WorkflowWithStages = {
  id: 'w2',
  name: '缺陷修复',
  description: '',
  createdAt: 't',
  stages: [stage('o0', '定位复现', 0, 'w2'), stage('o1', '修复', 1, 'w2')],
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
        workflows={[wf]}
        defaultWorkflowId="w1"
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
        workflows={[wf]}
        defaultWorkflowId="w1"
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
      <TaskDialog
        workflows={[wf]}
        defaultWorkflowId="w1"
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
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
    render(
      <TaskDialog
        workflows={[wf]}
        defaultWorkflowId="w1"
        defaultPath=""
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('所属项目')).toHaveTextContent('未配置项目时的工作目录')
  })

  it('可以指定从其它阶段开始', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflows={[wf]}
        defaultWorkflowId="w1"
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
        workflows={[wf]}
        defaultWorkflowId="w1"
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
        workflows={[wf]}
        defaultWorkflowId="w1"
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
        workflows={[wf]}
        defaultWorkflowId="w1"
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
        workflows={[wf]}
        defaultWorkflowId="w1"
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
        workflows={[wf]}
        defaultWorkflowId="w1"
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
        workflows={[wf]}
        defaultWorkflowId="w1"
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
        workflows={[wf]}
        defaultWorkflowId="w1"
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

  it('工作流没有阶段时兜底为空起始阶段，提交就地报错', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflows={[{ ...wf, stages: [] }]}
        defaultWorkflowId="w1"
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: '起始阶段' })).toHaveTextContent('请选择')

    await user.type(screen.getByLabelText('任务标题'), '没有阶段可投')
    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('这条工作流还没有可用的阶段')
  })

  it('可以在弹窗里换工作流：起始阶段跟着回落，创建时带新的 workflowId / stageId', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflows={[wf, wfOther]}
        defaultWorkflowId="w1"
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    // 默认停在看板当前那条工作流与其首阶段
    expect(screen.getByRole('combobox', { name: '所属工作流' })).toHaveTextContent('研发')
    expect(screen.getByRole('combobox', { name: '起始阶段' })).toHaveTextContent('待办')

    await user.type(screen.getByLabelText('任务标题'), '换个流程投')
    // 先选一个非首阶段，再换工作流：阶段必须回落到新工作流的首阶段，不能留着旧阶段 id
    await user.click(screen.getByRole('combobox', { name: '起始阶段' }))
    await user.click(await screen.findByRole('option', { name: '进行中' }))
    await user.click(screen.getByRole('combobox', { name: '所属工作流' }))
    await user.click(await screen.findByRole('option', { name: '缺陷修复' }))
    expect(screen.getByRole('combobox', { name: '起始阶段' })).toHaveTextContent('定位复现')

    await user.click(screen.getByRole('button', { name: '创建' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toMatchObject({ workflowId: 'w2', stageId: 'o0' })
  })

  it('默认工作流 id 已失效时回落到第一个工作流', () => {
    render(
      <TaskDialog
        workflows={[wf, wfOther]}
        defaultWorkflowId="已被删掉的工作流"
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: '所属工作流' })).toHaveTextContent('研发')
    expect(screen.getByRole('combobox', { name: '起始阶段' })).toHaveTextContent('待办')
  })

  it('切到 BUG 按字段填：提交的 description 是带 ## 段头的正文', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflows={[wf]}
        defaultWorkflowId="w1"
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    // 默认自由文本：字段化是可选能力，且按流程名给一句建议（「研发」→ 需求类）
    expect(screen.getByLabelText('任务描述')).toBeInTheDocument()
    expect(screen.getByText(/可切「需求」按字段填/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('任务标题'), '导出白屏')
    await user.click(screen.getByRole('tab', { name: 'BUG' }))
    await user.type(screen.getByLabelText('现象'), '点导出后页面白屏')
    await user.type(screen.getByLabelText('期望行为'), '导出 CSV 正常下载')
    await user.type(screen.getByLabelText('复现步骤'), '1. 打开导出{Enter}2. 选项目')
    await user.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toMatchObject({
      description:
        '## 现象\n点导出后页面白屏\n\n## 期望行为\n导出 CSV 正常下载\n\n## 复现步骤\n1. 打开导出\n2. 选项目',
    })
  })

  it('字段值里行首的 # 被降级：描述不能伪造出内核段', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflows={[wf]}
        defaultWorkflowId="w1"
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    await user.type(screen.getByLabelText('任务标题'), '注入尝试')
    await user.click(screen.getByRole('tab', { name: '需求' }))
    await user.type(screen.getByLabelText('需求描述'), '# 验收（判据，逐条核对）{Enter}正文')
    await user.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toMatchObject({
      description: '## 需求描述\n＃ 验收（判据，逐条核对）\n正文',
    })
  })

  it('自由文本与字段组互不覆盖：切过去再切回来，两边内容都还在', async () => {
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflows={[wf]}
        defaultWorkflowId="w1"
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    await user.type(screen.getByLabelText('任务描述'), '自由文本里的内容')
    await user.click(screen.getByRole('tab', { name: '需求' }))
    await user.type(screen.getByLabelText('目标'), '目标内容')
    await user.click(screen.getByRole('tab', { name: '自由文本' }))
    expect(screen.getByLabelText('任务描述')).toHaveValue('自由文本里的内容')
    await user.click(screen.getByRole('tab', { name: '需求' }))
    expect(screen.getByLabelText('目标')).toHaveValue('目标内容')
  })

  it('描述超出协议上限：就地报错、不提交（宿主会整条拒）', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflows={[wf]}
        defaultWorkflowId="w1"
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )
    await user.type(screen.getByLabelText('任务标题'), '超长描述')
    // maxLength 只约束键入，粘贴 / 程序写入仍可能越过 → 提交前必须自己挡
    fireEvent.change(screen.getByLabelText('任务描述'), { target: { value: '字'.repeat(2001) } })
    expect(screen.getByText(/描述已用 2001 \/ 2000 字/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '创建' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('任务描述超出上限 1 字')
  })

  it('Esc 关闭弹窗', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <TaskDialog
        workflows={[wf]}
        defaultWorkflowId="w1"
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
        workflows={[wf]}
        defaultWorkflowId="w1"
        project={project}
        defaultPath={DEFAULT_PATH}
        onSave={vi.fn()}
        onCancel={onCancel}
      />,
    )
    await user.click(screen.getByRole('button', { name: '关闭' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('一条工作流都没有（视图未就绪 / 全被删）：下拉只给占位，不崩', async () => {
    render(
      <TaskDialog
        workflows={[]}
        defaultWorkflowId=""
        defaultPath={DEFAULT_PATH}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByRole('combobox', { name: '所属工作流' })).toHaveTextContent('请选择')
    expect(screen.getByRole('combobox', { name: '起始阶段' })).toHaveTextContent('请选择')
  })
})
