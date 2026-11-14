import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowStage, WorkflowWithStages } from '../../../../../../src/protocol/entities'
import type { AutomationRule } from '../../../../../../src/protocol/rules'
import { RulesManager } from '../../../../../../src/renderer/src/apps/ai-workflow/components/RulesManager'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

function stage(id: string, workflowId: string, name: string, position: number): WorkflowStage {
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

function wf(id: string, name: string, stageNames: string[]): WorkflowWithStages {
  return {
    id,
    name,
    description: '',
    createdAt: 't',
    stages: stageNames.map((stageName, index) => stage(`${id}-s${index}`, id, stageName, index)),
  }
}

const issueRule: AutomationRule = {
  id: 'r1',
  name: 'Issue 进研发',
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId: 'w1', stageId: 'w1-s0', task: { titleFrom: 'subject' } },
  enabled: true,
}

const dailyRule: AutomationRule = {
  id: 'r2',
  name: '每日早报',
  when: { cron: '0 9 * * *' },
  to: { workflowId: 'w1' },
  prompt: '汇总昨日进展并给出今日计划',
  enabled: false,
}

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
})

afterEach(() => {
  stopFakeKernel()
  vi.unstubAllGlobals()
})

/** 视图种子：规则清单 + 两个工作流（规则目标与阶段名断言用） */
function seed(rules: AutomationRule[], version = 1): void {
  kernel.setView('rules.all', undefined, { version, rules })
  kernel.setView('workflows.all', undefined, [
    wf('w1', '研发', ['待办', '审核']),
    wf('w2', '写作', ['草稿']),
  ])
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

describe('RulesManager', () => {
  it('空清单显示空态；没有工作流时模板禁用并提示先建工作流', async () => {
    kernel.setView('rules.all', undefined, { version: 0, rules: [] })
    kernel.setView('workflows.all', undefined, [])
    render(<RulesManager />)

    expect(await screen.findByText('暂无规则')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Issue 进研发' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '每日早报' })).toBeDisabled()
    expect(screen.getByText('先建工作流')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建规则' })).toBeEnabled()
  })

  it('列表展示名称、条件摘要、目标工作流/阶段与版本', async () => {
    seed([issueRule, dailyRule], 3)
    render(<RulesManager />)

    expect(await screen.findByText('Issue 进研发')).toBeInTheDocument()
    expect(screen.getByText('事件 · github · issues.opened')).toBeInTheDocument()
    expect(screen.getByText('定时 · 0 9 * * *')).toBeInTheDocument()
    expect(screen.getByText('→ 研发 / 待办')).toBeInTheDocument()
    expect(screen.getByText('→ 研发 · 含提示词')).toBeInTheDocument()
    expect(screen.getByText('v3')).toBeInTheDocument()
    expect(screen.getByText('共 2 条')).toBeInTheDocument()
    // 停用标记 + 立即运行禁用
    expect(screen.getByText('已停用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '立即运行 每日早报' })).toBeDisabled()
  })

  it('启停：整批 dispatch rules.replace，顺序与原字段保持', async () => {
    seed([issueRule, dailyRule])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('Issue 进研发')

    await user.click(screen.getByLabelText('启用规则 Issue 进研发'))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'rules.replace',
      rules: [
        { id: 'r1', enabled: false },
        { id: 'r2', enabled: false },
      ],
    })
  })

  it('删除：整批替换后只剩其余规则', async () => {
    seed([issueRule, dailyRule])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('Issue 进研发')

    await user.click(screen.getByRole('button', { name: '删除规则 Issue 进研发' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({ type: 'rules.replace', rules: [{ id: 'r2' }] })
  })

  it('删除失败：展示后端文案，列表不变', async () => {
    kernel.onDispatch(() => Promise.reject(new Error('整批非法')))
    seed([issueRule])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('Issue 进研发')

    await user.click(screen.getByRole('button', { name: '删除规则 Issue 进研发' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('整批非法')
    // 视图未刷新：行内编辑按钮仍在（列表不变）
    expect(screen.getByRole('button', { name: '编辑规则 Issue 进研发' })).toBeInTheDocument()
    // 写命令的失败可手动关掉
    await user.click(screen.getByRole('button', { name: '关闭错误提示' }))
    expect(screen.queryByText('整批非法')).not.toBeInTheDocument()
  })

  it('立即运行：dispatch rule.trigger；失败展示内核文案', async () => {
    seed([issueRule])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('Issue 进研发')

    await user.click(screen.getByRole('button', { name: '立即运行 Issue 进研发' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({ type: 'rule.trigger', ruleId: 'r1' })
  })

  it('立即运行失败：原样展示错误（如规则已停用）', async () => {
    kernel.onDispatch(() => Promise.reject(new Error('规则已停用')))
    seed([issueRule])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('Issue 进研发')

    await user.click(screen.getByRole('button', { name: '立即运行 Issue 进研发' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('规则已停用')
  })

  it('立即运行失败：非 Error 的拒绝按字符串展示', async () => {
    kernel.onDispatch(() => Promise.reject('桥接断开'))
    seed([issueRule])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('Issue 进研发')

    await user.click(screen.getByRole('button', { name: '立即运行 Issue 进研发' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('桥接断开')
  })

  it('新建并保存：dispatch 整批（原规则 + 新规则），成功后关闭弹窗', async () => {
    seed([])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('暂无规则')

    await user.click(screen.getByRole('button', { name: '新建规则' }))
    await user.type(await screen.findByLabelText('规则名称'), '新规则')
    await choose(user, '规则目标工作流', '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'rules.replace',
      rules: [
        {
          name: '新规则',
          when: { source: '', types: [] },
          to: { workflowId: 'w1' },
          enabled: true,
        },
      ],
    })
    expect(screen.queryByLabelText('规则名称')).not.toBeInTheDocument()
  })

  it('编辑保存：按 id 原位替换，其余规则不动', async () => {
    seed([issueRule, dailyRule])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('Issue 进研发')

    await user.click(screen.getByRole('button', { name: '编辑规则 Issue 进研发' }))
    const nameInput = await screen.findByLabelText('规则名称')
    expect(nameInput).toHaveValue('Issue 进研发')
    await user.clear(nameInput)
    await user.type(nameInput, 'Issue 进研发 v2')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'rules.replace',
      rules: [
        { id: 'r1', name: 'Issue 进研发 v2' },
        { id: 'r2', name: '每日早报' },
      ],
    })
    expect(screen.queryByLabelText('规则名称')).not.toBeInTheDocument()
  })

  it('模板「Issue 进研发」：预填 name/source/types/titleFrom，工作流留给用户选', async () => {
    seed([])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('暂无规则')

    await user.click(screen.getByRole('button', { name: 'Issue 进研发' }))
    expect(await screen.findByLabelText('规则名称')).toHaveValue('Issue 进研发')
    expect(screen.getByLabelText('规则事件来源')).toHaveValue('github')
    expect(screen.getByLabelText('规则事件类型')).toHaveValue('issues.opened')
    expect(screen.getByRole('combobox', { name: '规则目标工作流' })).toHaveTextContent('选择工作流')

    await choose(user, '规则目标工作流', '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'rules.replace',
      rules: [
        {
          name: 'Issue 进研发',
          when: { source: 'github', types: ['issues.opened'] },
          to: { workflowId: 'w1', task: { titleFrom: 'subject' } },
        },
      ],
    })
  })

  it('模板「每日早报」：预填 cron 与固定提示词', async () => {
    seed([])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('暂无规则')

    await user.click(screen.getByRole('button', { name: '每日早报' }))
    expect(await screen.findByLabelText('规则名称')).toHaveValue('每日早报')
    expect(screen.getByRole('combobox', { name: '规则触发方式' })).toHaveTextContent('定时')
    expect(screen.getByLabelText('cron 表达式')).toHaveValue('0 9 * * *')
    expect(screen.getByLabelText('规则提示词')).toHaveValue('汇总昨日进展并给出今日计划')

    await choose(user, '规则目标工作流', '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'rules.replace',
      rules: [
        {
          name: '每日早报',
          when: { cron: '0 9 * * *' },
          prompt: '汇总昨日进展并给出今日计划',
        },
      ],
    })
  })

  it('rules.all 读取失败展示错误', async () => {
    kernel.failView('rules.all', undefined, 'rules-down')
    render(<RulesManager />)
    expect(await screen.findByRole('alert')).toHaveTextContent('rules-down')
  })

  it('保存失败：错误留在弹窗内，列表不关闭', async () => {
    kernel.onDispatch(() => Promise.reject(new Error('cron 非法')))
    seed([])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('暂无规则')

    await user.click(screen.getByRole('button', { name: '新建规则' }))
    await user.type(await screen.findByLabelText('规则名称'), 'x')
    await choose(user, '规则目标工作流', '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('cron 非法')).toBeInTheDocument()
    expect(screen.getByLabelText('规则名称')).toBeInTheDocument()
  })

  it('整批替换进行中禁用行内动作与新建（防并发覆盖）', async () => {
    kernel.onDispatch(() => new Promise(() => {}))
    seed([issueRule])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('Issue 进研发')

    await user.click(screen.getByRole('button', { name: '删除规则 Issue 进研发' }))
    expect(await screen.findByRole('button', { name: '新建规则' })).toBeDisabled()
    expect(screen.getByLabelText('启用规则 Issue 进研发')).toBeDisabled()
    expect(screen.getByRole('button', { name: '立即运行 Issue 进研发' })).toBeDisabled()
    // 整批写入进行中：说清楚为什么整排都点不动
    expect(screen.getByText('正在写入规则…')).toBeInTheDocument()
  })

  it('取消新建弹窗：不 dispatch、不发规则命令', async () => {
    seed([])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('暂无规则')

    await user.click(screen.getByRole('button', { name: '新建规则' }))
    await screen.findByLabelText('规则名称')
    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByLabelText('规则名称')).not.toBeInTheDocument()
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('目标工作流已不存在时回落到 id 展示', async () => {
    seed([
      {
        id: 'r9',
        name: '悬空规则',
        when: { source: 'github', types: ['issues.opened'] },
        to: { workflowId: 'w-missing' },
        enabled: true,
      },
    ])
    render(<RulesManager />)
    expect(await screen.findByText('→ w-missing')).toBeInTheDocument()
  })

  it('立即运行中：行内按钮显示运行中', async () => {
    kernel.onDispatch(() => new Promise(() => {}))
    seed([issueRule])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('Issue 进研发')

    await user.click(screen.getByRole('button', { name: '立即运行 Issue 进研发' }))
    expect(screen.getByRole('button', { name: '立即运行 Issue 进研发' })).toHaveTextContent(
      '运行中…',
    )
  })

  it('无 WebCrypto 时用时间戳 + 计数生成规则 id', async () => {
    seed([])
    const user = userEvent.setup()
    render(<RulesManager />)
    await screen.findByText('暂无规则')

    vi.stubGlobal('crypto', {})
    await user.click(screen.getByRole('button', { name: '新建规则' }))
    vi.unstubAllGlobals()
    await user.type(await screen.findByLabelText('规则名称'), '回退 id')
    await choose(user, '规则目标工作流', '研发')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'rules.replace',
      rules: [{ id: expect.stringMatching(/^rule-\d+-\d+$/), name: '回退 id' }],
    })
  })
})

describe('RulesManager：下次触发与预演入口（M36-F）', () => {
  it('定时规则显示下次触发；事件规则不显示', async () => {
    seed([issueRule, { ...dailyRule, enabled: true }])
    kernel.setViewAnyParams('rules.next', [
      { ruleId: 'r1', enabled: true, nextAt: null },
      { ruleId: 'r2', enabled: true, nextAt: '2026-11-15T01:00:00.000Z' },
    ])

    render(<RulesManager />)
    await waitFor(() => expect(screen.getByText('Issue 进研发')).toBeInTheDocument())
    // 本地时区不同会让具体时刻变化，只断言「有下一次触发的行」存在且只有一条
    expect(screen.getAllByText(/^下次触发 /)).toHaveLength(1)
  })

  it('「试跑事件」开合预演面板（只读，不写规则）', async () => {
    seed([issueRule])
    kernel.setViewAnyParams('rules.next', [])
    kernel.setViewAnyParams('rules.preview', { matches: [], wouldCreate: false })

    render(<RulesManager />)
    await userEvent.click(screen.getByRole('button', { name: '试跑事件' }))
    expect(screen.getByRole('button', { name: '试跑' })).toBeInTheDocument()
    expect(kernel.dispatched).toEqual([])

    await userEvent.click(screen.getByRole('button', { name: '收起试跑' }))
    expect(screen.queryByRole('button', { name: '试跑' })).not.toBeInTheDocument()
  })
})
