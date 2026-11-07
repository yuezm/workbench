import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Command } from '../../../../../../src/protocol/commands'
import type { WorkflowWithStages } from '../../../../../../src/protocol/entities'
import type { DispatchResult } from '../../../../../../src/protocol/ipc'
import { WorkflowManager } from '../../../../../../src/renderer/src/apps/ai-workflow/components/WorkflowManager'
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
})

afterEach(() => {
  stopFakeKernel()
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
    expect(screen.getByRole('dialog')).toHaveTextContent('工作流定义')
    expect(screen.getByLabelText('工作流名称')).toHaveValue('研发')
  })

  it('空清单显示空态；新建工作流打开空表单', async () => {
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowManager />)

    expect(await screen.findByText('暂无工作流')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '新建工作流' }))
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
    kernel.setView('workflows.all', undefined, [wf('w1', '研发')])
    handleDispatch(() => Promise.reject(new Error('update-fail')))
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.clear(screen.getByLabelText('工作流名称'))
    await user.type(screen.getByLabelText('工作流名称'), '研发2')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('update-fail')).toBeInTheDocument()
    expect(kernel.dispatched[0]).toMatchObject({ type: 'workflow.update', id: 'w1' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('保存失败为非 Error 时按字符串展示，弹窗保持打开', async () => {
    kernel.setView('workflows.all', undefined, [wf('w1', '研发')])
    handleDispatch(() => Promise.reject('保存纯文本失败'))
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('研发')

    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('保存纯文本失败')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
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
    expect(await screen.findByText('remove-fail')).toBeInTheDocument()
    expect(screen.getByText('研发')).toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: '删除工作流 研发' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(kernel.dispatched[0]).toMatchObject({ type: 'workflow.remove', id: 'w1' })
    expect(await screen.findByText('暂无工作流')).toBeInTheDocument()
  })

  it('SOP 模板：列出开箱模板，选中后预填到编辑器（模板弹窗关闭）', async () => {
    const release = SOP_TEMPLATES.find((template) => template.id === 'release-ops')
    if (!release) throw new Error('缺少发版模板')
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('暂无工作流')

    await user.click(screen.getByRole('button', { name: 'SOP 模板' }))
    const picker = screen.getByRole('dialog')
    expect(picker).toHaveTextContent('从 SOP 模板新建')
    for (const template of SOP_TEMPLATES) {
      expect(within(picker).getByText(template.description)).toBeInTheDocument()
    }

    await user.click(screen.getByRole('button', { name: `使用模板 ${release.name}` }))

    // 模板弹窗关闭，编辑器带着模板的阶段与「要干什么」打开
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog')).toHaveTextContent('工作流定义')
    expect(screen.getByLabelText('工作流名称')).toHaveValue(release.name)
    expect(screen.getByLabelText('阶段1名称')).toHaveValue(release.stages[0].name)
    expect(screen.getByLabelText('阶段1要干什么')).toHaveValue(release.stages[0].instructions)
  })

  it('SOP 模板：模板弹窗可取消，取消后不打开编辑器、不 dispatch', async () => {
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('暂无工作流')

    await user.click(screen.getByRole('button', { name: 'SOP 模板' }))
    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('SOP 模板弹窗按 Esc 关闭：走 Dialog onClose，不打开编辑器', async () => {
    kernel.setView('workflows.all', undefined, [])
    const user = userEvent.setup()
    render(<WorkflowManager />)
    await screen.findByText('暂无工作流')

    await user.click(screen.getByRole('button', { name: 'SOP 模板' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('从 SOP 模板新建')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.queryByLabelText('工作流名称')).not.toBeInTheDocument()
    expect(kernel.dispatched).toHaveLength(0)
  })

  it('SOP 模板新建保存：workflow.create 带上模板阶段、说明与流转下标', async () => {
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

    await user.click(screen.getByRole('button', { name: 'SOP 模板' }))
    await user.click(screen.getByRole('button', { name: `使用模板 ${release.name}` }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(kernel.dispatched).toHaveLength(1))
    const command = kernel.dispatched[0]
    expect(command).toMatchObject({ type: 'workflow.create', input: { name: release.name } })
    if (command.type !== 'workflow.create') throw new Error('命令类型不对')
    expect(command.input.stages.map((stage) => stage.name)).toEqual(
      release.stages.map((stage) => stage.name),
    )
    // 「要干什么」原样落库（会拼进阶段提示词）
    expect(command.input.stages[0].instructions).toBe(release.stages[0].instructions)
    // 阶段名在下标里解析：灰度阶段的打回目标指向「发布准备」而不是自己
    const canaryIndex = release.stages.findIndex((stage) => stage.name === '灰度发布')
    const prepareIndex = release.stages.findIndex((stage) => stage.name === '发布准备')
    expect(command.input.stages[canaryIndex].onRejectIndex).toBe(prepareIndex)
    expect(canaryIndex).toBeGreaterThan(-1)
  })
})
