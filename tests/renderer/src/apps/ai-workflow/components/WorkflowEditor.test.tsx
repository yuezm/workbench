import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Agent,
  BuiltinStageKey,
  EntryMode,
  OnChildrenSettled,
  SpawnPolicy,
  StageInput,
  WorkflowInput,
  WorkflowWithStages,
} from '../../../../../../src/protocol/entities'
import {
  moveStageInList,
  WorkflowEditor,
} from '../../../../../../src/renderer/src/apps/ai-workflow/components/WorkflowEditor'
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

/** 阶段规格：按最终顺序写，流转目标用**阶段名**表达（可读，也不受下标漂移影响） */
interface StageSpec {
  name: string
  builtin?: BuiltinStageKey
  entryMode?: EntryMode
  agentId?: string | null
  onComplete?: string
  onReject?: string
  handoffWorkflowId?: string | null
  handoffStageId?: string | null
  subtaskStageId?: string | null
  onChildrenSettled?: OnChildrenSettled | null
  spawnPolicy?: SpawnPolicy | null
  instructions?: string
  gate?: { maxFails: number; onPass?: string; onFail?: string }
}

/**
 * 造一条既有工作流：`specs` 就是视图里的阶段顺序（内置阶段也写进来）。
 *
 * 默认交给智能体 + 绑定 `ag1`（与旧夹具一致）；内置阶段自己显式给 `entryMode: 'none'`。
 * id 按顺序给 `s0…sN`，因此流转目标用名字写、断言时再按下标核对。
 */
function workflowOf(specs: StageSpec[]): WorkflowWithStages {
  const ids = specs.map((_, index) => `s${index}`)
  const idByName = new Map(specs.map((spec, index) => [spec.name, ids[index]]))
  const resolve = (name: string | undefined): string | null =>
    name === undefined ? null : (idByName.get(name) ?? null)
  return {
    id: 'w',
    name: '研发',
    description: '',
    createdAt: 't',
    stages: specs.map((spec, index) => ({
      id: ids[index],
      workflowId: 'w',
      name: spec.name,
      position: index,
      entryMode: spec.entryMode ?? 'agent',
      builtin: spec.builtin ?? null,
      agentId: spec.agentId === undefined ? 'ag1' : spec.agentId,
      onCompleteStageId: resolve(spec.onComplete),
      onRejectStageId: resolve(spec.onReject),
      handoffWorkflowId: spec.handoffWorkflowId ?? null,
      handoffStageId: spec.handoffStageId ?? null,
      subtaskStageId: spec.subtaskStageId ?? null,
      onChildrenSettled: spec.onChildrenSettled ?? null,
      spawnPolicy: spec.spawnPolicy ?? null,
      instructions: spec.instructions ?? '',
      gate: spec.gate
        ? {
            maxFails: spec.gate.maxFails,
            onPassStageId: resolve(spec.gate.onPass),
            onFailStageId: resolve(spec.gate.onFail),
          }
        : null,
    })),
  }
}

/** 四件套的内置阶段（进入时停下、不派活） */
const BUILTIN_SPECS: StageSpec[] = [
  { name: '待办', builtin: 'todo', entryMode: 'none', agentId: null },
  { name: '已阻塞', builtin: 'blocked', entryMode: 'none', agentId: null },
  { name: '已完成', builtin: 'done', entryMode: 'none', agentId: null },
  { name: '已取消', builtin: 'cancelled', entryMode: 'none', agentId: null },
]

/** 只写自己添加的阶段：内置四件套自动排在两侧（顺序即看板顺序） */
function workflowWith(users: StageSpec[]): WorkflowWithStages {
  return workflowOf([BUILTIN_SPECS[0], ...users, ...BUILTIN_SPECS.slice(1)])
}

/** 保存结果里按名字取阶段（断言流转下标时比记数组位置稳） */
function savedStage(draft: WorkflowInput, name: string): StageInput {
  const stage = draft.stages.find((item) => item.name === name)
  if (stage === undefined) throw new Error(`保存结果里没有阶段：${name}`)
  return stage
}

