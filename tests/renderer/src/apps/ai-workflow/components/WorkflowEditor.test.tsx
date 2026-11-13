import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  STAGE_EXIT_GUARDS,
  type Agent,
  type BuiltinStageKey,
  type EntryMode,
  type OnChildrenSettled,
  type SpawnPolicy,
  type StageExitGuard,
  type StageExits,
  type StageHandoff,
  type StageInput,
  type StagePrimary,
  type WorkflowInput,
  type WorkflowWithStages,
} from '../../../../../../src/protocol/entities'
import {
  moveStageToIndex,
  WorkflowEditor,
} from '../../../../../../src/renderer/src/apps/ai-workflow/components/WorkflowEditor'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

/** 拖一行到另一行（序号 1 基，与左侧列表一致）：整行是拖拽源与落点，抓到目标行松手 */
function dragStageRow(from: number, to: number): void {
  fireEvent.dragStart(screen.getByRole('button', { name: `阶段${from}` }))
  fireEvent.dragOver(screen.getByRole('button', { name: `阶段${to}` }))
  fireEvent.drop(screen.getByRole('button', { name: `阶段${to}` }))
}

const agent: Agent = {
  id: 'ag1',
  name: 'coder',
  description: '',
  runtimeId: 'r1',
  systemPrompt: '',
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
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

/** 出口表的一格：`{ goto: 阶段名 }` = 进入该阶段；`await` / `close` = 停在这里等人 / 结束归档 */
type ExitSpec = { goto: string } | 'await' | 'close'

/** 阶段规格：按最终顺序写，出口表的目标用**阶段名**表达（可读，也不受下标漂移影响） */
interface StageSpec {
  name: string
  builtin?: BuiltinStageKey
  entryMode?: EntryMode
  agentId?: string | null
  /** 出口表：只写配了的触发条件，缺省的由内核保存时补齐 */
  exits?: Partial<Record<StageExitGuard, ExitSpec>>
  handoffs?: StageHandoff[]
  subtaskStageId?: string | null
  onChildrenSettled?: OnChildrenSettled | null
  spawnPolicy?: SpawnPolicy | null
  instructions?: string
  /** 验收条目（M34：只有闸门阶段能带；非闸门阶段带上内核会拒收） */
  acceptance?: readonly string[]
  /** 判定者（非空 = 判定阶段，出口只有通过 / 未通过 / 出错三行） */
  judge?: { maxFails: number | null }
}

/**
 * 造一条既有工作流：`specs` 就是视图里的阶段顺序（内置阶段也写进来）。
 *
 * 默认交给智能体 + 绑定 `ag1`（与旧夹具一致）；内置阶段自己显式给 `entryMode: 'none'`。
 * id 按顺序给 `s0…sN`，因此出口目标用名字写、断言时再按下标核对。
 */
function workflowOf(specs: StageSpec[]): WorkflowWithStages {
  const ids = specs.map((_, index) => `s${index}`)
  const idByName = new Map(specs.map((spec, index) => [spec.name, ids[index]]))
  /** 出口表：阶段名换成阶段 id；名字指不到任何阶段时留一个查不到的 id（界面上还原成未指定） */
  const exitsOf = (spec: StageSpec): StageExits => {
    const exits: StageExits = {}
    for (const guard of STAGE_EXIT_GUARDS) {
      const target = spec.exits?.[guard]
      if (target === undefined) continue
      exits[guard] =
        target === 'await' || target === 'close'
          ? { do: target }
          : { do: 'goto', stageId: idByName.get(target.goto) ?? target.goto }
    }
    return exits
  }
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
      exits: exitsOf(spec),
      judge: spec.judge ?? null,
      handoffs: spec.handoffs ?? [],
      subtaskStageId: spec.subtaskStageId ?? null,
      onChildrenSettled: spec.onChildrenSettled ?? null,
      spawnPolicy: spec.spawnPolicy ?? null,
      instructions: spec.instructions ?? '',
      acceptance: spec.acceptance ?? [],
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
    // 出口表：完成时先选「进入指定阶段」再选目标（可以指向内置阶段），也能选回默认（下一阶段）
    await choose(user, '阶段2完成时去向', '进入指定阶段')
    await choose(user, '阶段2完成时目标阶段', '已完成')
    await choose(user, '阶段2完成时去向', '默认（下一阶段）')
    await choose(user, '阶段2完成时去向', '进入指定阶段')
    await choose(user, '阶段2完成时目标阶段', '已完成')
    // 另两种动作也占一行：停在这里等人 / 结束并归档
    await choose(user, '阶段2完成时去向', '停在这里等人')
    await choose(user, '阶段2完成时去向', '结束并归档')
    expect(screen.getByRole('combobox', { name: '阶段2完成时去向' })).toHaveTextContent(
      '结束并归档',
    )
    await choose(user, '阶段2完成时去向', '进入指定阶段')
    await choose(user, '阶段2完成时目标阶段', '已完成')
    // 出错时也能指到具体阶段，再收回默认（停在这里等人）→ 这一行不写进出口表
    await choose(user, '阶段2出错时去向', '进入指定阶段')
    await choose(user, '阶段2出错时目标阶段', '待办')
    await choose(user, '阶段2出错时去向', '默认（停在这里等人）')

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
      // 「已完成」在下标 3；出错时被收回默认（停在这里等人），不写进出口表
      exits: [{ on: 'done', do: 'goto', stageIndex: 3 }],
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

    // 名称只读、带「内置」徽标与类别；没有删除、没有拖动抓手
    const nameInput = screen.getByLabelText('阶段1名称')
    expect(nameInput).toHaveValue('待办')
    expect(nameInput).toHaveAttribute('readonly')
    expect(screen.getByText('内置')).toBeInTheDocument()
    expect(screen.getByText('未开始')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '拖动排序：阶段1' })).not.toBeInTheDocument()

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

  it('编辑已有工作流：把出口表里的阶段 id 还原成下标', async () => {
    const existing = workflowOf([
      { name: '待办', builtin: 'todo', exits: { done: { goto: '进行中' } } },
      { name: '进行中', exits: { errored: { goto: '待办' } } },
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
    await user.click(screen.getByRole('combobox', { name: '阶段1完成时去向' }))
    expect(screen.getByRole('option', { name: '进入指定阶段' })).toHaveAttribute(
      'data-state',
      'checked',
    )
    await user.keyboard('{Escape}')
    // 目标阶段按 id 还原成下标后回显
    expect(screen.getByRole('combobox', { name: '阶段1完成时目标阶段' })).toHaveTextContent(
      '进行中',
    )
    // 第二段详情要点左侧才展开
    fireEvent.click(screen.getByRole('button', { name: '阶段2' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2出错时去向' }))
    expect(screen.getByRole('option', { name: '进入指定阶段' })).toHaveAttribute(
      'data-state',
      'checked',
    )
    await user.keyboard('{Escape}')
    expect(screen.getByRole('combobox', { name: '阶段2出错时目标阶段' })).toHaveTextContent('待办')
  })

  it('工作流没有描述时描述输入框留空', () => {
    const existing = workflowOf([])
    existing.description = undefined as unknown as string
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByLabelText('工作流描述')).toHaveValue('')
    // 视图里一个阶段都没有：编辑器补出四件套，不至于落到空态
    expect(screen.getByRole('button', { name: '阶段4' })).toBeInTheDocument()
  })

  it('拖动阶段：只在用户区块里重排，并同步重映射流转目标下标', async () => {
    const existing = workflowWith([
      { name: 'A' },
      { name: 'B', exits: { done: { goto: 'C' } } },
      { name: 'C', exits: { errored: { goto: 'A' } } },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 左侧列表：序号 + 名称，用来断言重排结果（内置阶段占首尾）
    const order = (): (string | null)[] =>
      ['阶段2', '阶段3', '阶段4'].map(
        (name) => screen.getByRole('button', { name }).textContent ?? null,
      )

    // 选中第三个阶段（C）再拖到 B 的位置：顺序变为 A、C、B，选中跟着 C 走
    await user.click(screen.getByRole('button', { name: '阶段4' }))
    dragStageRow(4, 3)
    expect(order()).toEqual(['2A', '3C', '4B'])
    expect(screen.getByLabelText('阶段3名称')).toHaveValue('C')
    // 内置阶段没有抓手（位置锁定）；用户阶段都有，首尾各自少一个方向键
    expect(screen.queryByRole('button', { name: '拖动排序：阶段1' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '拖动排序：阶段6' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拖动排序：阶段2' })).toBeInTheDocument()

    // 再拖回去：A、B、C
    dragStageRow(3, 4)
    expect(order()).toEqual(['2A', '3B', '4C'])

    // 抓手键盘：用户区块中间一条 ↑ / ↓ 各挪一格，首条按 ↑ 不动（拖拽不可键盘操作）
    await user.click(screen.getByRole('button', { name: '拖动排序：阶段3' }))
    await user.keyboard('{ArrowUp}')
    expect(order()).toEqual(['2B', '3A', '4C'])
    await user.keyboard('{ArrowDown}')
    expect(order()).toEqual(['2A', '3B', '4C'])
    await user.click(screen.getByRole('button', { name: '拖动排序：阶段2' }))
    await user.keyboard('{ArrowUp}')
    expect(order()).toEqual(['2A', '3B', '4C'])

    // 再次拖动后保存，验证目标下标随重排重映射
    dragStageRow(4, 3)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    // B 的「完成时」指向 C：C 从下标 3 移到 2
    expect(savedStage(draft, 'B').exits).toEqual([{ on: 'done', do: 'goto', stageIndex: 2 }])
    // C 的「出错时」指向 A：A 仍在下标 1
    expect(savedStage(draft, 'C').exits).toEqual([{ on: 'errored', do: 'goto', stageIndex: 1 }])
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
          exits: {},
          judge: null,
          handoffs: [],
        },
        {
          id: 'b1',
          workflowId: 'w2',
          name: '发布',
          position: 1,
          entryMode: 'agent',
          agentId: 'ag1',
          exits: {},
          judge: null,
          handoffs: [],
        },
      ],
    }
    kernel.setView('workflows.all', undefined, [other])
    kernel.setView('agents.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={null} onSave={onSave} onCancel={vi.fn()} />)

    // 内置「待办」不是终态：派单照常可配（名称与位置才锁）
    await user.type(screen.getByLabelText('工作流名称'), '派单流')
    await choose(user, '阶段1类型', '交给智能体')
    await user.click(screen.getByRole('button', { name: '阶段1新增派单' }))
    await user.click(screen.getByRole('combobox', { name: '阶段1派单1目标工作流' }))
    await user.click(await screen.findByRole('option', { name: '写作' }))
    await user.click(screen.getByRole('combobox', { name: '阶段1派单1目标阶段' }))
    expect(await screen.findByRole('option', { name: '草稿' })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: '发布' }))

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[0]).toMatchObject({
      builtin: 'todo',
      handoffs: [{ on: 'done', workflowId: 'w2', stageId: 'b1' }],
    })
  })

  it('编辑已有工作流：回显交接目标、排除自身候选、切换工作流重置阶段、回传阶段 id', async () => {
    const current = workflowOf([
      {
        name: '待办',
        builtin: 'todo',
        handoffs: [{ on: 'done', workflowId: 'w2', stageId: 'b1' }],
      },
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
          exits: {},
          judge: null,
          handoffs: [],
        },
        {
          id: 'b1',
          workflowId: 'w2',
          name: '发布',
          position: 1,
          entryMode: 'agent',
          agentId: 'ag1',
          exits: {},
          judge: null,
          handoffs: [],
        },
      ],
    }
    const archive: WorkflowWithStages = { ...target, id: 'w3', name: '归档', stages: [] }
    kernel.setView('workflows.all', undefined, [current, target, archive])
    kernel.setView('agents.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={current} onSave={onSave} onCancel={vi.fn()} />)

    // 默认展开第一个自己添加的阶段（进行中）；派单挂在「待办」上，点开它
    await user.click(screen.getByRole('button', { name: '阶段1' }))
    expect(
      await screen.findByRole('combobox', { name: '阶段1派单1目标工作流' }),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '阶段1派单1目标工作流' })).toHaveTextContent(
        '写作',
      ),
    )
    expect(screen.getByRole('combobox', { name: '阶段1派单1目标阶段' })).toHaveTextContent('发布')
    // 进行中没配派单：它一行都没有
    await user.click(screen.getByRole('button', { name: '阶段2' }))
    expect(screen.queryByRole('combobox', { name: '阶段2派单1目标阶段' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '阶段1' }))

    // 当前工作流不在候选里
    await user.click(screen.getByRole('combobox', { name: '阶段1派单1目标工作流' }))
    expect(screen.queryByRole('option', { name: '研发' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    // 删除这一行 → 整行消失；再加一行 → 触发条件回到本阶段的默认（跑完时）、目标为首阶段
    await user.click(screen.getByRole('button', { name: '阶段1删除派单1' }))
    expect(screen.queryByRole('combobox', { name: '阶段1派单1目标工作流' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '阶段1新增派单' }))
    expect(screen.getByRole('combobox', { name: '阶段1派单1触发' })).toHaveTextContent('跑完时')
    expect(screen.getByRole('combobox', { name: '阶段1派单1目标阶段' })).toHaveTextContent('首阶段')
    await choose(user, '阶段1派单1目标阶段', '发布')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(draft.stages[0]).toMatchObject({
      id: 's0',
      handoffs: [{ on: 'done', workflowId: 'w2', stageId: 'b1' }],
    })
    expect(draft.stages[1]).toMatchObject({ id: 's1', handoffs: [] })
  }, 30_000)

  it('交接目标工作流已不在清单：目标阶段候选为空，仍按视图值回显', () => {
    const existing = workflowOf([
      {
        name: '待办',
        builtin: 'todo',
        handoffs: [{ on: 'done', workflowId: 'gone', stageId: 'gs0' }],
      },
      BUILTIN_SPECS[1],
      BUILTIN_SPECS[2],
      BUILTIN_SPECS[3],
    ])
    kernel.setView('workflows.all', undefined, [])
    kernel.setView('agents.all', undefined, [])
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)
    // 目标的 id 仍原样回传（不在候选里，下拉按未设置展示），目标阶段候选为空
    expect(screen.getByRole('combobox', { name: '阶段1派单1目标工作流' })).toHaveTextContent(
      '选择工作流',
    )
    expect(screen.getByRole('combobox', { name: '阶段1派单1目标阶段' })).toHaveTextContent('首阶段')
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

  it('移动别的阶段：展开项不跳，被让位时才跟着换（左侧行内拖动）', async () => {
    const existing = workflowWith([{ name: 'A' }, { name: 'B' }, { name: 'C' }])
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)

    const order = (): (string | null)[] =>
      ['阶段2', '阶段3', '阶段4'].map(
        (name) => screen.getByRole('button', { name }).textContent ?? null,
      )

    // 展开 A，把 C 拖到 B 的位置：A 仍在展开，C 进到第 3 行
    await user.click(screen.getByRole('button', { name: '阶段2' }))
    dragStageRow(4, 3)
    expect(order()).toEqual(['2A', '3C', '4B'])
    expect(screen.getByLabelText('阶段2名称')).toHaveValue('A')

    // 展开 B（现在第 4 行），把 C 拖回去：B 被让到第 3 行，展开项跟着走
    await user.click(screen.getByRole('button', { name: '阶段4' }))
    expect(screen.getByLabelText('阶段4名称')).toHaveValue('B')
    dragStageRow(3, 4)
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

  it('拖动阶段：目标指向被让位的阶段时，目标下标 +1（重映射往上挪的方向）', async () => {
    const existing = workflowWith([
      { name: 'A', exits: { done: { goto: 'B' } } },
      { name: 'B' },
      { name: 'C' },
    ])
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // C 拖到 B 的位置：B 从下标 3 被挤到 4，A 指向 B 的下标要同步 +1
    dragStageRow(4, 3)
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
    expect(savedStage(draft, 'A').exits).toEqual([{ on: 'done', do: 'goto', stageIndex: 3 }])
  })

  it('拖动阶段：目标指向被让位的阶段时，目标下标 -1（重映射往下挪的方向）', async () => {
    const existing = workflowWith([
      { name: 'A' },
      { name: 'B' },
      { name: 'C', exits: { done: { goto: 'B' } } },
    ])
    kernel.setView('agents.all', undefined, [])
    kernel.setView('workflows.all', undefined, [])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // A 拖到 B 的位置：B 从下标 3 被挤到 2，C 指向 B 的下标要同步 -1
    dragStageRow(2, 3)
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
    expect(savedStage(draft, 'C').exits).toEqual([{ on: 'done', do: 'goto', stageIndex: 1 }])
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

  it('闸门：切到闸门自动交给智能体，护栏与两侧出口可编辑（M32）', async () => {
    const existing = workflowWith([{ name: '执行' }, { name: '自测' }, { name: '结束' }])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段3' }))
    await choose(user, '阶段3类型', '闸门（判定）')

    // 切到闸门即自动交给智能体，并给出默认 3 次护栏
    expect(screen.getByRole('combobox', { name: '阶段3智能体' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '阶段3放行护栏' })).toHaveTextContent('3 次')
    // 判定阶段没有「完成时」这一行：跑完没结论不构成去向
    expect(screen.queryByRole('combobox', { name: '阶段3完成时去向' })).not.toBeInTheDocument()

    await choose(user, '阶段3放行护栏', '5 次')
    await choose(user, '阶段3智能体', 'coder')
    await choose(user, '阶段3通过时去向', '进入指定阶段')
    await choose(user, '阶段3通过时目标阶段', '结束')
    await choose(user, '阶段3未通过时去向', '进入指定阶段')
    await choose(user, '阶段3未通过时目标阶段', '执行')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '自测')).toMatchObject({
      entryMode: 'agent',
      agentId: 'ag1',
      judge: { maxFails: 5 },
      // 「结束」在下标 3、「执行」在下标 1
      exits: [
        { on: 'passed', do: 'goto', stageIndex: 3 },
        { on: 'failed', do: 'goto', stageIndex: 1 },
      ],
    })
  }, 30_000)

  it('闸门：已有配置还原成判定者 + 出口表，切回普通类型清掉判定者（M32）', async () => {
    const existing = workflowWith([
      { name: '执行' },
      {
        name: '自测',
        judge: { maxFails: 2 },
        exits: { passed: { goto: '结束' }, failed: { goto: '执行' } },
      },
      { name: '结束' },
    ])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段3' }))
    // 还原：类型显示为闸门，护栏与两侧出口的目标阶段按下标回填
    expect(screen.getByRole('combobox', { name: '阶段3类型' })).toHaveTextContent('闸门（判定）')
    expect(screen.getByRole('combobox', { name: '阶段3放行护栏' })).toHaveTextContent('2 次')
    expect(screen.getByRole('combobox', { name: '阶段3通过时目标阶段' })).toHaveTextContent('结束')
    expect(screen.getByRole('combobox', { name: '阶段3未通过时目标阶段' })).toHaveTextContent(
      '执行',
    )

    // 切回普通类型：判定者消失，出口表换成完成 / 出错两行
    await choose(user, '阶段3类型', '交给智能体')
    expect(screen.queryByRole('combobox', { name: '阶段3放行护栏' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '阶段3通过时去向' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '阶段3完成时去向' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    // 判定两侧的出口一并收掉（内核不接受非判定阶段有通过 / 未通过）
    expect(savedStage(draft, '自测')).toMatchObject({
      entryMode: 'agent',
      judge: null,
      exits: [],
    })
  }, 30_000)

  it('不交接：同样只留名称与类型，保存时把看不见的字段归一', async () => {
    const existing = workflowWith([
      {
        name: '实现',
        exits: { done: { goto: '收尾' }, errored: { goto: '收尾' } },
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
      '阶段2完成时去向',
      '阶段2出错时去向',
      '阶段2放行护栏',
      '阶段2派单1目标工作流',
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
      exits: [],
      handoffs: [],
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
      instructions: '按方案实现',
      // M20：不展示验收的类型保存时归一为空
      acceptance: [],
      runTimeoutMs: null,
      judge: null,
    })
  }, 30_000)

  it('交给用户：只留名称与类型，保存时把看不见的字段归一', async () => {
    const existing = workflowWith([
      {
        name: '实现',
        exits: { done: { goto: '收尾' } },
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
      '阶段2完成时去向',
      '阶段2出错时去向',
      '阶段2放行护栏',
      '阶段2派单1目标工作流',
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
      exits: [],
      handoffs: [],
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
      // 提示词资料段没有副作用，原文保留，切回智能体还能用
      instructions: '按方案实现',
      // M20：不展示验收的类型保存时归一为空
      acceptance: [],
      runTimeoutMs: null,
      judge: null,
    })
  }, 30_000)

  it('闸门：派单可配（不含「跑完时」），子任务仍不展示，保存时归一', async () => {
    const existing = workflowWith([
      {
        name: '实现',
        // 判定阶段没有「完成时」这一支：面板上不展示，保存前要归一掉
        exits: { done: { goto: '收尾' }, passed: { goto: '收尾' }, failed: { goto: '实现' } },
        subtaskStageId: '收尾',
        onChildrenSettled: 'wake',
        spawnPolicy: 'off',
        instructions: '跑一遍验收命令',
        judge: { maxFails: 3 },
      },
      { name: '收尾' },
    ])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 闸门只判定：护栏与通过 / 未通过 / 出错三行在，子任务不在；派单可以配（跑完没结论不算离开）
    expect(screen.getByRole('combobox', { name: '阶段2放行护栏' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '阶段2通过时去向' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '阶段2出错时去向' })).toBeInTheDocument()
    expect(screen.getByLabelText('阶段2要干什么')).toHaveValue('跑一遍验收命令')
    expect(screen.getByRole('button', { name: '阶段2新增派单' })).toBeInTheDocument()
    expect(screen.getByText('不派单。')).toBeInTheDocument()
    for (const label of [
      '阶段2派单1目标工作流',
      '阶段2子任务落点阶段',
      '阶段2子任务完成后',
      '阶段2允许拆子任务',
      // 判定阶段跑完不给结论就不算离开，没有「完成时」这一行
      '阶段2完成时去向',
    ]) {
      expect(screen.queryByRole('combobox', { name: label })).not.toBeInTheDocument()
    }

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '实现')).toMatchObject({
      entryMode: 'agent',
      agentId: 'ag1',
      judge: { maxFails: 3 },
      // 「收尾」在下标 2，「实现」在下标 1；「完成时」那一行保存前被归一掉
      exits: [
        { on: 'passed', do: 'goto', stageIndex: 2 },
        { on: 'failed', do: 'goto', stageIndex: 1 },
      ],
      instructions: '跑一遍验收命令',
    })
    // 闸门不拆子任务：子任务三项保存时归一
    expect(savedStage(draft, '实现')).toMatchObject({
      handoffs: [],
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
        handoffs: [{ on: 'done', workflowId: 'w2', stageId: 'b1' }],
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
      // 派单不渲染，取而代之的是一句说明
      expect(
        screen.queryByRole('combobox', { name: `${position}派单1目标工作流` }),
      ).not.toBeInTheDocument()
      expect(screen.getByText('已完成 / 已取消是终态，不派单。')).toBeInTheDocument()
      // 子任务是派活落点，不是交接：仍然可配
      expect(
        screen.getByRole('combobox', { name: `${position}子任务落点阶段` }),
      ).toBeInTheDocument()
    }

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '已完成')).toMatchObject({
      handoffs: [],
    })
  }, 30_000)

  it('派单：闸门阶段的行不含「跑完时」，换目标工作流后目标阶段回到首阶段', async () => {
    const existing = workflowWith([{ name: '评审', judge: { maxFails: 2 } }, { name: '修复' }])
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
          exits: {},
          judge: null,
          handoffs: [],
        },
        {
          id: 'b1',
          workflowId: 'w2',
          name: '发布',
          position: 1,
          entryMode: 'none',
          agentId: null,
          exits: {},
          judge: null,
          handoffs: [],
        },
      ],
    }
    const empty: WorkflowWithStages = { ...target, id: 'w3', name: '归档', stages: [] }
    kernel.setView('workflows.all', undefined, [existing, target, empty])
    kernel.setView('agents.all', undefined, [agent])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 「评审」是第 2 行（待办之后）；闸门只判定，跑完没结论不算离开
    await user.click(screen.getByRole('button', { name: '阶段2' }))
    await user.click(screen.getByRole('button', { name: '阶段2新增派单' }))
    await user.click(screen.getByRole('combobox', { name: '阶段2派单1触发' }))
    expect(screen.queryByRole('option', { name: '跑完时' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('option', { name: '通过时' }))

    // 选好目标阶段后换目标工作流：目标阶段回到「首阶段」
    await user.click(screen.getByRole('combobox', { name: '阶段2派单1目标工作流' }))
    await user.click(await screen.findByRole('option', { name: '写作' }))
    await choose(user, '阶段2派单1目标阶段', '发布')
    await user.click(screen.getByRole('combobox', { name: '阶段2派单1目标工作流' }))
    await user.click(await screen.findByRole('option', { name: '归档' }))
    expect(screen.getByRole('combobox', { name: '阶段2派单1目标阶段' })).toHaveTextContent('首阶段')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '评审')).toMatchObject({
      handoffs: [{ on: 'passed', workflowId: 'w3', stageId: null }],
    })
  }, 30_000)

  it('新增阶段落在「已阻塞」之前：指向内置阶段的出口下标顺延', async () => {
    const existing = workflowWith([{ name: 'A', exits: { done: { goto: '已阻塞' } } }])
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
    expect(savedStage(draft, 'A').exits).toEqual([{ on: 'done', do: 'goto', stageIndex: 3 }])
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
          exits: [{ on: 'done', do: 'goto', stageIndex: 5 }],
          handoffs: [],
          subtaskStageId: null,
          onChildrenSettled: null,
          spawnPolicy: null,
          instructions: '',
          acceptance: [],
          runTimeoutMs: null,
          judge: null,
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
          exits: [{ on: 'done', do: 'goto', stageIndex: 9 }],
          handoffs: [],
          subtaskStageId: null,
          onChildrenSettled: null,
          spawnPolicy: null,
          instructions: '',
          acceptance: [],
          runTimeoutMs: null,
          judge: null,
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
      { name: 'A', exits: { done: { goto: 'C' } } },
      { name: 'B', exits: { done: { goto: 'C' } } },
      { name: 'C' },
    ])
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 删掉 B：C 从下标 4 前移到 3，A 的「完成时」出口要跟着改
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
    expect(savedStage(draft, 'A').exits).toEqual([{ on: 'done', do: 'goto', stageIndex: 2 }])
  })
})

describe('WorkflowEditor 阶段流转目标与闸门去向', () => {
  beforeEach(() => {
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [])
  })

  it('闸门出口指向已不存在的阶段：目标还原成未指定（等重新选）', async () => {
    const existing = workflowWith([
      { name: '执行' },
      { name: '判定', judge: { maxFails: 2 } },
      { name: '收尾' },
    ])
    // 目标阶段已被删：视图里只剩 id，编辑器还原不出下标
    const gone: StagePrimary = { do: 'goto', stageId: 'gone' }
    const stages = existing.stages.map((stage) =>
      stage.name === '判定' ? { ...stage, exits: { ...stage.exits, passed: gone } } : stage,
    )
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={{ ...existing, stages }} onSave={onSave} onCancel={vi.fn()} />)

    // 落点不在阶段列表里：目标按「未指定」回显，未通过这一行仍是默认（停在这里等人）
    await user.click(screen.getByRole('button', { name: '阶段3' }))
    expect(screen.getByRole('combobox', { name: '阶段3通过时去向' })).toHaveTextContent(
      '进入指定阶段',
    )
    expect(screen.getByRole('combobox', { name: '阶段3通过时目标阶段' })).toHaveTextContent(
      '选择阶段',
    )
    expect(screen.getByRole('combobox', { name: '阶段3未通过时去向' })).toHaveTextContent(
      '默认（停在这里等人）',
    )

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '判定').judge).toEqual({ maxFails: 2 })
    // 目标没还原出来：留 null，保存前的悬空目标校验不误报（指到 -1 才算悬空）
    expect(savedStage(draft, '判定').exits).toEqual([
      { on: 'passed', do: 'goto', stageIndex: null },
    ])
  })

  it('删掉被别的阶段指向的阶段：那个目标清成 null（不会静默指到别的阶段）', async () => {
    const existing = workflowWith([
      { name: 'A', exits: { done: { goto: 'B' } } },
      { name: 'B' },
      // C 指回 A：删掉中间的 B 时，它前面的目标不该被动到
      { name: 'C', exits: { errored: { goto: 'A' } } },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 删掉 B：A 的「完成时」正好指向它，不能改成指向 C
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
    expect(savedStage(draft, 'A').exits).toEqual([{ on: 'done', do: 'goto', stageIndex: null }])
    // C 指向删除点之前的 A：下标不变
    expect(savedStage(draft, 'C').exits).toEqual([{ on: 'errored', do: 'goto', stageIndex: 1 }])
  })

  it('删阶段：带判定的阶段保住判定者并重映射出口，没判定的阶段判定者仍为 null', async () => {
    const existing = workflowWith([
      { name: 'A' },
      { name: '判定', judge: { maxFails: 2 }, exits: { passed: { goto: 'C' } } },
      { name: 'C' },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // 删掉 A：判定阶段还在，它的判定者要保住，出口跟着重映射
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
    // C 从下标 3 前移到 2，判定的「通过时」跟着改
    expect(savedStage(draft, '判定').judge).toEqual({ maxFails: 2 })
    expect(savedStage(draft, '判定').exits).toEqual([{ on: 'passed', do: 'goto', stageIndex: 2 }])
    // 没判定的阶段判定者仍是 null
    expect(savedStage(draft, 'C').judge).toBeNull()
  })

  it('拖动阶段：带判定的阶段保住判定者，出口跟着重映射', async () => {
    const existing = workflowWith([
      { name: 'A' },
      { name: '判定', judge: { maxFails: 2 }, exits: { passed: { goto: 'C' } } },
      { name: 'C' },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    // C 拖到判定的位置：C 从下标 3 移到 2，判定的「通过时」要跟着改
    dragStageRow(4, 3)
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
    expect(savedStage(draft, '判定').judge).toEqual({ maxFails: 2 })
    expect(savedStage(draft, '判定').exits).toEqual([{ on: 'passed', do: 'goto', stageIndex: 2 }])
  })

  it('闸门两个去向可以选回默认：通过=下一阶段、未通过=停在这里等人', async () => {
    const existing = workflowWith([
      { name: '执行' },
      {
        name: '判定',
        judge: { maxFails: 2 },
        exits: { passed: { goto: '收尾' }, failed: { goto: '执行' } },
      },
      { name: '收尾' },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段3' }))
    // 先换成别的动作，再选回「默认」：这一行从出口表里收回去，由内核补缺省
    await choose(user, '阶段3通过时去向', '停在这里等人')
    await choose(user, '阶段3未通过时去向', '结束并归档')
    await choose(user, '阶段3通过时去向', '默认（下一阶段）')
    await choose(user, '阶段3未通过时去向', '默认（停在这里等人）')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '判定').judge).toEqual({ maxFails: 2 })
    expect(savedStage(draft, '判定').exits).toEqual([])
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
          exits: [],
          handoffs: [],
          subtaskStageId: null,
          onChildrenSettled: null,
          spawnPolicy: null,
          judge: null,
        },
      ],
    }
    render(<WorkflowEditor workflow={null} initial={initial} onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByLabelText('阶段1要干什么')).toHaveValue('')
  })

  it('执行阶段不渲染验收输入框：判据只属于闸门（M34）', async () => {
    const existing = workflowWith([
      // M34 迁移前的脏数据：执行阶段上还挂着验收条目
      { name: '执行', acceptance: ['pnpm check 退出码 0'] },
      { name: '收尾' },
    ])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段2' }))
    // 交智能体的执行阶段：要干什么在，验收与轮次都不在
    expect(screen.getByLabelText('阶段2要干什么')).toBeInTheDocument()
    expect(screen.queryByLabelText('阶段2验收')).not.toBeInTheDocument()
    expect(screen.queryByText(/判定者要逐条给证据/)).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '阶段2轮次上限' })).not.toBeInTheDocument()
  }, 30_000)

  it('保存执行阶段时验收归一为空：看不见的判据不提交', async () => {
    const existing = workflowWith([
      { name: '执行', acceptance: ['pnpm check 退出码 0', '不改数据库 schema'] },
      { name: '收尾' },
    ])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    // 执行阶段不声明验收：留着内核会以「非判定阶段配了验收」整份拒收
    expect(savedStage(draft, '执行').acceptance).toEqual([])
    expect(savedStage(draft, '执行')).toMatchObject({ entryMode: 'agent', judge: null })
  }, 30_000)

  it('闸门阶段渲染验收：一条一行、按 1 基序号展示，并给出逐条给证据的提示', async () => {
    const existing = workflowWith([
      { name: '执行' },
      {
        name: '评审',
        judge: { maxFails: 2 },
        acceptance: ['pnpm check 退出码 0', '覆盖每条 Given/When/Then'],
      },
    ])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段3' }))
    // 提示写清判定者的义务：checks 里带 acceptance 序号，漏一条算没给结论
    expect(screen.getByText(/checks 里带 acceptance 序号/)).toBeInTheDocument()
    const acceptance = screen.getByLabelText('阶段3验收')
    expect(acceptance).toHaveValue('pnpm check 退出码 0\n覆盖每条 Given/When/Then')

    // 序号与提示词同口径（1 基），编辑时仍按行
    const sequence = screen.getByRole('list', { name: '阶段3验收序号' })
    expect(
      within(sequence)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['1. pnpm check 退出码 0', '2. 覆盖每条 Given/When/Then'])

    fireEvent.change(acceptance, {
      target: { value: 'pnpm check 退出码 0\n覆盖每条 Given/When/Then\n没有 P0 未解决问题' },
    })
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '评审')).toMatchObject({
      judge: { maxFails: 2 },
      acceptance: ['pnpm check 退出码 0', '覆盖每条 Given/When/Then', '没有 P0 未解决问题'],
    })
  }, 30_000)

  it('闸门没有验收条目：说明只要求一条全 0 的 checks，保存提交空数组', async () => {
    const existing = workflowWith([{ name: '执行' }, { name: '评审', judge: { maxFails: 2 } }])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段3' }))
    expect(screen.getByText(/闸门只要求一条退出码全 0 的 checks/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '阶段3验收序号' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    expect(savedStage(draft, '评审').acceptance).toEqual([])
  }, 30_000)

  it('闸门阶段：单轮超时选「默认」回落到 null（改用全局缺省）', async () => {
    const existing = workflowWith([{ name: '执行' }, { name: '评审', judge: { maxFails: 2 } }])
    const gate = existing.stages.find((item) => item.name === '评审')
    if (gate === undefined) throw new Error('夹具缺「评审」阶段')
    gate.runTimeoutMs = 600_000
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={onSave} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '阶段3' }))
    expect(screen.getByRole('combobox', { name: '阶段3单轮超时' })).toHaveTextContent('10 分钟')
    await choose(user, '阶段3单轮超时', '默认（60 分钟）')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const draft = onSave.mock.calls[0][0] as WorkflowInput
    // null 表示用全局缺省，不是 0 / 60 分钟写死
    expect(savedStage(draft, '评审')).toMatchObject({ runTimeoutMs: null })
  }, 30_000)
})

