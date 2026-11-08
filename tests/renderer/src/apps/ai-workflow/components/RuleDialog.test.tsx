import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type {
  Project,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../../../../src/protocol/entities'
import type { AutomationRule } from '../../../../../../src/protocol/rules'
import { RuleDialog } from '../../../../../../src/renderer/src/apps/ai-workflow/components/RuleDialog'

function stage(id: string, workflowId: string, name: string, position: number): WorkflowStage {
  return {
    id,
    workflowId,
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

function wf(id: string, name: string, stageNames: string[]): WorkflowWithStages {
  return {
    id,
    name,
    description: '',
    createdAt: 't',
    stages: stageNames.map((stageName, index) => stage(`${id}-s${index}`, id, stageName, index)),
  }
}

const workflows = [wf('w1', '研发', ['待办', '审核']), wf('w2', '写作', ['草稿'])]

function project(id: string, name: string, path: string): Project {
  return { id, name, path, description: '', createdAt: 't', updatedAt: 't' }
}

const projects = [
  project('p1', '工作台', 'D:\\Codes\\workbench'),
  project('p2', '笔记', 'D:\\Notes'),
]

function blankRule(): AutomationRule {
  return {
    id: 'r-new',
    name: '',
    when: { source: '', types: [] },
    to: { workflowId: '' },
    enabled: true,
  }
}

function dailyRule(): AutomationRule {
  return {
    id: 'r-daily',
    name: '每日早报',
    when: { cron: '0 9 * * *' },
    to: { workflowId: 'w1' },
    prompt: '汇总昨日进展并给出今日计划',
    enabled: false,
  }
}

/** 选自定义下拉项：先点触发器，再点浮层里的 option */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  combobox: string,
  option: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: combobox }))
  await user.click(await screen.findByRole('option', { name: option }))
}

