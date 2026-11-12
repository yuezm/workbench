import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Command } from '../../../../../../src/protocol/commands'
import type { WorkflowWithStages } from '../../../../../../src/protocol/entities'
import type { DispatchResult } from '../../../../../../src/protocol/ipc'
import { WorkflowManager } from '../../../../../../src/renderer/src/apps/ai-workflow/components/WorkflowManager'
import {
  ENTITY_ORDER_STORAGE_KEYS,
  resetEntityOrderForTest,
} from '../../../../../../src/renderer/src/apps/ai-workflow/model/entity-order'
import { SOP_TEMPLATES } from '../../../../../../src/renderer/src/apps/ai-workflow/model/sop-templates'
import { installFakeKernel, stopFakeKernel, type FakeKernel } from '../../../../shell/fake-kernel'

function wf(id: string, name: string, stages = 0, description = ''): WorkflowWithStages {
  return {
    id,
    name,
    description,
    createdAt: 't',
    stages: Array.from({ length: stages }, (_, i) => ({
      id: `${id}-s${i}`,
      workflowId: id,
      name: `阶段${i + 1}`,
      position: i,
      entryMode: 'none' as const,
      agentId: null,
      onCompleteStageId: null,
      onRejectStageId: null,
      handoffWorkflowId: null,
      handoffStageId: null,
    })),
  }
}

let kernel: FakeKernel

beforeEach(() => {
  kernel = installFakeKernel()
  // 顺序是渲染层偏好（localStorage）：每个用例从「没调过顺序」开始
  resetEntityOrderForTest()
})

afterEach(() => {
  stopFakeKernel()
  resetEntityOrderForTest()
})

/** dispatch 注入：绕过 onDispatch 的泛型签名，测试里按命令 type 分支 */
function handleDispatch(
  handler: (command: Command) => Promise<DispatchResult<unknown>> | DispatchResult<unknown>,
): void {
  kernel.onDispatch(handler as unknown as Parameters<FakeKernel['onDispatch']>[0])
}