describe('moveStageToIndex（拖动落点：跨多行也一样重映射）', () => {
  const stages = (): StageInput[] => [
    {
      name: 'A',
      entryMode: 'agent',
      exits: [{ on: 'done', do: 'goto', stageIndex: 1 }],
      judge: null,
    },
    {
      name: 'B',
      entryMode: 'agent',
      exits: [{ on: 'errored', do: 'goto', stageIndex: 0 }],
      judge: null,
    },
    {
      name: 'C',
      entryMode: 'agent',
      judge: { maxFails: 2 },
      exits: [
        { on: 'passed', do: 'goto', stageIndex: 0 },
        { on: 'failed', do: 'goto', stageIndex: 2 },
      ],
    },
    { name: 'D', entryMode: 'none', exits: [], judge: null },
  ]

  it('相邻一格（抓手上的 ↑ / ↓ 走同一条路径）：换位且选中跟着走', () => {
    const moved = moveStageToIndex(stages(), 0, 0, 1)
    expect(moved.stages.map((stage) => stage.name)).toEqual(['B', 'A', 'C', 'D'])
    expect(moved.selected).toBe(1)
  })

  it('往下拖：被跨过的整体前移一格，出口表的下标跟着重映射', () => {
    const moved = moveStageToIndex(stages(), 1, 0, 2)
    expect(moved.stages.map((stage) => stage.name)).toEqual(['B', 'C', 'A', 'D'])
    // A 从 0 落到 2：它自己的「完成时」原本指向 B(1)，B 让到 0
    expect(moved.stages[2].exits).toEqual([{ on: 'done', do: 'goto', stageIndex: 0 }])
    // B 的「出错时」原本指向 A(0)，A 现在在 2
    expect(moved.stages[0].exits).toEqual([{ on: 'errored', do: 'goto', stageIndex: 2 }])
    // 选中跟着让位后的下标走
    expect(moved.selected).toBe(0)
  })

  it('往上拖：被跨过的整体后移一格，判定两侧的出口一起重映射', () => {
    const moved = moveStageToIndex(stages(), 2, 2, 0)
    expect(moved.stages.map((stage) => stage.name)).toEqual(['C', 'A', 'B', 'D'])
    // C 自己带着判定：通过 = A(0) 现在在 1，「未通过 = 自己」从 2 变 0
    expect(moved.stages[0].judge).toEqual({ maxFails: 2 })
    expect(moved.stages[0].exits).toEqual([
      { on: 'passed', do: 'goto', stageIndex: 1 },
      { on: 'failed', do: 'goto', stageIndex: 0 },
    ])
    // A 的「完成时」原本指向 B(1)，B 让到 2；B 的「出错时」指向 A(0)，A 让到 1
    expect(moved.stages[1].exits).toEqual([{ on: 'done', do: 'goto', stageIndex: 2 }])
    expect(moved.stages[2].exits).toEqual([{ on: 'errored', do: 'goto', stageIndex: 1 }])
    expect(moved.selected).toBe(0)
  })

  it('原地 / 越界：阶段与选中下标原样返回', () => {
    const original = stages()
    expect(moveStageToIndex(original, 1, 0, 0)).toEqual({ stages: original, selected: 1 })
    expect(moveStageToIndex(original, 1, -1, 2)).toEqual({ stages: original, selected: 1 })
    expect(moveStageToIndex(original, 1, 0, -1)).toEqual({ stages: original, selected: 1 })
    expect(moveStageToIndex(original, 1, 0, 4)).toEqual({ stages: original, selected: 1 })
    expect(moveStageToIndex(original, 1, 4, 0)).toEqual({ stages: original, selected: 1 })
  })
})

