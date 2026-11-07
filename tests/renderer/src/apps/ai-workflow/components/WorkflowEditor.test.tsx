import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    // 左侧点阶段 2，右侧才展开它的详情
    await user.click(screen.getByRole('button', { name: '阶段2' }))
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

    // 再加一个阶段后删除，覆盖删除分支（新建阶段会自动展开，删除的就是它）
    await user.click(screen.getByRole('button', { name: '添加阶段' }))
    await user.click(screen.getByRole('button', { name: '删除' }))

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
    // 第二段详情要点左侧才展开
    fireEvent.click(screen.getByRole('button', { name: '阶段2' }))
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

    // 左侧列表：序号 + 名称，用来断言重排结果
    const order = (): (string | null)[] =>
      ['阶段1', '阶段2', '阶段3'].map(
        (name) => screen.getByRole('button', { name }).textContent ?? null,
      )

    // 选中第三个阶段（C）再上移：顺序变为 A、C、B，选中跟着 C 走
    await user.click(screen.getByRole('button', { name: '阶段3' }))
    await user.click(screen.getByRole('button', { name: '阶段3上移' }))
    expect(order()).toEqual(['1A', '2C', '3B'])
    expect(screen.getByLabelText('阶段2名称')).toHaveValue('C')
    // 上移 / 下移就在左侧列表行尾：首阶段的上移、末阶段的下移禁用
    expect(screen.getByRole('button', { name: '阶段1上移' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '阶段3下移' })).toBeDisabled()

    // 再下移一次回到原位：A、B、C
    await user.click(screen.getByRole('button', { name: '阶段2下移' }))
    expect(order()).toEqual(['1A', '2B', '3C'])

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

  it('阶段「要干什么」：按阶段独立编辑，切换阶段不丢（M9）', async () => {
    const stageOf = (id: string, name: string, position: number): WorkflowStage => ({
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
    })
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '两段',
      description: '',
      createdAt: 't',
      stages: [
        { ...stageOf('s0', '方案', 0), instructions: '读需求，出方案' },
        stageOf('s1', '实现', 1),
      ],
    }
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 已有说明回显；没有说明的阶段是空串
    expect(screen.getByLabelText('阶段1要干什么')).toHaveValue('读需求，出方案')
    await user.clear(screen.getByLabelText('阶段1要干什么'))
    await user.type(screen.getByLabelText('阶段1要干什么'), '读需求，列改动文件')

    await user.click(screen.getByRole('button', { name: '阶段2' }))
    expect(screen.getByLabelText('阶段2要干什么')).toHaveValue('')
    await user.type(screen.getByLabelText('阶段2要干什么'), '按方案实现并自测')

    // 回到阶段 1：草稿仍在
    await user.click(screen.getByRole('button', { name: '阶段1' }))
    expect(screen.getByLabelText('阶段1要干什么')).toHaveValue('读需求，列改动文件')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[0]).toMatchObject({ id: 's0', instructions: '读需求，列改动文件' })
    expect(draft.stages[1]).toMatchObject({ id: 's1', instructions: '按方案实现并自测' })
  })

  it('移动别的阶段：展开项不跳，被换位时才跟着换（左侧行内上移 / 下移）', async () => {
    const stageOf = (id: string, name: string, position: number): WorkflowStage => ({
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
    })
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '三段',
      description: '',
      createdAt: 't',
      stages: [stageOf('s0', 'A', 0), stageOf('s1', 'B', 1), stageOf('s2', 'C', 2)],
    }
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)

    const order = (): (string | null)[] =>
      ['阶段1', '阶段2', '阶段3'].map(
        (name) => screen.getByRole('button', { name }).textContent ?? null,
      )

    // 展开 A，把 C 上移：A 仍在展开，C 进到第 2 行
    await user.click(screen.getByRole('button', { name: '阶段1' }))
    await user.click(screen.getByRole('button', { name: '阶段3上移' }))
    expect(order()).toEqual(['1A', '2C', '3B'])
    expect(screen.getByLabelText('阶段1名称')).toHaveValue('A')

    // 展开 B（现在第 3 行），把 C 下移回去：B 被换到第 2 行，展开项跟着走
    await user.click(screen.getByRole('button', { name: '阶段3' }))
    expect(screen.getByLabelText('阶段3名称')).toHaveValue('B')
    await user.click(screen.getByRole('button', { name: '阶段2下移' }))
    expect(order()).toEqual(['1A', '2B', '3C'])
    expect(screen.getByLabelText('阶段2名称')).toHaveValue('B')
  })

  it('删掉唯一阶段后右侧显示空态，仍可再添加阶段', async () => {
    const user = userEvent.setup()
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    render(<WorkflowEditor workflow={null} onSave={vi.fn()} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(screen.getByText('还没有阶段，先「添加阶段」')).toBeInTheDocument()
    expect(screen.queryByLabelText('阶段1要干什么')).toBeNull()

    await user.click(screen.getByRole('button', { name: '添加阶段' }))
    expect(screen.getByLabelText('阶段1要干什么')).toBeInTheDocument()
  })

  it('上移阶段：目标指向正被让位的相邻阶段时，目标下标 +1（重映射上移方向）', async () => {
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
        // A 的「完成后进入」指向 B（下标 1）
        stageOf('s0', 'A', 0, { onCompleteStageId: 's1' }),
        stageOf('s1', 'B', 1),
        stageOf('s2', 'C', 2),
      ],
    }
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // C 上移越过 B：B 从下标 1 被挤到 2，A 指向 B 的下标要同步 +1
    await user.click(screen.getByRole('button', { name: '阶段3上移' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages.map((s) => s.name)).toEqual(['A', 'C', 'B'])
    expect(draft.stages[0]).toMatchObject({ name: 'A', onCompleteIndex: 2 })
  })

  it('下移阶段：目标指向正被让位的相邻阶段时，目标下标 -1（重映射下移方向）', async () => {
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
        stageOf('s1', 'B', 1),
        // C 的「完成后进入」指向 B（下标 1）
        stageOf('s2', 'C', 2, { onCompleteStageId: 's1' }),
      ],
    }
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // A 下移越过 B：B 从下标 1 被挤到 0，C 指向 B 的下标要同步 -1
    await user.click(screen.getByRole('button', { name: '阶段1下移' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages.map((s) => s.name)).toEqual(['B', 'A', 'C'])
    const cStage = draft.stages.find((s) => s.name === 'C')
    expect(cStage).toMatchObject({ name: 'C', onCompleteIndex: 0 })
  })

  it('子任务三字段可清空回默认：选空项落 null', async () => {
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '两段',
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
          entryMode: 'none',
          agentId: null,
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
      ],
    }
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 先设为非空再清空：每次选空项都应落回 null（清空即回默认）
    await choose(user, '阶段1子任务落点阶段', '进行中')
    await choose(user, '阶段1子任务落点阶段', '跟随当前阶段')
    await choose(user, '阶段1子任务完成后', '仅通知')
    await choose(user, '阶段1子任务完成后', '按阶段推断')
    await choose(user, '阶段1允许拆子任务', '禁止')
    await choose(user, '阶段1允许拆子任务', '允许')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[0]).toMatchObject({
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
    })
  }, 30_000)
})