describe('RuleDialog', () => {
  it('空白新建：空名保存就地提示且不提交；取消走 onCancel', async () => {
    const onSubmit = vi.fn((_rule: AutomationRule): Promise<void> => Promise.resolve())
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={workflows}
        projects={projects}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    )

    expect(screen.getByText('新建规则')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('规则名称不能为空')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('填了名称但未选工作流：提示且不提交', async () => {
    const onSubmit = vi.fn((_rule: AutomationRule): Promise<void> => Promise.resolve())
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={workflows}
        projects={projects}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )

    await user.type(screen.getByLabelText('规则名称'), 'Issue 规则')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('请选择目标工作流')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('事件规则：类型/标签按逗号拆分，工作流与阶段收进 to', async () => {
    const onSubmit = vi.fn((_rule: AutomationRule): Promise<void> => Promise.resolve())
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={workflows}
        projects={projects}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )

    await user.type(screen.getByLabelText('规则名称'), 'Issue 规则')
    await user.type(screen.getByLabelText('规则事件来源'), 'github')
    await user.type(screen.getByLabelText('规则事件类型'), 'issues.opened, issues.closed')
    await choose(user, '规则目标工作流', '研发')
    await choose(user, '规则起始阶段', '审核')
    await user.type(screen.getByLabelText('任务标签'), 'bug, p1')
    await user.type(screen.getByLabelText('规则提示词'), '按 Issue 描述推进')
    await user.clear(screen.getByLabelText('并行数'))
    await user.type(screen.getByLabelText('并行数'), '2')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      id: 'r-new',
      name: 'Issue 规则',
      when: { source: 'github', types: ['issues.opened', 'issues.closed'] },
      to: {
        workflowId: 'w1',
        stageId: 'w1-s1',
        task: { titleFrom: 'subject', labels: ['bug', 'p1'] },
        thread: { keyFrom: 'subject', onExisting: 'reuse-task' },
      },
      prompt: '按 Issue 描述推进',
      parallel: 2,
      enabled: true,
    })
  })

  it('高级字段：标题取字/合并策略/线程字段/停用都写回 payload', async () => {
    const onSubmit = vi.fn((_rule: AutomationRule): Promise<void> => Promise.resolve())
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={workflows}
        projects={projects}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )

    await user.type(screen.getByLabelText('规则名称'), '高级规则')
    await choose(user, '规则目标工作流', '研发')
    await choose(user, '任务标题取字', 'summary')
    await choose(user, '合并策略', '按 subject')
    await choose(user, '线程归并键', 'externalRef')
    await choose(user, '线程已有任务时', '新建任务')
    await user.click(screen.getByLabelText('启用规则'))
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: '高级规则',
      to: {
        workflowId: 'w1',
        task: { titleFrom: 'summary' },
        thread: { keyFrom: 'externalRef', onExisting: 'new-task' },
      },
      merge: 'subject',
      enabled: false,
    })
  })

  it('cron 规则：非 5 段提示；合法时只提交 cron 条件并保留提示词', async () => {
    const onSubmit = vi.fn((_rule: AutomationRule): Promise<void> => Promise.resolve())
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={workflows}
        projects={projects}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )

    await user.type(screen.getByLabelText('规则名称'), '每日早报')
    await choose(user, '规则触发方式', '定时')
    await user.type(screen.getByLabelText('cron 表达式'), '0 9 * *')
    await choose(user, '规则目标工作流', '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('cron 需 5 段')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText('cron 表达式'))
    await user.type(screen.getByLabelText('cron 表达式'), '0 9 * * *')
    await user.type(screen.getByLabelText('规则提示词'), '汇总昨日进展并给出今日计划')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: '每日早报',
      when: { cron: '0 9 * * *' },
      to: {
        workflowId: 'w1',
        thread: { keyFrom: 'subject', onExisting: 'reuse-task' },
      },
      prompt: '汇总昨日进展并给出今日计划',
    })
    // cron 规则不带 titleFrom：to.task 整块不出现
    expect(onSubmit.mock.calls[0][0].to.task).toBeUndefined()
  })

  it('并行数越界：前端提示，不提交', async () => {
    const onSubmit = vi.fn((_rule: AutomationRule): Promise<void> => Promise.resolve())
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={workflows}
        projects={projects}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )

    await user.type(screen.getByLabelText('规则名称'), 'x')
    await choose(user, '规则目标工作流', '研发')
    await user.type(screen.getByLabelText('并行数'), '9')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('并行数需为 1–8 的整数')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('换工作流时清掉不属于新工作流的阶段', async () => {
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={workflows}
        projects={projects}
        onSubmit={() => Promise.resolve()}
        onCancel={() => {}}
      />,
    )

    await choose(user, '规则目标工作流', '研发')
    await choose(user, '规则起始阶段', '审核')
    expect(screen.getByRole('combobox', { name: '规则起始阶段' })).toHaveTextContent('审核')

    await choose(user, '规则目标工作流', '写作')
    expect(screen.getByRole('combobox', { name: '规则起始阶段' })).toHaveTextContent('首阶段')
  })

  it('重选当前工作流不清掉已选的起始阶段', async () => {
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={workflows}
        projects={projects}
        onSubmit={() => Promise.resolve()}
        onCancel={() => {}}
      />,
    )

    await choose(user, '规则目标工作流', '研发')
    await choose(user, '规则起始阶段', '审核')
    expect(screen.getByRole('combobox', { name: '规则起始阶段' })).toHaveTextContent('审核')

    // 再次点同一工作流：阶段仍属于它，不应被清空
    await choose(user, '规则目标工作流', '研发')
    expect(screen.getByRole('combobox', { name: '规则起始阶段' })).toHaveTextContent('审核')
  })

  it('新建规则默认选第一个项目，保存写入 to.projectId', async () => {
    const onSubmit = vi.fn((_rule: AutomationRule): Promise<void> => Promise.resolve())
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={workflows}
        projects={projects}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )

    // 新规则默认落在第一个项目：避免一建规则就批量产出没有工作目录的默认目录任务
    expect(screen.getByRole('combobox', { name: '规则目标项目' })).toHaveTextContent('工作台')
    await user.type(screen.getByLabelText('规则名称'), 'Issue 规则')
    await choose(user, '规则目标工作流', '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(onSubmit.mock.calls[0][0].to).toMatchObject({ workflowId: 'w1', projectId: 'p1' })

    // 仍可改选其它项目
    await choose(user, '规则目标项目', '笔记')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(onSubmit.mock.calls[1][0].to).toMatchObject({ projectId: 'p2' })
  })

  it('编辑老规则保持默认目录，不强行改写归属', async () => {
    const onSubmit = vi.fn((_rule: AutomationRule): Promise<void> => Promise.resolve())
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={dailyRule()}
        isNew={false}
        workflows={workflows}
        projects={projects}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )

    // 老规则没有 to.projectId：显示默认目录，保存后仍不带该字段
    expect(screen.getByRole('combobox', { name: '规则目标项目' })).toHaveTextContent('默认目录')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(onSubmit.mock.calls[0][0].to.projectId).toBeUndefined()
  })

  it('一个项目都没有时新建规则显示默认目录，保存不带 projectId', async () => {
    const onSubmit = vi.fn((_rule: AutomationRule): Promise<void> => Promise.resolve())
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={workflows}
        projects={[]}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByRole('combobox', { name: '规则目标项目' })).toHaveTextContent('默认目录')
    await user.type(screen.getByLabelText('规则名称'), 'Issue 规则')
    await choose(user, '规则目标工作流', '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(onSubmit.mock.calls[0][0].to.projectId).toBeUndefined()
  })

  it('编辑回填：现有字段与启用状态还原，取消不改动', async () => {
    const onSubmit = vi.fn((_rule: AutomationRule): Promise<void> => Promise.resolve())
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={dailyRule()}
        isNew={false}
        workflows={workflows}
        projects={projects}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    )

    expect(screen.getByText('编辑规则')).toBeInTheDocument()
    expect(screen.getByLabelText('规则名称')).toHaveValue('每日早报')
    expect(screen.getByRole('combobox', { name: '规则触发方式' })).toHaveTextContent('定时')
    expect(screen.getByLabelText('cron 表达式')).toHaveValue('0 9 * * *')
    expect(screen.getByLabelText('规则提示词')).toHaveValue('汇总昨日进展并给出今日计划')
    expect(screen.getByLabelText('启用规则')).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('后端 reject：文案就地展示，弹窗保持可编辑', async () => {
    const onSubmit = vi.fn((): Promise<void> => Promise.reject(new Error('cron 解析失败')))
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={workflows}
        projects={projects}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    )

    await user.type(screen.getByLabelText('规则名称'), 'x')
    await choose(user, '规则目标工作流', '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('cron 解析失败')).toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  })

  it('没有工作流：提示先建工作流，保存禁用', () => {
    render(
      <RuleDialog
        initial={blankRule()}
        isNew
        workflows={[]}
        projects={projects}
        onSubmit={() => Promise.resolve()}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByText(/先建工作流/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('编辑回填并行数；非 Error 的保存失败按字符串展示', async () => {
    const onSubmit = vi.fn().mockRejectedValue('后端不可用')
    render(
      <RuleDialog
        initial={{ ...dailyRule(), parallel: 2 }}
        isNew={false}
        workflows={workflows}
        projects={projects}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    )

    expect(screen.getByLabelText('并行数')).toHaveValue(2)
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('后端不可用')).toBeInTheDocument()
  })
})