describe('出口表的健壮性（M32）', () => {
  it('视图里的阶段缺 exits 字段时按「没配」渲染，不抛错', () => {
    const legacy = workflowWith([{ name: '评审' }])
    // 半迁移 / 老库数据：阶段行没有 exits
    const broken = {
      ...legacy,
      stages: legacy.stages.map((item) => {
        const clone = { ...item } as Record<string, unknown>
        delete clone.exits
        return clone
      }),
    } as unknown as WorkflowWithStages
    kernel.setView('workflows.all', undefined, [broken])
    kernel.setView('agents.all', undefined, [agent])

    render(<WorkflowEditor workflow={broken} onSave={vi.fn()} onCancel={vi.fn()} />)

    expect(screen.getByRole('combobox', { name: '阶段2完成时去向' })).toHaveTextContent(
      '默认（下一阶段）',
    )
  })
})

describe('出口表：没有原地重跑（M34）', () => {
  it('去向里不再有「原地重跑」，也没有重跑次数下拉', async () => {
    const existing = workflowWith([{ name: '实现' }, { name: '收尾' }])
    kernel.setView('agents.all', undefined, [agent])
    kernel.setView('workflows.all', undefined, [existing])
    const user = userEvent.setup()
    render(<WorkflowEditor workflow={existing} onSave={vi.fn()} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('combobox', { name: '阶段2出错时去向' }))
    expect(await screen.findByRole('option', { name: '停在这里等人' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '原地重跑' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('combobox', { name: '阶段2出错时最多重跑' })).not.toBeInTheDocument()
  }, 30_000)
})