describe('WorkflowEditor', () => {
  it('新建：填名称、加阶段、改类型与流转目标、删阶段并保存', async () => {
    kernel.setView('agents.all', undefined, [agent])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} onSave={onSave} onCancel={onCancel} />)

    // 空白草稿就是四件套，默认展开「待办」：类型可编辑（名称与位置锁着）
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '阶段1类型' })).toBeInTheDocument(),
    )
    await user.type(screen.getByLabelText('工作流名称'), '研发')
    await user.type(screen.getByLabelText('工作流描述'), 'desc')

    // 新阶段落在「已阻塞」之前并自动展开
    await user.click(screen.getByRole('button', { name: '添加阶段' }))
    expect(screen.getByLabelText('阶段2名称')).toHaveValue('阶段1')
    await choose(user, '阶段2类型', '交给智能体')
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '阶段2智能体' })).toBeInTheDocument(),
    )
    await user.click(screen.getByRole('combobox', { name: '阶段2智能体' }))
    await user.click(screen.getByRole('option', { name: 'coder' }))
    // 选过再清空（回落 null），再选回来
    await user.click(screen.getByRole('combobox', { name: '阶段2智能体' }))
    await user.click(screen.getByRole('option', { name: '选择' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2智能体' }))
    await user.click(screen.getByRole('option', { name: 'coder' }))
    // 流转目标可以指向内置阶段；也能选回默认（下一阶段）
    await user.click(screen.getByRole('combobox', { name: '阶段2完成后进入' }))
    await user.click(screen.getByRole('option', { name: '已完成' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2完成后进入' }))
    await user.click(screen.getByRole('option', { name: '下一阶段' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2完成后进入' }))
    await user.click(screen.getByRole('option', { name: '已完成' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2出错时进入' }))
    await user.click(screen.getByRole('option', { name: '待办' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2出错时进入' }))
    await user.click(screen.getByRole('option', { name: '不指定' }))

    // 再加一个阶段后删掉，覆盖删除分支（新建阶段会自动展开，删除的就是它）
    await user.click(screen.getByRole('button', { name: '添加阶段' }))
    await user.click(screen.getByRole('button', { name: '删除' }))

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.name).toBe('研发')
    expect(draft.stages.map((stage) => stage.name)).toEqual([
      '待办',
      '阶段1',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(draft.stages.map((stage) => stage.builtin ?? null)).toEqual([
      'todo',
      null,
      'blocked',
      'done',
      'cancelled',
    ])
    expect(savedStage(draft, '阶段1')).toMatchObject({
      entryMode: 'agent',
      agentId: 'ag1',
      // 「已完成」在下标 3、「待办」在下标 0
      onCompleteIndex: 3,
      onRejectIndex: null,
    })

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalled()
  }, 30_000)

  it('空白草稿就是四件套：名称只读、没有删除与移动入口，其它字段照常可编辑', async () => {
    kernel.setView('agents.all', undefined, [agent])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} onSave={onSave} onCancel={vi.fn()} />)

    // 顺序固定：待办 → 已阻塞 → 已完成 → 已取消
    for (const [index, name] of ['待办', '已阻塞', '已完成', '已取消'].entries()) {
      expect(screen.getByRole('button', { name: `阶段${index + 1}` }).textContent).toContain(name)
    }

    // 名称只读、带「内置」徽标与类别；没有删除、没有上移 / 下移
    const nameInput = screen.getByLabelText('阶段1名称')
    expect(nameInput).toHaveValue('待办')
    expect(nameInput).toHaveAttribute('readonly')
    expect(screen.getByText('内置')).toBeInTheDocument()
    expect(screen.getByText('未开始')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '阶段1上移' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '阶段1下移' })).not.toBeInTheDocument()

    // 类别跟着内置键走：已取消是「已关闭」
    await user.click(screen.getByRole('button', { name: '阶段4' }))
    expect(screen.getByText('已关闭')).toBeInTheDocument()

    // 其它字段照常可编辑：把「待办」改成交给智能体并绑定智能体
    await user.click(screen.getByRole('button', { name: '阶段1' }))
    await choose(user, '阶段1类型', '交给智能体')
    await choose(user, '阶段1智能体', 'coder')
    await user.type(screen.getByLabelText('工作流名称'), '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[0]).toMatchObject({
      name: '待办',
      builtin: 'todo',
      entryMode: 'agent',
      agentId: 'ag1',
    })
  }, 30_000)

  it('编辑已有工作流：把阶段 id 还原成下标', async () => {
    const existing = workflowOf([
      { name: '待办', builtin: 'todo', onComplete: '进行中' },
      { name: '进行中', onReject: '待办' },
      BUILTIN_SPECS[1],
      BUILTIN_SPECS[2],
      BUILTIN_SPECS[3],
    ])
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('工作流名称')).toHaveValue('研发')

    // 默认展开第一个自己添加的阶段（进行中）
    await user.click(screen.getByRole('button', { name: '阶段1' }))
    // 上游 Select 的触发器不带 value 属性：改成打开浮层看哪一项是选中项
    await user.click(screen.getByRole('combobox', { name: '阶段1完成后进入' }))
    expect(screen.getByRole('option', { name: '进行中' })).toHaveAttribute('data-state', 'checked')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('combobox', { name: '阶段1完成后进入' })).toHaveTextContent('进行中')
    // 第二段详情要点左侧才展开
    fireEvent.click(screen.getByRole('button', { name: '阶段2' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2出错时进入' }))
    expect(screen.getByRole('option', { name: '待办' })).toHaveAttribute('data-state', 'checked')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('combobox', { name: '阶段2出错时进入' })).toHaveTextContent('待办')
  })

  it('工作流没有描述时描述输入框留空', () => {
    const existing = workflowOf([])
    existing.description = undefined as unknown as string
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('工作流描述')).toHaveValue('')
    // 视图里一个阶段都没有：编辑器补出四件套，不至于落到空态
    expect(screen.getByRole('button', { name: '阶段4' })).toBeInTheDocument()
  })

  it('阶段上/下移：只在用户区块里交换，并同步重映射流转目标下标', async () => {
    const existing = workflowWith([
      { name: 'A' },
      { name: 'B', onComplete: 'C' },
      { name: 'C', onReject: 'A' },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 左侧列表：序号 + 名称，用来断言重排结果（内置阶段占首尾）
    const order = (): (string | null)[] =>
      ['阶段2', '阶段3', '阶段4'].map(
        (name) => screen.getByRole('button', { name }).textContent ?? null,
      )

    // 选中第三个阶段（C）再上移：顺序变为 A、C、B，选中跟着 C 走
    await user.click(screen.getByRole('button', { name: '阶段4' }))
    await user.click(screen.getByRole('button', { name: '阶段4上移' }))
    expect(order()).toEqual(['2A', '3C', '4B'])
    expect(screen.getByLabelText('阶段3名称')).toHaveValue('C')
    // 内置阶段没有排序入口；用户区块的首尾各自只能单向移动
    expect(screen.queryByRole('button', { name: '阶段1上移' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '阶段6下移' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '阶段2上移' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '阶段4下移' })).toBeDisabled()

    // 再下移一次回到原位：A、B、C
    await user.click(screen.getByRole('button', { name: '阶段3下移' }))
    expect(order()).toEqual(['2A', '3B', '4C'])

    // 再次上移后保存，验证目标下标随重排重映射
    await user.click(screen.getByRole('button', { name: '阶段4上移' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    // B 的「完成后进入」指向 C：C 从下标 3 移到 2
    expect(savedStage(draft, 'B').onCompleteIndex).toBe(2)
    // C 的「打回退回到」指向 A：A 仍在下标 1
    expect(savedStage(draft, 'C').onRejectIndex).toBe(1)
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

    // 内置「待办」不是终态：交接照常可配（名称与位置才锁）
    await user.type(screen.getByLabelText('工作流名称'), '交接流')
    await choose(user, '阶段1类型', '交给智能体')
    await user.click(screen.getByRole('combobox', { name: '阶段1交接目标工作流' }))
    await user.click(await screen.findByRole('option', { name: '写作' }))
    await user.click(screen.getByRole('combobox', { name: '阶段1交接目标阶段' }))
    expect(await screen.findByRole('option', { name: '草稿' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: '发布' }))

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[0]).toMatchObject({
      builtin: 'todo',
      handoffWorkflowId: 'w2',
      handoffStageId: 'b1',
    })
  })

  it('编辑已有工作流：回显交接目标、排除自身候选、切换工作流重置阶段、回传阶段 id', async () => {
    const current = workflowOf([
      { name: '待办', builtin: 'todo', handoffWorkflowId: 'w2', handoffStageId: 'b1' },
      { name: '进行中' },
      BUILTIN_SPECS[1],
      BUILTIN_SPECS[2],
      BUILTIN_SPECS[3],
    ])
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

    // 默认展开第一个自己添加的阶段（进行中）；交接目标挂在「待办」上，点开它
    await user.click(screen.getByRole('button', { name: '阶段1' }))
    expect(await screen.findByRole('combobox', { name: '阶段1交接目标工作流' })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '阶段1交接目标工作流' })).toHaveTextContent(
        '写作',
      ),
    )
    expect(screen.getByRole('combobox', { name: '阶段1交接目标阶段' })).toHaveTextContent('发布')
    // 进行中没配交接：它的「目标阶段」选择不出现
    await user.click(screen.getByRole('button', { name: '阶段2' }))
    expect(screen.queryByRole('combobox', { name: '阶段2交接目标阶段' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '阶段1' }))

    // 当前工作流不在候选里；选「不交接」清空后目标阶段选择消失
    await user.click(screen.getByRole('combobox', { name: '阶段1交接目标工作流' }))
    expect(screen.queryByRole('option', { name: '研发' })).not.toBeInTheDocument()
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
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[0]).toMatchObject({
      id: 's0',
      handoffWorkflowId: 'w2',
      handoffStageId: 'b1',
    })
    expect(draft.stages[1]).toMatchObject({ id: 's1', handoffWorkflowId: null })
  }, 30_000)

  it('交接目标工作流已不在清单：目标阶段候选为空，仍按视图值回显', () => {
    const existing = workflowOf([
      { name: '待办', builtin: 'todo', handoffWorkflowId: 'gone', handoffStageId: 'gs0' },
      BUILTIN_SPECS[1],
      BUILTIN_SPECS[2],
      BUILTIN_SPECS[3],
    ])
    kernel.setView('workflows.all', undefined, [])
    kernel.setView('agents.all', undefined, [])
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)
    // 目标的 id 仍原样回传（不在候选里，下拉按未设置展示），目标阶段候选为空
    expect(screen.getByRole('combobox', { name: '阶段1交接目标工作流' })).toHaveTextContent(
      '不交接',
    )
    expect(screen.getByRole('combobox', { name: '阶段1交接目标阶段' })).toHaveTextContent('首阶段')
  })

  it('子任务三字段：落点阶段 / 完成后动作 / 是否允许拆（M8）', async () => {
    const existing = workflowWith([{ name: '进行中' }])
    // 「待办」交给智能体才会展示子任务三字段：内置阶段只锁名称与位置
    const stages = existing.stages.map((stage) =>
      stage.builtin === 'todo' ? { ...stage, entryMode: 'agent' as const } : stage,
    )
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={{ ...existing, stages }} onSave={onSave} onCancel={vi.fn()} />)

    // 默认展开第一个自己添加的阶段；内置「待办」要自己点开
    await user.click(screen.getByRole('button', { name: '阶段1' }))
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
    const existing = workflowWith([
      { name: '方案', instructions: '读需求，出方案' },
      { name: '实现' },
    ])
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 默认展开第一个自己添加的阶段：已有说明回显
    expect(screen.getByLabelText('阶段2要干什么')).toHaveValue('读需求，出方案')
    await user.clear(screen.getByLabelText('阶段2要干什么'))
    await user.type(screen.getByLabelText('阶段2要干什么'), '读需求，列改动文件')

    await user.click(screen.getByRole('button', { name: '阶段3' }))
    expect(screen.getByLabelText('阶段3要干什么')).toHaveValue('')
    await user.type(screen.getByLabelText('阶段3要干什么'), '按方案实现并自测')

    // 回到阶段 2：草稿仍在
    await user.click(screen.getByRole('button', { name: '阶段2' }))
    expect(screen.getByLabelText('阶段2要干什么')).toHaveValue('读需求，列改动文件')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '方案')).toMatchObject({
      id: 's1',
      instructions: '读需求，列改动文件',
    })
    expect(savedStage(draft, '实现')).toMatchObject({ id: 's2', instructions: '按方案实现并自测' })
  })

  it('移动别的阶段：展开项不跳，被换位时才跟着换（左侧行内上移 / 下移）', async () => {
    const existing = workflowWith([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)

    const order = (): (string | null)[] =>
      ['阶段2', '阶段3', '阶段4'].map(
        (name) => screen.getByRole('button', { name }).textContent ?? null,
      )

    // 展开 A，把 C 上移：A 仍在展开，C 进到第 3 行
    await user.click(screen.getByRole('button', { name: '阶段2' }))
    await user.click(screen.getByRole('button', { name: '阶段4上移' }))
    expect(order()).toEqual(['2A', '3C', '4B'])
    expect(screen.getByLabelText('阶段2名称')).toHaveValue('A')

    // 展开 B（现在第 4 行），把 C 下移回去：B 被换到第 3 行，展开项跟着走
    await user.click(screen.getByRole('button', { name: '阶段4' }))
    expect(screen.getByLabelText('阶段4名称')).toHaveValue('B')
    await user.click(screen.getByRole('button', { name: '阶段3下移' }))
    expect(order()).toEqual(['2A', '3B', '4C'])
    expect(screen.getByLabelText('阶段3名称')).toHaveValue('B')
  })

  it('删掉自己添加的唯一阶段：四个内置阶段仍在，右侧落回内置阶段', async () => {
    const user = userEvent.setup()
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    render(<WorkflowEditor workflow={null} onSave={vi.fn()} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '添加阶段' }))
    expect(screen.getByRole('button', { name: '阶段5' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '删除' }))

    // 内置四件套一个都不少，右侧回到内置阶段（名称只读、没有删除入口）
    expect(screen.queryByRole('button', { name: '阶段5' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('阶段2名称')).toHaveValue('已阻塞')
    expect(screen.getByLabelText('阶段2名称')).toHaveAttribute('readonly')
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument()

    // 还能继续加阶段
    await user.click(screen.getByRole('button', { name: '添加阶段' }))
    expect(screen.getByLabelText('阶段2名称')).toHaveValue('阶段1')
  })

  it('上移阶段：目标指向正被让位的相邻阶段时，目标下标 +1（重映射上移方向）', async () => {
    const existing = workflowWith([{ name: 'A', onComplete: 'B' }, { name: 'B' }, { name: 'C' }])
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // C 上移越过 B：B 从下标 3 被挤到 4，A 指向 B 的下标要同步 +1
    await user.click(screen.getByRole('button', { name: '阶段4上移' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages.map((s) => s.name)).toEqual([
      '待办',
      'A',
      'C',
      'B',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(savedStage(draft, 'A')).toMatchObject({ name: 'A', onCompleteIndex: 3 })
  })

  it('下移阶段：目标指向正被让位的相邻阶段时，目标下标 -1（重映射下移方向）', async () => {
    const existing = workflowWith([{ name: 'A' }, { name: 'B' }, { name: 'C', onComplete: 'B' }])
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // A 下移越过 B：B 从下标 3 被挤到 2，C 指向 B 的下标要同步 -1
    await user.click(screen.getByRole('button', { name: '阶段2下移' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages.map((s) => s.name)).toEqual([
      '待办',
      'B',
      'A',
      'C',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(savedStage(draft, 'C')).toMatchObject({ name: 'C', onCompleteIndex: 1 })
  })

  it('子任务三字段可清空回默认：选空项落 null', async () => {
    const existing = workflowWith([{ name: '待办2' }])
    const stages = existing.stages.map((stage) =>
      stage.builtin === 'todo' ? { ...stage, entryMode: 'agent' as const } : stage,
    )
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={{ ...existing, stages }} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段1' }))
    // 先设为非空再清空：每次选空项都应落回 null（清空即回默认）
    await choose(user, '阶段1子任务落点阶段', '待办2')
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
    const existing = workflowWith([{ name: '执行' }, { name: '自测' }, { name: '结束' }])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段3' }))
    await choose(user, '阶段3类型', '闸门（判定）')

    // 切到闸门即自动交给智能体，并给出默认 3 次
    expect(screen.getByRole('combobox', { name: '阶段3智能体' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '阶段3闸门次数' })).toHaveTextContent('3 次')

    await choose(user, '阶段3闸门次数', '5 次')
    await choose(user, '阶段3智能体', 'coder')
    await choose(user, '阶段3闸门通过时进入', '结束')
    await choose(user, '阶段3闸门未通过时进入', '执行')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '自测')).toMatchObject({
      entryMode: 'agent',
      agentId: 'ag1',
      gate: { maxFails: 5, onPassIndex: 3, onFailIndex: 1 },
    })
  }, 30_000)

  it('闸门：已有配置还原成下标，切回普通类型清掉闸门（M11）', async () => {
    const existing = workflowWith([
      { name: '执行' },
      { name: '自测', gate: { maxFails: 2, onPass: '结束', onFail: '执行' } },
      { name: '结束' },
    ])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段3' }))
    // 还原：类型显示为闸门，两个去向按下标回填
    expect(screen.getByRole('combobox', { name: '阶段3类型' })).toHaveTextContent('闸门（判定）')
    expect(screen.getByRole('combobox', { name: '阶段3闸门次数' })).toHaveTextContent('2 次')
    expect(screen.getByRole('combobox', { name: '阶段3闸门通过时进入' })).toHaveTextContent('结束')
    expect(screen.getByRole('combobox', { name: '阶段3闸门未通过时进入' })).toHaveTextContent(
      '执行',
    )

    // 切回普通类型：闸门字段消失，配置落 null
    await choose(user, '阶段3类型', '交给智能体')
    expect(screen.queryByRole('combobox', { name: '阶段3闸门次数' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '自测')).toMatchObject({ entryMode: 'agent', gate: null })
  }, 30_000)

  it('不交接：同样只留名称与类型，保存时把看不见的字段归一', async () => {
    const existing = workflowWith([
      {
        name: '实现',
        onComplete: '收尾',
        onReject: '收尾',
        subtaskStageId: '收尾',
        onChildrenSettled: 'notify',
        spawnPolicy: 'off',
        instructions: '按方案实现',
      },
      { name: '收尾' },
    ])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await choose(user, '阶段2类型', '不交接')

    for (const label of [
      '阶段2智能体',
      '阶段2完成后进入',
      '阶段2出错时进入',
      '阶段2闸门次数',
      '阶段2交接目标工作流',
      '阶段2子任务落点阶段',
      '阶段2子任务完成后',
      '阶段2允许拆子任务',
    ]) {
      expect(screen.queryByRole('combobox', { name: label })).not.toBeInTheDocument()
    }
    expect(screen.queryByLabelText('阶段2要干什么')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '实现')).toEqual({
      id: 's1',
      name: '实现',
      entryMode: 'none',
      builtin: null,
      agentId: null,
      onCompleteIndex: null,
      onRejectIndex: null,
      handoffWorkflowId: null,
      handoffStageId: null,
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
      instructions: '按方案实现',
      // M20：不展示验收的类型保存时归一为空
      acceptance: [],
      maxRounds: null,
      runTimeoutMs: null,
      gate: null,
    })
  }, 30_000)

  it('交给用户：只留名称与类型，保存时把看不见的字段归一', async () => {
    const existing = workflowWith([
      {
        name: '实现',
        onComplete: '收尾',
        subtaskStageId: '收尾',
        onChildrenSettled: 'wake',
        spawnPolicy: 'off',
        instructions: '按方案实现',
      },
      { name: '收尾' },
    ])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await choose(user, '阶段2类型', '交给用户')

    // 除名称与类型外一律不展示
    expect(screen.getByLabelText('阶段2名称')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '阶段2类型' })).toHaveTextContent('交给用户')
    for (const label of [
      '阶段2智能体',
      '阶段2完成后进入',
      '阶段2出错时进入',
      '阶段2闸门次数',
      '阶段2交接目标工作流',
      '阶段2子任务落点阶段',
      '阶段2子任务完成后',
      '阶段2允许拆子任务',
    ]) {
      expect(screen.queryByRole('combobox', { name: label })).not.toBeInTheDocument()
    }
    expect(screen.queryByLabelText('阶段2要干什么')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '实现')).toEqual({
      id: 's1',
      name: '实现',
      entryMode: 'user',
      builtin: null,
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
      // M20：不展示验收的类型保存时归一为空
      acceptance: [],
      maxRounds: null,
      runTimeoutMs: null,
      gate: null,
    })
  }, 30_000)

  it('闸门：不展示交接与子任务，保存时把这些看不见的字段归一', async () => {
    const existing = workflowWith([
      {
        name: '实现',
        onComplete: '收尾',
        onReject: '收尾',
        subtaskStageId: '收尾',
        onChildrenSettled: 'wake',
        spawnPolicy: 'off',
        instructions: '跑一遍验收命令',
        gate: { maxFails: 3, onPass: '收尾', onFail: '实现' },
      },
      { name: '收尾' },
    ])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 闸门只判定：次数与两个去向在，交接与子任务不在
    expect(screen.getByRole('combobox', { name: '阶段2闸门次数' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '阶段2闸门通过时进入' })).toBeInTheDocument()
    expect(screen.getByLabelText('阶段2要干什么')).toHaveValue('跑一遍验收命令')
    for (const label of [
      '阶段2交接目标工作流',
      '阶段2子任务落点阶段',
      '阶段2子任务完成后',
      '阶段2允许拆子任务',
      '阶段2完成后进入',
      '阶段2出错时进入',
    ]) {
      expect(screen.queryByRole('combobox', { name: label })).not.toBeInTheDocument()
    }

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '实现')).toMatchObject({
      entryMode: 'agent',
      agentId: 'ag1',
      // 「收尾」在下标 2，「实现」在下标 1
      gate: { maxFails: 3, onPassIndex: 2, onFailIndex: 1 },
      instructions: '跑一遍验收命令',
    })
    // 闸门不做交接、不拆子任务；「完成 / 出错」两个去向也不在面板上，留着会改掉默认通过落点
    expect(savedStage(draft, '实现')).toMatchObject({
      onCompleteIndex: null,
      onRejectIndex: null,
      handoffWorkflowId: null,
      handoffStageId: null,
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
    })
  }, 30_000)

  it('已完成 / 已取消是终态：交接两块不展示，保存清掉旧交接配置', async () => {
    const existing = workflowOf([
      BUILTIN_SPECS[0],
      BUILTIN_SPECS[1],
      {
        name: '已完成',
        builtin: 'done',
        entryMode: 'agent',
        handoffWorkflowId: 'w2',
        handoffStageId: 'b1',
      },
      { name: '已取消', builtin: 'cancelled', entryMode: 'agent' },
    ])
    kernel.setView('workflows.all', undefined, [])
    kernel.setView('agents.all', undefined, [agent])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    for (const [position, name] of [
      ['阶段3', '已完成'],
      ['阶段4', '已取消'],
    ] as const) {
      await user.click(screen.getByRole('button', { name: position }))
      expect(screen.getByLabelText(`${position}名称`)).toHaveValue(name)
      // 交接两块不渲染，取而代之的是一句说明
      expect(
        screen.queryByRole('combobox', { name: `${position}交接目标工作流` }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByRole('combobox', { name: `${position}交接目标阶段` }),
      ).not.toBeInTheDocument()
      expect(screen.getByText('已完成 / 已取消是终态，不交接。')).toBeInTheDocument()
      // 子任务是派活落点，不是交接：仍然可配
      expect(
        screen.getByRole('combobox', { name: `${position}子任务落点阶段` }),
      ).toBeInTheDocument()
    }

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '已完成')).toMatchObject({
      handoffWorkflowId: null,
      handoffStageId: null,
    })
  }, 30_000)

  it('新增阶段落在「已阻塞」之前：指向内置阶段的目标下标顺延', async () => {
    const existing = workflowWith([{ name: 'A', onComplete: '已阻塞' }])
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 插入前：A = 阶段2、「已阻塞」= 阶段3
    expect(screen.getByRole('button', { name: '阶段3' }).textContent).toContain('已阻塞')
    await user.click(screen.getByRole('button', { name: '添加阶段' }))

    // 插入后：新阶段占第 3 行，「已阻塞」被挤到第 4 行，并且新阶段直接展开
    expect(screen.getByRole('button', { name: '阶段4' }).textContent).toContain('已阻塞')
    expect(screen.getByLabelText('阶段3名称')).toHaveValue('阶段2')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages.map((s) => s.name)).toEqual([
      '待办',
      'A',
      '阶段2',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    // 「已阻塞」从下标 2 顺延到 3
    expect(savedStage(draft, 'A').onCompleteIndex).toBe(3)
    expect(savedStage(draft, '阶段2').builtin).toBeNull()
  })

  it('编辑老数据：视图里没有内置阶段时隐式补出，保存带上 builtin 键', async () => {
    // M18 之前的存量：两个阶段，既没有内置键也没有四件套
    const existing = workflowOf([{ name: '方案' }, { name: '实现' }])
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 默认展开第一个自己添加的阶段（方案）；补出来的「待办」要点开看
    await user.click(screen.getByRole('button', { name: '阶段1' }))
    expect(screen.getByLabelText('阶段1名称')).toHaveValue('待办')
    expect(screen.getByLabelText('阶段1名称')).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: '阶段6' }).textContent).toContain('已取消')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages.map((s) => s.name)).toEqual([
      '待办',
      '方案',
      '实现',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(draft.stages.map((s) => s.builtin ?? null)).toEqual([
      'todo',
      null,
      null,
      'blocked',
      'done',
      'cancelled',
    ])
    // 补出来的内置阶段不带 id（由内核分配），既有阶段 id 原样回传
    expect(draft.stages.map((s) => s.id)).toEqual([
      undefined,
      's0',
      's1',
      undefined,
      undefined,
      undefined,
    ])
  })
})

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
        workflow={workflowWith([{ name: '进行中' }])}
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

  it('空白草稿直接保存：内置阶段不算「没有阶段」，只报工作流名称必填', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('工作流名称必填')).toBeInTheDocument()
    expect(screen.queryByText('工作流至少要有一个阶段')).not.toBeInTheDocument()
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
          acceptance: [],
          maxRounds: null,
          runTimeoutMs: null,
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

  it('悬空目标的错误条：展开别的阶段后仍在页脚可见（不被切走）', async () => {
    const initial: WorkflowInput = {
      name: '旧流',
      description: '',
      stages: [
        {
          name: '待办',
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteIndex: 9,
          onRejectIndex: null,
          handoffWorkflowId: null,
          handoffStageId: null,
          subtaskStageId: null,
          onChildrenSettled: null,
          spawnPolicy: null,
          instructions: '',
          acceptance: [],
          maxRounds: null,
          runTimeoutMs: null,
          gate: null,
        },
      ],
    }
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} initial={initial} onSave={vi.fn()} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/的流转目标已不在阶段列表里/)).toBeInTheDocument()

    // 切到别的阶段：阶段面板里看不到这条错误了，但页脚仍要说清楚哪里不对
    await user.click(screen.getByRole('button', { name: '阶段3' }))
    expect(screen.getByText(/的流转目标已不在阶段列表里/)).toBeInTheDocument()
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

  it('保存失败为非 Error 值时按字符串展示', async () => {
    // 桥接可能抛出非 Error 值：错误文案统一转成字符串
    const onSave = vi.fn().mockRejectedValue('磁盘写不进去')
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
    // 内置阶段的名称改不了，trim 只作用在自己添加的阶段上
    await user.click(screen.getByRole('button', { name: '添加阶段' }))
    await user.clear(screen.getByLabelText('阶段2名称'))
    await user.type(screen.getByLabelText('阶段2名称'), '  阶段甲  ')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.name).toBe('研发')
    expect(draft.stages.map((stage) => stage.name)).toEqual([
      '待办',
      '阶段甲',
      '已阻塞',
      '已完成',
      '已取消',
    ])
  })

  it('删除中间阶段：后面的流转下标跟着前移，不会静默指错', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    const existing = workflowWith([
      { name: 'A', onComplete: 'C' },
      { name: 'B', onComplete: 'C' },
      { name: 'C' },
    ])
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 删掉 B：C 从下标 4 前移到 3，A 的「完成后进入」要跟着改
    await user.click(screen.getByRole('button', { name: '阶段3' }))
    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages.map((stage) => stage.name)).toEqual([
      '待办',
      'A',
      'C',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(savedStage(draft, 'A').onCompleteIndex).toBe(2)
  })
})

