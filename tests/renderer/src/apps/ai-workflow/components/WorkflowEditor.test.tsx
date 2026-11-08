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
      expect(screen.getByRole('combobox', { name: '阶段1类型' })).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('combobox', { name: '阶段1类型' }))
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
    // 新阶段默认「不交接」，只有名称与类型；流转目标要先选成会干活的类型才出现
    await choose(user, '阶段2类型', '交给智能体')
    await choose(user, '阶段2智能体', 'coder')
    await user.click(screen.getByRole('combobox', { name: '阶段2完成后进入' }))
    await user.click(screen.getByRole('option', { name: '待办' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2完成后进入' }))
    await user.click(screen.getByRole('option', { name: '下一阶段' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2完成后进入' }))
    await user.click(screen.getByRole('option', { name: '待办' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2出错时进入' }))
    await user.click(screen.getByRole('option', { name: '待办' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2出错时进入' }))
    await user.click(screen.getByRole('option', { name: '不指定' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2出错时进入' }))
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
          entryMode: 'agent',
          agentId: 'ag1',
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
          entryMode: 'agent',
          agentId: 'ag1',
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
    expect(screen.getByLabelText('阶段2出错时进入')).toHaveValue('0')
    expect(screen.getByRole('combobox', { name: '阶段2出错时进入' })).toHaveTextContent('待办')
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
      entryMode: 'agent',
      agentId: 'ag1',
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
          entryMode: 'agent',
          agentId: 'ag1',
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
          entryMode: 'agent',
          agentId: 'ag1',
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

    // 新建阶段的默认类型是「不交接」，交接入口要先选成会干活的类型
    await user.type(screen.getByLabelText('工作流名称'), '交接流')
    await choose(user, '阶段1类型', '交给智能体')
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
          entryMode: 'agent',
          agentId: 'ag1',
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
          entryMode: 'agent',
          agentId: 'ag1',
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
          entryMode: 'agent',
          agentId: 'ag1',
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
          entryMode: 'agent',
          agentId: 'ag1',
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
          entryMode: 'agent',
          agentId: 'ag1',
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
      entryMode: 'agent',
      agentId: 'ag1',
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
      entryMode: 'agent',
      agentId: 'ag1',
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
    // 新阶段默认「不交接」：只有名称与类型，要干什么同样不展示
    expect(screen.getByLabelText('阶段1名称')).toBeInTheDocument()
    expect(screen.queryByLabelText('阶段1要干什么')).toBeNull()

    await choose(user, '阶段1类型', '交给智能体')
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
      entryMode: 'agent',
      agentId: 'ag1',
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
      entryMode: 'agent',
      agentId: 'ag1',
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

  it('闸门：切到闸门自动交给智能体，次数与两个去向可编辑（M11）', async () => {
    const stage = (id: string, name: string, position: number): WorkflowStage => ({
      id,
      workflowId: 'w',
      name,
      position,
      entryMode: 'agent',
      agentId: 'ag1',
      onCompleteStageId: null,
      onRejectStageId: null,
      handoffWorkflowId: null,
      handoffStageId: null,
    })
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '研发',
      description: '',
      createdAt: 't',
      stages: [stage('s0', '执行', 0), stage('s1', '自测', 1), stage('s2', '结束', 2)],
    }
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段2' }))
    await choose(user, '阶段2类型', '闸门（判定）')

    // 切到闸门即自动交给智能体，并给出默认 3 次
    expect(screen.getByRole('combobox', { name: '阶段2智能体' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '阶段2闸门次数' })).toHaveTextContent('3 次')

    await choose(user, '阶段2闸门次数', '5 次')
    await choose(user, '阶段2智能体', 'coder')
    await choose(user, '阶段2闸门通过时进入', '结束')
    await choose(user, '阶段2闸门未通过时进入', '执行')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[1]).toMatchObject({
      entryMode: 'agent',
      agentId: 'ag1',
      gate: { maxFails: 5, onPassIndex: 2, onFailIndex: 0 },
    })
  }, 30_000)

  it('闸门：已有配置还原成下标，切回普通类型清掉闸门（M11）', async () => {
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '研发',
      description: '',
      createdAt: 't',
      stages: [
        {
          id: 's0',
          workflowId: 'w',
          name: '执行',
          position: 0,
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
        {
          id: 's1',
          workflowId: 'w',
          name: '自测',
          position: 1,
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
          gate: { maxFails: 2, onPassStageId: 's2', onFailStageId: 's0' },
        },
        {
          id: 's2',
          workflowId: 'w',
          name: '结束',
          position: 2,
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
      ],
    }
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段2' }))
    // 还原：类型显示为闸门，两个去向按下标回填
    expect(screen.getByRole('combobox', { name: '阶段2类型' })).toHaveTextContent('闸门（判定）')
    expect(screen.getByRole('combobox', { name: '阶段2闸门次数' })).toHaveTextContent('2 次')
    expect(screen.getByRole('combobox', { name: '阶段2闸门通过时进入' })).toHaveTextContent('结束')
    expect(screen.getByRole('combobox', { name: '阶段2闸门未通过时进入' })).toHaveTextContent(
      '执行',
    )

    // 切回普通类型：闸门字段消失，配置落 null
    await choose(user, '阶段2类型', '交给智能体')
    expect(screen.queryByRole('combobox', { name: '阶段2闸门次数' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[1]).toMatchObject({ entryMode: 'agent', gate: null })
  }, 30_000)

  it('不交接：同样只留名称与类型，保存时把看不见的字段归一', async () => {
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '研发',
      description: '',
      createdAt: 't',
      stages: [
        {
          id: 's0',
          workflowId: 'w',
          name: '实现',
          position: 0,
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteStageId: 's1',
          onRejectStageId: 's1',
          handoffWorkflowId: null,
          handoffStageId: null,
          subtaskStageId: 's1',
          onChildrenSettled: 'notify',
          spawnPolicy: 'off',
          instructions: '按方案实现',
        },
        {
          id: 's1',
          workflowId: 'w',
          name: '收尾',
          position: 1,
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
      ],
    }
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await choose(user, '阶段1类型', '不交接')

    for (const label of [
      '阶段1智能体',
      '阶段1完成后进入',
      '阶段1出错时进入',
      '阶段1闸门次数',
      '阶段1交接目标工作流',
      '阶段1子任务落点阶段',
      '阶段1子任务完成后',
      '阶段1允许拆子任务',
    ]) {
      expect(screen.queryByRole('combobox', { name: label })).not.toBeInTheDocument()
    }
    expect(screen.queryByLabelText('阶段1要干什么')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[0]).toEqual({
      id: 's0',
      name: '实现',
      entryMode: 'none',
      agentId: null,
      onCompleteIndex: null,
      onRejectIndex: null,
      handoffWorkflowId: null,
      handoffStageId: null,
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
      instructions: '按方案实现',
      gate: null,
    })
  }, 30_000)

  it('交给用户：只留名称与类型，保存时把看不见的字段归一', async () => {
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '研发',
      description: '',
      createdAt: 't',
      stages: [
        {
          id: 's0',
          workflowId: 'w',
          name: '实现',
          position: 0,
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteStageId: 's1',
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
          subtaskStageId: 's1',
          onChildrenSettled: 'wake',
          spawnPolicy: 'off',
          instructions: '按方案实现',
        },
        {
          id: 's1',
          workflowId: 'w',
          name: '收尾',
          position: 1,
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
      ],
    }
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await choose(user, '阶段1类型', '交给用户')

    // 除名称与类型外一律不展示
    expect(screen.getByLabelText('阶段1名称')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '阶段1类型' })).toHaveTextContent('交给用户')
    for (const label of [
      '阶段1智能体',
      '阶段1完成后进入',
      '阶段1出错时进入',
      '阶段1闸门次数',
      '阶段1交接目标工作流',
      '阶段1子任务落点阶段',
      '阶段1子任务完成后',
      '阶段1允许拆子任务',
    ]) {
      expect(screen.queryByRole('combobox', { name: label })).not.toBeInTheDocument()
    }
    expect(screen.queryByLabelText('阶段1要干什么')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[0]).toEqual({
      id: 's0',
      name: '实现',
      entryMode: 'user',
      agentId: null,
      onCompleteIndex: null,
      onRejectIndex: null,
      handoffWorkflowId: null,
      handoffStageId: null,
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
      // 提示词资料段没有副作用，原文保留，切回智能体还能用
      instructions: '按方案实现',
      gate: null,
    })
  }, 30_000)

  it('闸门：不展示交接与子任务，保存时把这些看不见的字段归一', async () => {
    const existing: WorkflowWithStages = {
      id: 'w',
      name: '研发',
      description: '',
      createdAt: 't',
      stages: [
        {
          id: 's0',
          workflowId: 'w',
          name: '实现',
          position: 0,
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteStageId: 's1',
          onRejectStageId: 's1',
          handoffWorkflowId: null,
          handoffStageId: null,
          subtaskStageId: 's1',
          onChildrenSettled: 'wake',
          spawnPolicy: 'off',
          instructions: '跑一遍验收命令',
          gate: { maxFails: 3, onPassStageId: 's1', onFailStageId: 's0' },
        },
        {
          id: 's1',
          workflowId: 'w',
          name: '收尾',
          position: 1,
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteStageId: null,
          onRejectStageId: null,
          handoffWorkflowId: null,
          handoffStageId: null,
        },
      ],
    }
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 闸门只判定：次数与两个去向在，交接与子任务不在
    expect(screen.getByRole('combobox', { name: '阶段1闸门次数' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '阶段1闸门通过时进入' })).toBeInTheDocument()
    expect(screen.getByLabelText('阶段1要干什么')).toHaveValue('跑一遍验收命令')
    for (const label of [
      '阶段1交接目标工作流',
      '阶段1子任务落点阶段',
      '阶段1子任务完成后',
      '阶段1允许拆子任务',
      '阶段1完成后进入',
      '阶段1出错时进入',
    ]) {
      expect(screen.queryByRole('combobox', { name: label })).not.toBeInTheDocument()
    }

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[0]).toMatchObject({
      entryMode: 'agent',
      agentId: 'ag1',
      gate: { maxFails: 3, onPassIndex: 1, onFailIndex: 0 },
      instructions: '跑一遍验收命令',
    })
    // 闸门不做交接、不拆子任务；「完成 / 出错」两个去向也不在面板上，留着会改掉默认通过落点
    expect(draft.stages[0]).toMatchObject({
      onCompleteIndex: null,
      onRejectIndex: null,
      handoffWorkflowId: null,
      handoffStageId: null,
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
    })
  }, 30_000)
})

/** 造一条已存在的工作流：阶段名与流转都按下标给，省得每例重复写 id */
function workflowWith(
  stageNames: string[],
  targets: Record<number, { onComplete?: number; onReject?: number }> = {},
): WorkflowWithStages {
  return {
    id: 'w',
    name: '研发',
    description: '',
    createdAt: 't',
    stages: stageNames.map((name, index) => ({
      id: `s${index}`,
      workflowId: 'w',
      name,
      position: index,
      entryMode: 'agent',
      agentId: 'ag1',
      onCompleteStageId:
        targets[index]?.onComplete === undefined ? null : `s${targets[index].onComplete}`,
      onRejectStageId:
        targets[index]?.onReject === undefined ? null : `s${targets[index].onReject}`,
      handoffWorkflowId: null,
      handoffStageId: null,
    })),
  }
}

describe('WorkflowEditor 校验与失败反馈', () => {
  beforeEach(() => {
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [])
  })

  it('名称为空点保存：不发命令，名称下方就地给必填提示', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('工作流名称必填')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
    // 必填标识：名称与阶段名称各一个红星（读屏文案「必填」）
    expect(screen.getAllByText('必填')).toHaveLength(2)
    // 只填空格也算空
    await user.type(screen.getByLabelText('工作流名称'), '   ')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('阶段名称为空：拦住保存，并把右侧展开拉到出错的阶段', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <WorkflowEditor
        workflow={workflowWith(['待办', '进行中'])}
        onSave={onSave}
        onCancel={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: '阶段2' }))
    await user.clear(screen.getByLabelText('阶段2名称'))
    // 展开回阶段 1：保存时应自动跳回出错的阶段 2
    await user.click(screen.getByRole('button', { name: '阶段1' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('阶段名称必填')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '阶段2' })).toHaveAttribute('aria-current', 'true')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('阶段删光后保存：说明至少要有一个阶段', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} onSave={onSave} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('工作流名称'), '空流')
    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('工作流至少要有一个阶段')).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('流转目标悬空：拦住保存并说明要重新选', async () => {
    const stale: WorkflowInput = {
      name: '旧流',
      description: '',
      stages: [
        {
          name: '待办',
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteIndex: 5,
          onRejectIndex: null,
          handoffWorkflowId: null,
          handoffStageId: null,
          subtaskStageId: null,
          onChildrenSettled: null,
          spawnPolicy: null,
          instructions: '',
          gate: null,
        },
      ],
    }
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} initial={stale} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText(/的流转目标已不在阶段列表里/)).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('保存失败：就地展示原因、草稿不丢、按钮恢复可点', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('磁盘写不进去'))
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} onSave={onSave} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('工作流名称'), '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('保存失败：磁盘写不进去')).toBeInTheDocument()
    expect(screen.getByLabelText('工作流名称')).toHaveValue('研发')
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  })

  it('保存提进行中：按钮文案交代原因，且不接受第二次点击', async () => {
    const onSave = vi.fn(() => new Promise<void>(() => {}))
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} onSave={onSave} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('工作流名称'), '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))

    const saving = await screen.findByRole('button', { name: '保存中…' })
    expect(saving).toBeDisabled()
    await user.click(saving)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('保存前 trim：名称两端空格不落库', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} onSave={onSave} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('工作流名称'), '  研发  ')
    await user.clear(screen.getByLabelText('阶段1名称'))
    await user.type(screen.getByLabelText('阶段1名称'), '  待办  ')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.name).toBe('研发')
    expect(draft.stages[0].name).toBe('待办')
  })

  it('删除中间阶段：后面的流转下标跟着前移，不会静默指错', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    const existing = workflowWith(['A', 'B', 'C'], {
      0: { onComplete: 2 },
      1: { onComplete: 2 },
    })
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 删掉 B：C 从下标 2 前移到 1，A 的「完成后进入」要跟着改
    await user.click(screen.getByRole('button', { name: '阶段2' }))
    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages.map((stage) => stage.name)).toEqual(['A', 'C'])
    expect(draft.stages[0].onCompleteIndex).toBe(1)
  })
})
