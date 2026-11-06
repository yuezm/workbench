import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Agent,
  WorkflowInput,
  WorkflowStage,
  WorkflowWithStages,
} from '../../../../../../src/protocol/entities'
import { WorkflowEditor } from '../../../../../../src/renderer/src/apps/ai-workflow/components/WorkflowEditor'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

const agent: Agent = {
  id: 'ag1',
  name: 'coder',
  description: '',
  runtimeId: 'r1',
  systemPrompt: '',
  createdAt: 't',
}

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

afterEach(() => {
  stopFakeKernel()
})

/** 选自定义下拉项：先点触发器，再点浮层里的 option */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  combobox: string,
  option: string,
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: combobox }))
  await user.click(await screen.findByRole('option', { name: option }))
}

describe('WorkflowEditor', () => {
  it('新建：填名称、改阶段、加/删阶段、设目标并保存', async () => {
    kernel.setView('agents.all', undefined, [agent])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} onSave={onSave} onCancel={onCancel} />)

    // 智能体清单来自内核视图：等它就绪后再选阶段智能体
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '阶段1进入方式' })).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('combobox', { name: '阶段1进入方式' }))
    await user.click(screen.getByRole('option', { name: '交给智能体' }))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '阶段1智能体' })).toBeInTheDocument(),
    )

    await user.type(screen.getByLabelText('工作流名称'), '研发')
    await user.type(screen.getByLabelText('工作流描述'), 'desc')
    await user.clear(screen.getByLabelText('阶段1名称'))
    await user.type(screen.getByLabelText('阶段1名称'), '待办')

    await user.click(screen.getByRole('combobox', { name: '阶段1智能体' }))
    await user.click(screen.getByRole('option', { name: '选择' }))
    await user.click(screen.getByRole('combobox', { name: '阶段1智能体' }))
    await user.click(screen.getByRole('option', { name: 'coder' }))

    await user.click(screen.getByRole('button', { name: '添加阶段' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2完成后进入' }))
    await user.click(screen.getByRole('option', { name: '待办' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2完成后进入' }))
    await user.click(screen.getByRole('option', { name: '下一阶段' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2完成后进入' }))
    await user.click(screen.getByRole('option', { name: '待办' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2打回退回到' }))
    await user.click(screen.getByRole('option', { name: '待办' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2打回退回到' }))
    await user.click(screen.getByRole('option', { name: '不指定' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2打回退回到' }))
    await user.click(screen.getByRole('option', { name: '待办' }))

    // 再加一个阶段后删除，覆盖删除分支
    await user.click(screen.getByRole('button', { name: '添加阶段' }))
    await user.click(screen.getAllByRole('button', { name: '删除' })[2])

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0]
    expect(draft.name).toBe('研发')
    expect(draft.stages).toHaveLength(2)
    expect(draft.stages[0]).toMatchObject({ name: '待办', entryMode: 'agent', agentId: 'ag1' })
    expect(draft.stages[1]).toMatchObject({ onCompleteIndex: 0, onRejectIndex: 0 })

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalled()
  }, 30_000)

  it('编辑已有工作流：把阶段 id 还原成下标', () => {
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '旧流',
      description: 'd',
      createdAt: 't',
      stages: [
        {
          id: 's0',
          workflowId: 'w',
          name: '待办',
          position: 0,
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: 's1',
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
        {
          id: 's1',
          workflowId: 'w',
          name: '进行中',
          position: 1,
          entryMode: 'user',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: 's0',
          handoffWorkflowId: null,
          handoffStageId: null,
        },
      ],
    }
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('工作流名称')).toHaveValue('旧流')
    expect(screen.getByLabelText('阶段1完成后进入')).toHaveValue('1')
    expect(screen.getByRole('combobox', { name: '阶段1完成后进入' })).toHaveTextContent('进行中')
    expect(screen.getByLabelText('阶段2打回退回到')).toHaveValue('0')
    expect(screen.getByRole('combobox', { name: '阶段2打回退回到' })).toHaveTextContent('待办')
  })

  it('工作流没有描述时描述输入框留空', () => {
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '无描述',
      description: undefined as unknown as string,
      createdAt: 't',
      stages: [],
    }
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('工作流描述')).toHaveValue('')
  })

  it('阶段上/下移：交换位置并同步重映射流转目标下标', async () => {
    const stageOf = (
      id: string,
      name: string,
      position: number,
      extra: Partial<WorkflowStage> = {},
    ): WorkflowStage => ({
      id,
      workflowId: 'w',
      name,
      position,
      entryMode: 'none',
      agentId: null,
      onCompleteStageId: null,
      onRejectStageId: null,
      handoffWorkflowId: null,
      handoffStageId: null,
      ...extra,
    })
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '三段',
      description: '',
      createdAt: 't',
      stages: [
        stageOf('s0', 'A', 0),
        stageOf('s1', 'B', 1, { onCompleteStageId: 's2' }),
        stageOf('s2', 'C', 2, { onRejectStageId: 's0' }),
      ],
    }
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 上移第三个阶段（C）：顺序变为 A、C、B
    await user.click(screen.getByRole('button', { name: '阶段3上移' }))
    expect(screen.getByLabelText('阶段1名称')).toHaveValue('A')
    expect(screen.getByLabelText('阶段2名称')).toHaveValue('C')
    expect(screen.getByLabelText('阶段3名称')).toHaveValue('B')
    // 首阶段的上移、末阶段的下移禁用
    expect(screen.getByRole('button', { name: '阶段1上移' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '阶段3下移' })).toBeDisabled()

    // 再下移一次回到原位：A、B、C
    await user.click(screen.getByRole('button', { name: '阶段2下移' }))
    expect(screen.getByLabelText('阶段2名称')).toHaveValue('B')

    // 再次上移后保存，验证目标下标随重排重映射
    await user.click(screen.getByRole('button', { name: '阶段3上移' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    const bStage = draft.stages.find((s) => s.name === 'B')
    const cStage = draft.stages.find((s) => s.name === 'C')
    // B 的「完成后进入」指向 C：C 从下标 2 移到 1
    expect(bStage?.onCompleteIndex).toBe(1)
    // C 的「打回退回到」指向 A：A 仍在下标 0
    expect(cStage?.onRejectIndex).toBe(0)
  })

  it('新建工作流：交接目标候选为全部工作流，保存回传目标工作流与目标阶段', async () => {
    const other: WorkflowWithStages = {
      id: 'w2',
      name: '写作',
      description: '',
      createdAt: 't',
      stages: [
        {
          id: 'b0',
          workflowId: 'w2',
          name: '草稿',
          position: 0,
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
        {
          id: 'b1',
          workflowId: 'w2',
          name: '发布',
          position: 1,
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
      ],
    }
    kernel.setView('workflows.all', undefined, [other])
    kernel.setView('agents.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('combobox', { name: '阶段1交接目标工作流' }))
    await user.click(await screen.findByRole('option', { name: '写作' }))
    await user.click(screen.getByRole('combobox', { name: '阶段1交接目标阶段' }))
    expect(await screen.findByRole('option', { name: '草稿' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: '发布' }))

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0]
    expect(draft.stages[0]).toMatchObject({ handoffWorkflowId: 'w2', handoffStageId: 'b1' })
  })

  it('编辑已有工作流：回显交接目标、排除自身候选、切换工作流重置阶段、回传阶段 id', async () => {
    const current: WorkflowWithStages = {
      id: 'w1',
      name: '旧流',
      description: '',
      createdAt: 't',
      stages: [
        {
          id: 's0',
          workflowId: 'w1',
          name: '待办',
          position: 0,
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: 'w2',
          handoffStageId: 'b1',
        },
        {
          id: 's1',
          workflowId: 'w1',
          name: '进行中',
          position: 1,
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
      ],
    }
    const target: WorkflowWithStages = {
      id: 'w2',
      name: '写作',
      description: '',
      createdAt: 't',
      stages: [
        {
          id: 'b0',
          workflowId: 'w2',
          name: '草稿',
          position: 0,
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
        {
          id: 'b1',
          workflowId: 'w2',
          name: '发布',
          position: 1,
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
      ],
    }
    const archive: WorkflowWithStages = { ...target, id: 'w3', name: '归档', stages: [] }
    kernel.setView('workflows.all', undefined, [current, target, archive])
    kernel.setView('agents.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={current} onSave={onSave} onCancel={vi.fn()} />)

    expect(await screen.findByRole('combobox', { name: '阶段1交接目标工作流' })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '阶段1交接目标工作流' })).toHaveTextContent(
        '写作',
      ),
    )
    expect(screen.getByRole('combobox', { name: '阶段1交接目标阶段' })).toHaveTextContent('发布')
    expect(screen.queryByRole('combobox', { name: '阶段2交接目标阶段' })).not.toBeInTheDocument()

    // 当前工作流不在候选里；选「不交接」清空后目标阶段选择消失
    await user.click(screen.getByRole('combobox', { name: '阶段1交接目标工作流' }))
    expect(screen.queryByRole('option', { name: '旧流' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: '不交接' }))
    expect(screen.queryByRole('combobox', { name: '阶段1交接目标阶段' })).not.toBeInTheDocument()

    // 换目标工作流后目标阶段重置为「首阶段」；选阶段后可再选回首阶段（可空）
    await user.click(screen.getByRole('combobox', { name: '阶段1交接目标工作流' }))
    await user.click(await screen.findByRole('option', { name: '写作' }))
    expect(screen.getByRole('combobox', { name: '阶段1交接目标阶段' })).toHaveTextContent('首阶段')
    await choose(user, '阶段1交接目标阶段', '发布')
    await choose(user, '阶段1交接目标阶段', '首阶段')
    await choose(user, '阶段1交接目标阶段', '发布')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0]
    expect(draft.stages[0]).toMatchObject({
      id: 's0',
      handoffWorkflowId: 'w2',
      handoffStageId: 'b1',
    })
    expect(draft.stages[1]).toMatchObject({ id: 's1', handoffWorkflowId: null })
  })

  it('交接目标工作流已不在清单：目标阶段候选为空，仍按视图值回显', () => {
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '旧流',
      description: '',
      createdAt: 't',
      stages: [
        {
          id: 's0',
          workflowId: 'w',
          name: '待办',
          position: 0,
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: 'gone',
          handoffStageId: 'gs0',
        },
      ],
    }
    kernel.setView('workflows.all', undefined, [])
    kernel.setView('agents.all', undefined, [])
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)
    // 目标的 id 仍原样回传（不在候选里，下拉按占位文案展示），目标阶段候选为空
    expect(screen.getByRole('combobox', { name: '阶段1交接目标工作流' })).toHaveTextContent(
      '请选择',
    )
    expect(screen.getByRole('combobox', { name: '阶段1交接目标阶段' })).toHaveTextContent('请选择')
  })

  it('子任务三字段：落点阶段 / 完成后动作 / 是否允许拆（M8）', async () => {
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '旧流',
      description: '',
      createdAt: 't',
      stages: [
        {
          id: 's0',
          workflowId: 'w',
          name: '待办',
          position: 0,
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
          subtaskStageId: null,
          onChildrenSettled: null,
          spawnPolicy: null,
        },
        {
          id: 's1',
          workflowId: 'w',
          name: '进行中',
          position: 1,
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
          subtaskStageId: null,
          onChildrenSettled: null,
          spawnPolicy: null,
        },
      ],
    }
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await choose(user, '阶段1子任务落点阶段', '进行中')
    await choose(user, '阶段1子任务完成后', '唤醒父 Agent')
    await choose(user, '阶段1允许拆子任务', '禁止')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[0]).toMatchObject({
      subtaskStageId: 's1',
      onChildrenSettled: 'wake',
      spawnPolicy: 'off',
    })
  }, 30_000)
})