describe('WorkflowEditor 阶段流转目标与闸门去向', () => {
  beforeEach(() => {
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [])
  })

  it('闸门去向指向已不存在的阶段：还原成 null（回到默认语义）', async () => {
    const existing = workflowWith([
      { name: '执行' },
      { name: '判定', gate: { maxFails: 2 } },
      { name: '收尾' },
    ])
    // 目标阶段已被删：视图里只剩 id，编辑器还原不出下标
    const stages = existing.stages.map((stage) =>
      stage.builtin === null && stage.name === '判定'
        ? { ...stage, gate: { maxFails: 2, onPassStageId: 'gone', onFailStageId: null } }
        : stage,
    )
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={{ ...existing, stages }} onSave={onSave} onCancel={vi.fn()} />)

    // 落点不在阶段列表里：两个去向都按默认回显
    await user.click(screen.getByRole('button', { name: '阶段3' }))
    expect(screen.getByRole('combobox', { name: '阶段3闸门通过时进入' })).toHaveTextContent(
      '下一阶段',
    )
    expect(screen.getByRole('combobox', { name: '阶段3闸门未通过时进入' })).toHaveTextContent(
      '原地不动',
    )

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '判定').gate).toMatchObject({
      maxFails: 2,
      onPassIndex: null,
      onFailIndex: null,
    })
  })

  it('删掉被别的阶段指向的阶段：那个目标清成 null（不会静默指到别的阶段）', async () => {
    const existing = workflowWith([
      { name: 'A', onComplete: 'B' },
      { name: 'B' },
      // C 指回 A：删掉中间的 B 时，它前面的目标不该被动到
      { name: 'C', onReject: 'A' },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 删掉 B：A 的「完成后进入」正好指向它，不能改成指向 C
    await user.click(screen.getByRole('button', { name: '阶段3' }))
    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages.map((stage) => stage.name)).toEqual([
      '待办',
      'A',
      'C',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(savedStage(draft, 'A').onCompleteIndex).toBeNull()
    // C 指向删除点之前的 A：下标不变
    expect(savedStage(draft, 'C').onRejectIndex).toBe(1)
  })

  it('删阶段：带闸门的阶段保住闸门并重映射去向，没闸门的阶段闸门仍为 null', async () => {
    const existing = workflowWith([
      { name: 'A' },
      { name: '判定', gate: { maxFails: 2, onPass: 'C' } },
      { name: 'C' },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 删掉 A：判定阶段还在，它的闸门要保住，去向跟着重映射
    await user.click(screen.getByRole('button', { name: '阶段2' }))
    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages.map((stage) => stage.name)).toEqual([
      '待办',
      '判定',
      'C',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    // C 从下标 3 前移到 2，闸门的「通过时进入」跟着改
    expect(savedStage(draft, '判定').gate).toMatchObject({
      maxFails: 2,
      onPassIndex: 2,
      onFailIndex: null,
    })
    // 没闸门的阶段闸门仍是 null
    expect(savedStage(draft, 'C').gate).toBeNull()
  })

  it('上移阶段：带闸门的阶段保住闸门，闸门去向跟着重映射', async () => {
    const existing = workflowWith([
      { name: 'A' },
      { name: '判定', gate: { maxFails: 2, onPass: 'C' } },
      { name: 'C' },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // C 上移越过判定：C 从下标 3 移到 2，闸门的「通过时进入」要跟着改
    await user.click(screen.getByRole('button', { name: '阶段4上移' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages.map((stage) => stage.name)).toEqual([
      '待办',
      'A',
      'C',
      '判定',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(savedStage(draft, '判定').gate).toMatchObject({
      maxFails: 2,
      onPassIndex: 2,
      onFailIndex: null,
    })
  })

  it('闸门两个去向可以选回默认：通过=下一阶段、未通过=原地不动', async () => {
    const existing = workflowWith([
      { name: '执行' },
      { name: '判定', gate: { maxFails: 2, onPass: '收尾', onFail: '执行' } },
      { name: '收尾' },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段3' }))
    // 先选到具体阶段，再选回默认项：两次都要落回 null
    await choose(user, '阶段3闸门通过时进入', '收尾')
    await choose(user, '阶段3闸门未通过时进入', '执行')
    await choose(user, '阶段3闸门通过时进入', '下一阶段')
    await choose(user, '阶段3闸门未通过时进入', '原地不动')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '判定').gate).toMatchObject({
      maxFails: 2,
      onPassIndex: null,
      onFailIndex: null,
    })
  })

  it('预填草稿里的阶段没有「要干什么」：输入框回显空串', () => {
    const initial: WorkflowInput = {
      name: '研发',
      description: '',
      stages: [
        {
          name: '待办',
          entryMode: 'agent',
          agentId: 'ag1',
          onCompleteIndex: null,
          onRejectIndex: null,
          handoffWorkflowId: null,
          handoffStageId: null,
          subtaskStageId: null,
          onChildrenSettled: null,
          spawnPolicy: null,
          gate: null,
        },
      ],
    }
    render(<WorkflowEditor workflow={null} initial={initial} onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByLabelText('阶段1要干什么')).toHaveValue('')
  })

  it('验收与轮次（M20/M21）：一条一行存成数组，轮次可选；没验收时不展示轮次', async () => {
    const existing = workflowWith([{ name: '执行' }, { name: '自测' }, { name: '结束' }])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段3' }))
    await choose(user, '阶段3类型', '交给智能体')
    await choose(user, '阶段3智能体', 'coder')

    // 没写验收时不给轮次选择（续轮需要可判定的口径才有意义）
    expect(screen.queryByRole('combobox', { name: '阶段3轮次上限' })).not.toBeInTheDocument()

    const acceptance = screen.getByLabelText('阶段3验收')
    await user.type(acceptance, 'pnpm check 退出码 0{enter}覆盖每条验收标准')
    await choose(user, '阶段3轮次上限', '2 轮')
    // M26：单轮超时按档位选，落库是毫秒（90 分钟）
    await choose(user, '阶段3单轮超时', '90 分钟')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '自测')).toMatchObject({
      acceptance: ['pnpm check 退出码 0', '覆盖每条验收标准'],
      maxRounds: 2,
      runTimeoutMs: 5_400_000,
    })
  }, 30_000)
})

describe('moveStageInList', () => {
  const stages: StageInput[] = [
    { name: 'A', entryMode: 'agent' },
    { name: 'B', entryMode: 'agent' },
  ]

  it('正常移动：被移动的那一项换位，选中项跟着它走', () => {
    const moved = moveStageInList(stages, 0, 0, 1)
    expect(moved.stages.map((stage) => stage.name)).toEqual(['B', 'A'])
    expect(moved.selected).toBe(1)
  })

  it('越界移动：阶段与选中下标原样返回（界面上这两个按钮本来就是禁用的）', () => {
    // 首行上移
    expect(moveStageInList(stages, 0, 0, -1)).toEqual({ stages, selected: 0 })
    // 末行下移
    expect(moveStageInList(stages, 1, 1, 1)).toEqual({ stages, selected: 1 })
  })
})