describe('WorkflowManager', () => {
  it('列出工作流：首个为当前，点击行切换选中，点击编辑打开定义弹窗', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发', 3, '日常研发'), wf('w2', '写作')])
    const user = userEvent.setup()
    render(<WorkflowManager />)

    expect(await screen.findByText('3 阶段 · 日常研发')).toBeInTheDocument()
    const first = screen.getByRole('button', { name: '选择工作流 研发' })
    expect(within(first).getByText('当前')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '选择工作流 写作' }))
    expect(
      within(screen.getByRole('button', { name: '选择工作流 写作' })).getByText('当前'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('button', { name: '选择工作流 研发' })).queryByText('当前'),
    ).toBeNull()

    await user.click(screen.getAllByRole('button', { name: '编辑' })[0])
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('工作流定义')
    // 宽度必须带 sm: 变体：基座是 sm:max-w-lg，裸 max-w-3xl 合不掉它，弹窗会一直停在 512px
    expect(dialog.className).toContain('sm:max-w-3xl')
    expect(dialog.className).not.toContain('sm:max-w-lg')
    expect(dialog.className).not.toMatch(/(^|\s)max-w-3xl(\s|$)/)
    expect(dialog.className).toContain('max-w-[calc(100%-2rem)]')
    expect(dialog.className).toContain('max-h-[85vh]')
    expect(screen.getByLabelText('工作流名称')).toHaveValue('研发')
  })

  it('拖动行调整清单顺序并落盘：落点「占位」而不是交换，顺序不改定义', async () => {
    kernel.setView('workflows.all', undefined, [
      wf('w1', '研发'),
      wf('w2', '写作'),
      wf('w3', '发布'),
    ])
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    /** 清单当前次序（按行内「选择工作流」按钮的 aria-label 读，跟视觉顺序一致） */
    const order = (): string[] =>
      screen
        .getAllByRole('button', { name: /^选择工作流 / })
        .map((button) => button.getAttribute('aria-label')?.replace('选择工作流 ', '') ?? '')

    expect(order()).toEqual(['研发', '写作', '发布'])

    // 首行拖到末行：占末行的位置，首尾都能拖（不再有禁用态）
    fireEvent.dragStart(screen.getByRole('button', { name: '拖动排序：工作流 研发' }))
    fireEvent.dragOver(screen.getByRole('button', { name: '拖动排序：工作流 发布' }))
    fireEvent.drop(screen.getByRole('button', { name: '拖动排序：工作流 发布' }))
    expect(order()).toEqual(['写作', '发布', '研发'])
    // 顺序落盘为整份 id 清单（渲染层偏好，不发命令、不改工作流定义）
    expect(window.localStorage.getItem(ENTITY_ORDER_STORAGE_KEYS.workflow)).toBe('["w2","w3","w1"]')
    expect(kernel.dispatched).toHaveLength(0)
    // 首个仍是「当前」：重开窗口默认落在这条流程上
    expect(
      within(screen.getByRole('button', { name: '选择工作流 写作' })).getByText('当前'),
    ).toBeInTheDocument()

    // 键盘兜底：抓手聚焦后 ↑ / ↓ 各挪一格
    await user.click(screen.getByRole('button', { name: '拖动排序：工作流 研发' }))
    await user.keyboard('{ArrowUp}')
    expect(order()).toEqual(['写作', '研发', '发布'])
    expect(window.localStorage.getItem(ENTITY_ORDER_STORAGE_KEYS.workflow)).toBe('["w2","w1","w3"]')

    await user.click(screen.getByRole('button', { name: '拖动排序：工作流 写作' }))
    await user.keyboard('{ArrowDown}')
    expect(order()).toEqual(['研发', '写作', '发布'])
    expect(window.localStorage.getItem(ENTITY_ORDER_STORAGE_KEYS.workflow)).toBe('["w1","w2","w3"]')
  })

  it('空清单显示空态；新建工作流下拉里选「从空白创建」打开空表单', async () => {
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowManager />)

    expect(await screen.findByText('暂无工作流')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    await user.click(screen.getByRole('menuitem', { name: '从空白创建工作流' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('工作流定义')
    expect(screen.getByLabelText('工作流名称')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('新建保存：dispatch workflow.create，并用返回值选中新建项', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发')])
    const created = wf('w2', '新建流', 1)
    handleDispatch((command) => {
      if (command.type === 'workflow.create') {
        kernel.setView('workflows.all', undefined, [wf('w1', '研发'), created])
        return { facts: [], value: created }
      }
      return { facts: [], value: null }
    })
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    await user.click(screen.getByRole('menuitem', { name: '从空白创建工作流' }))
    await user.type(screen.getByLabelText('工作流名称'), '新建流')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({
      type: 'workflow.create',
      input: { name: '新建流' },
    })
    // 保存后选中新建项：新行带「当前」
    const createdRow = await screen.findByRole('button', { name: '选择工作流 新建流' })
    expect(within(createdRow).getByText('当前')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('新建返回空值：弹窗照常关闭，选中项不变', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发')])
    handleDispatch(() => ({ facts: [], value: null }))
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    await user.click(screen.getByRole('menuitem', { name: '从空白创建工作流' }))
    await user.type(screen.getByLabelText('工作流名称'), '没有返回值的流')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(kernel.dispatched).toHaveLength(1)
    // 命令没回实体：不切换选中，仍是原来那条
    expect(
      within(screen.getByRole('button', { name: '选择工作流 研发' })).getByText('当前'),
    ).toBeInTheDocument()
  })

  it('编辑保存：dispatch workflow.update；失败保持弹窗并展示错误', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发', 1)])
    handleDispatch(() => Promise.reject(new Error('update-fail')))
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.clear(screen.getByLabelText('工作流名称'))
    await user.type(screen.getByLabelText('工作流名称'), '研发2')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('update-fail')
    expect(kernel.dispatched[0]).toMatchObject({ type: 'workflow.update', id: 'w1' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('保存失败为非 Error 时按字符串展示，弹窗保持打开', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发', 1)])
    handleDispatch(() => Promise.reject('保存纯文本失败'))
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('保存纯文本失败')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('阶段为空的旧数据：编辑器补出四个内置阶段，保存把它们一并提交', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发')])
    handleDispatch(() => ({ facts: [], value: null }))
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    // 视图里没有阶段（M18 之前的老数据）：内置四件套隐式补出，名称锁定
    expect(screen.getByLabelText('阶段1名称')).toHaveValue('待办')
    expect(screen.getByLabelText('阶段1名称')).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: '阶段4' }).textContent).toContain('已取消')

    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    const command = kernel.dispatched[0]
    expect(command).toMatchObject({ type: 'workflow.update', id: 'w1' })
    if (command.type !== 'workflow.update') throw new Error('命令类型不对')
    expect(command.input.stages.map((stage) => stage.name)).toEqual([
      '待办',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(command.input.stages.map((stage) => stage.builtin ?? null)).toEqual([
      'todo',
      'blocked',
      'done',
      'cancelled',
    ])
  })

  it('编辑期间别处删掉了阶段：保存前按最新视图过滤，不再整份被「阶段 id 不存在」拒收', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发', 3)])
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    // 弹窗开着的时候，外部进程把「阶段2」删了（本机迁移脚本不经过宿主的事实广播）
    const live = wf('w1', '研发', 3)
    live.stages = [live.stages[0], live.stages[2]]
    kernel.setView('workflows.all', undefined, [live])

    // 用户此时删除「阶段1」：草稿里还留着已消失的「阶段2」的 id
    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    const command = kernel.dispatched[0]
    if (command.type !== 'workflow.update') throw new Error('命令类型不对')
    expect(command).toMatchObject({ type: 'workflow.update', id: 'w1' })
    expect(command.input.stages.map((stage) => stage.name)).toEqual([
      '待办',
      '阶段3',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('保存前取最新定义失败：按草稿原样提交（由内核兜底），不吞掉用户改动', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发', 2)])
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    // 打开弹窗后视图查询开始失败：保存前的「一次性取最新定义」也跟着失败
    kernel.failView('workflows.all', undefined, 'wf-down')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    const command = kernel.dispatched[0]
    if (command.type !== 'workflow.update') throw new Error('命令类型不对')
    expect(command.input.stages.map((stage) => stage.name)).toEqual([
      '待办',
      '阶段1',
      '阶段2',
      '已阻塞',
      '已完成',
      '已取消',
    ])
  })

  it('工作流视图读取失败展示错误', async () => {
    kernel.failView('workflows.all', undefined, 'wf-down')
    render(<WorkflowManager />)
    expect(await screen.findByText('wf-down')).toBeInTheDocument()
  })

  it('编辑弹窗按 Esc 关闭：走 Dialog onClose，不 dispatch', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发')])
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('删除工作流：dispatch workflow.remove，成功后该行消失', async () => {
    let list = [wf('w1', '研发'), wf('w2', '写作')]
    kernel.setView('workflows.all', undefined, list)
    handleDispatch((command) => {
      if (command.type === 'workflow.remove') {
        list = list.filter((item) => item.id !== command.id)
        kernel.setView('workflows.all', undefined, list)
        return { facts: [], value: null }
      }
      return { facts: [], value: null }
    })
    const user = userEvent.setup()
    render(<WorkflowManager />)
    expect(await screen.findByText('写作')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '删除工作流 写作' }))
    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    expect(kernel.dispatched[0]).toMatchObject({ type: 'workflow.remove', id: 'w2' })
    await waitFor(() => expect(screen.queryByText('写作')).not.toBeInTheDocument())
    // 删掉当前选中项后，剩余首个自动成为当前
    expect(
      within(screen.getByRole('button', { name: '选择工作流 研发' })).getByText('当前'),
    ).toBeInTheDocument()
  })

  it('删除失败展示错误，行保留', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发')])
    handleDispatch(() => Promise.reject(new Error('remove-fail')))
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '删除工作流 研发' }))
    // 写命令失败必须是可播报的 alert，并且能手动关掉
    expect(await screen.findByRole('alert')).toHaveTextContent('remove-fail')
    expect(screen.getByText('研发')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '关闭错误提示' }))
    expect(screen.queryByText('remove-fail')).not.toBeInTheDocument()
  })

  it('删除正在编辑的工作流：编辑态跟随失效，弹窗关闭', async () => {
    let list = [wf('w1', '研发')]
    kernel.setView('workflows.all', undefined, list)
    handleDispatch((command) => {
      if (command.type === 'workflow.remove') {
        list = list.filter((item) => item.id !== command.id)
        kernel.setView('workflows.all', undefined, list)
        return { facts: [], value: null }
      }
      return { facts: [], value: null }
    })
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // 弹窗仍开着时删掉同一条工作流（列表在遮罩之后，直接派发点击）：
    // 编辑态若正指向被删项，应回落到 undefined 关掉弹窗
    // 弹窗打开后遮罩外的列表被标记为 aria-hidden，所以要带 hidden 才能取到
    fireEvent.click(screen.getByRole('button', { name: '删除工作流 研发', hidden: true }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(kernel.dispatched[0]).toMatchObject({ type: 'workflow.remove', id: 'w1' })
    expect(await screen.findByText('暂无工作流')).toBeInTheDocument()
  })

  it('新建工作流下拉：列出「从空白创建」与全部开箱模板（说明 + 阶段数）', async () => {
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('暂无工作流')

    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    const menu = screen.getByRole('menu', { name: '新建工作流' })
    expect(menu).toHaveTextContent('SOP 模板')
    expect(screen.getByRole('menuitem', { name: '从空白创建工作流' })).toBeInTheDocument()
    // 空白起手的说明与「内置阶段恒在」的新模型一致
    expect(screen.getByRole('menuitem', { name: '从空白创建工作流' })).toHaveTextContent(
      '内置待办 / 已阻塞 / 已完成 / 已取消，自己往中间加阶段',
    )
    for (const template of SOP_TEMPLATES) {
      const item = screen.getByRole('menuitem', { name: `使用模板 ${template.name}` })
      expect(item).toHaveTextContent(template.description)
      expect(item).toHaveTextContent(`${template.stages.length} 阶段`)
    }
    // 只是选建法，还没落库也没开编辑器
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('下拉选中模板后预填到编辑器（下拉关闭）', async () => {
    const release = SOP_TEMPLATES.find((template) => template.id === 'release-ops')
    if (!release) throw new Error('缺少发版模板')
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('暂无工作流')

    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    await user.click(screen.getByRole('menuitem', { name: `使用模板 ${release.name}` }))

    // 下拉关闭，编辑器带着模板的阶段与「要干什么」打开；默认展开第一个自己添加的阶段
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog')).toHaveTextContent('工作流定义')
    expect(screen.getByLabelText('工作流名称')).toHaveValue(release.name)
    expect(screen.getByLabelText('阶段2名称')).toHaveValue(release.stages[0].name)
    expect(screen.getByLabelText('阶段2要干什么')).toHaveValue(release.stages[0].instructions)
  })

  it('下拉可按 Esc 关闭：不打开编辑器、不 dispatch', async () => {
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('暂无工作流')

    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('模板新建保存：workflow.create 带上模板阶段、说明与流转下标', async () => {
    const release = SOP_TEMPLATES.find((template) => template.id === 'release-ops')
    if (!release) throw new Error('缺少发版模板')
    kernel.setView('workflows.all', undefined, [])
    const created = wf('w9', release.name, release.stages.length)
    handleDispatch((command) => {
      if (command.type === 'workflow.create') {
        kernel.setView('workflows.all', undefined, [created])
        return { facts: [], value: created }
      }
      return { facts: [], value: null }
    })
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('暂无工作流')

    await user.click(screen.getByRole('button', { name: '新建工作流' }))
    await user.click(screen.getByRole('menuitem', { name: `使用模板 ${release.name}` }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    const command = kernel.dispatched[0]
    expect(command).toMatchObject({ type: 'workflow.create', input: { name: release.name } })
    if (command.type !== 'workflow.create') throw new Error('命令类型不对')
    // 提交整份定义：四个内置阶段 + 模板阶段（顺序即看板顺序）
    const names = command.input.stages.map((stage) => stage.name)
    expect(names).toEqual([
      '待办',
      ...release.stages.map((stage) => stage.name),
      '已阻塞',
      '已完成',
      '已取消',
    ])
    // 「要干什么」原样落库（会拼进阶段提示词）
    expect(
      command.input.stages.find((stage) => stage.name === release.stages[0].name),
    ).toMatchObject({ instructions: release.stages[0].instructions })
    // 阶段名在完整数组的下标里解析：灰度是闸门，未通过时指向「发布准备」而不是自己
    const gray = command.input.stages[names.indexOf('灰度发布')]
    expect(gray.gate?.onFailIndex).toBe(names.indexOf('发布准备'))
  })

  it('阶段指标（M23）：有运行数据时按阶段展示轮次 / 降级 / 问人 / 人评；全 0 时不显示', async () => {
    const flows = [wf('w1', '研发', 2), wf('w2', '写作', 1)]
    kernel.setView('workflows.all', undefined, flows)
    kernel.setView(
      'workflow.stage-metrics',
      { workflowId: 'w1' },
      {
        workflowId: 'w1',
        stages: [
          {
            stageId: 'w1-s0',
            stageName: '阶段1',
            runs: 4,
            avgRounds: 2,
            repairExhausted: 1,
            degraded: 1,
            asks: 2,
            humanComments: 3,
          },
          {
            stageId: 'w1-s1',
            stageName: '阶段2',
            runs: 0,
            avgRounds: 0,
            repairExhausted: 0,
            degraded: 0,
            asks: 0,
            humanComments: 0,
          },
        ],
      },
    )
    const user = userEvent.setup()
    render(<WorkflowManager />)

    expect(await screen.findByText('阶段指标')).toBeInTheDocument()
    const measured = screen.getByRole('table')
    // 只列出真有数据的阶段：全 0 的阶段不占一行
    expect(within(measured).getByText('阶段1')).toBeInTheDocument()
    expect(within(measured).queryByText('阶段2')).toBeNull()
    // 一行 = 阶段 + 轮次 / 平均轮数 / 降级 / 问人 / 人评
    const row = within(measured).getAllByRole('row')[1]
    expect(Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)).toEqual([
      '阶段1',
      '4',
      '2',
      '1',
      '2',
      '3',
    ])

    // 切到没有指标数据的工作流：查询参数跟着换，指标区消失
    kernel.setView(
      'workflow.stage-metrics',
      { workflowId: 'w2' },
      {
        workflowId: 'w2',
        stages: [],
      },
    )
    await user.click(screen.getByRole('button', { name: '选择工作流 写作' }))
    await waitFor(() => expect(screen.queryByText('阶段指标')).toBeNull())
  })

  it('Esc 关闭工作流定义弹窗：dismiss 收口到 setEditing(undefined)，弹窗消失', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发', 2)])
    const user = userEvent.setup()
    render(<WorkflowManager />)

    await user.click(await screen.findByRole('button', { name: '选择工作流 研发' }))
    await user.click(screen.getAllByRole('button', { name: '编辑' })[0])
    expect(screen.getByRole('dialog')).toHaveTextContent('工作流定义')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // 关掉的是编辑态，工作流本身还在清单里
    expect(screen.getByRole('button', { name: '选择工作流 研发' })).toBeInTheDocument()
  })
})
