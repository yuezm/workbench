import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Command } from '../../../../../../src/protocol/commands'
import type { Project } from '../../../../../../src/protocol/entities'
import type { CommandDispatchResult } from '../../../../../../src/protocol/ipc'
import type { ViewId, ViewResult } from '../../../../../../src/protocol/views'
import { ProjectDialog } from '../../../../../../src/renderer/src/apps/ai-workflow/components/ProjectDialog'
import type { WorkbenchApi } from '../../../../../../src/shared/workbench-api'

const project: Project = {
  id: 'p1',
  name: '工作台',
  path: 'D:\\Codes\\workbench',
  description: '个人工作台',
  createdAt: 't',
  updatedAt: 't',
}

const originalBridge = window.workbench

/**
 * 只装 pickFolder 的桥接：本组件除了选文件夹不碰内核（读写都走父级的 dispatch），
 * 所以其余动词直接拒绝——真的被调到就是用例写错了。
 */
function stubBridge(pickFolder: () => Promise<string | null>): void {
  const api: WorkbenchApi = {
    dispatch: <C extends Command>(): Promise<CommandDispatchResult<C>> =>
      Promise.reject(new Error('本组件不用 dispatch')),
    query: <T extends ViewId>(): Promise<ViewResult<T>> =>
      Promise.reject(new Error('本组件不用 query')),
    subscribe: () => () => {},
    // 落点管道（系统通知 → shell）与本组件无关：装一个空订阅，真被调到也不影响选择文件夹
    onOpenTarget: () => () => {},
    pickFolder,
    notify: () => {},
  }
  window.workbench = api
}

afterEach(() => {
  window.workbench = originalBridge
})

describe('ProjectDialog', () => {
  it('选文件夹后填入路径，并按路径末段预填名称；保存带上输入与无 id（新建）', async () => {
    stubBridge(() => Promise.resolve('D:\\Codes\\workbench'))
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ProjectDialog onSave={onSave} onCancel={vi.fn()} />)

    expect(screen.getByText('新建项目')).toBeInTheDocument()
    // 新建态没有可删的东西
    expect(screen.queryByRole('button', { name: '删除项目' })).not.toBeInTheDocument()
    // 名称与路径都空：保存不可点，且写明为什么
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(screen.getByText(/名称与文件夹路径都必填/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '选择文件夹' }))
    await waitFor(() =>
      expect(screen.getByLabelText('文件夹路径')).toHaveValue('D:\\Codes\\workbench'),
    )
    expect(screen.getByLabelText('项目名称')).toHaveValue('workbench')

    await user.type(screen.getByLabelText('项目备注'), '个人工作台')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    // 第二个参数是编辑用的 id：新建时不传
    expect(onSave.mock.calls[0]).toEqual([
      { name: 'workbench', path: 'D:\\Codes\\workbench', description: '个人工作台' },
      undefined,
    ])
  })

  it('路径输入框与「选择文件夹」在同一行，且都不在 <label> 里（曾经按整块底边对齐而错位）', () => {
    render(<ProjectDialog onSave={vi.fn()} onCancel={vi.fn()} />)
    const input = screen.getByLabelText('文件夹路径')
    const button = screen.getByRole('button', { name: '选择文件夹' })

    // 同一行容器：按钮曾经是 Field 的兄弟、跟「说明文字」的底边对齐，掉到输入框下面
    expect(button.parentElement).toBe(input.parentElement)
    // 按钮属于交互内容，不能嵌在 label 里（点它会连带触发标签行为）
    expect(input.closest('label')).toBeNull()
    expect(button.closest('label')).toBeNull()
  })

  it('取消选择文件夹时不改动任何字段', async () => {
    stubBridge(() => Promise.resolve(null))
    const user = userEvent.setup()
    render(<ProjectDialog onSave={vi.fn()} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '选择文件夹' }))
    expect(screen.getByLabelText('文件夹路径')).toHaveValue('')
    expect(screen.getByLabelText('项目名称')).toHaveValue('')
  })

  it('名称为空时保存禁用（路径已填写也一样）', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(<ProjectDialog onSave={onSave} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('文件夹路径'), 'D:\\Codes\\workbench')
    await user.type(screen.getByLabelText('项目名称'), '临时')
    await user.clear(screen.getByLabelText('项目名称'))
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('编辑态回填字段，保存带项目 id', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ProjectDialog project={project} onSave={onSave} onCancel={vi.fn()} />)

    expect(screen.getByText('编辑项目')).toBeInTheDocument()
    expect(screen.getByLabelText('项目名称')).toHaveValue('工作台')
    expect(screen.getByLabelText('文件夹路径')).toHaveValue('D:\\Codes\\workbench')
    expect(screen.getByLabelText('项目备注')).toHaveValue('个人工作台')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]).toEqual([
      { name: '工作台', path: 'D:\\Codes\\workbench', description: '个人工作台' },
      'p1',
    ])
  })

  it('编辑态「删除项目」调用 onRemove(id)；失败就地展示且弹窗不关', async () => {
    const onRemove = vi.fn().mockRejectedValue(new Error('项目下有执行中的任务'))
    const user = userEvent.setup()
    render(
      <ProjectDialog project={project} onSave={vi.fn()} onRemove={onRemove} onCancel={vi.fn()} />,
    )

    await user.click(screen.getByRole('button', { name: '删除项目' }))
    expect(onRemove).toHaveBeenCalledWith('p1')
    expect(await screen.findByText('项目下有执行中的任务')).toBeInTheDocument()
    expect(screen.getByText('编辑项目')).toBeInTheDocument()

    // 删除失败的文案贴在删除按钮上方，可单独关掉，不影响表单里的输入
    await user.click(screen.getByRole('button', { name: '关闭错误提示' }))
    expect(screen.queryByText('项目下有执行中的任务')).not.toBeInTheDocument()
    expect(screen.getByLabelText('项目名称')).toHaveValue('工作台')
  })

  it('取消回调 onCancel', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<ProjectDialog onSave={vi.fn()} onCancel={onCancel} />)
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('名称已手填时选文件夹只改路径，不用目录名覆盖用户输入', async () => {
    stubBridge(() => Promise.resolve('D:\\Codes\\workbench'))
    const user = userEvent.setup()
    render(<ProjectDialog onSave={vi.fn()} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('项目名称'), '我起的名字')
    await user.click(screen.getByRole('button', { name: '选择文件夹' }))

    await waitFor(() =>
      expect(screen.getByLabelText('文件夹路径')).toHaveValue('D:\\Codes\\workbench'),
    )
    expect(screen.getByLabelText('项目名称')).toHaveValue('我起的名字')
  })

  it('选中文件系统根目录时名称回退为路径本身（末段为空不填空白名）', async () => {
    stubBridge(() => Promise.resolve('/'))
    const user = userEvent.setup()
    render(<ProjectDialog onSave={vi.fn()} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '选择文件夹' }))

    await waitFor(() => expect(screen.getByLabelText('文件夹路径')).toHaveValue('/'))
    expect(screen.getByLabelText('项目名称')).toHaveValue('/')
  })

  it('选择文件夹失败（非 Error）就地展示原因，字段不变', async () => {
    stubBridge(() => Promise.reject('picker-down'))
    const user = userEvent.setup()
    render(<ProjectDialog onSave={vi.fn()} onCancel={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: '选择文件夹' }))

    expect(await screen.findByText('picker-down')).toBeInTheDocument()
    expect(screen.getByLabelText('文件夹路径')).toHaveValue('')
    // 选择器失败的文案可关掉，字段与按钮状态不受影响
    await user.click(screen.getByRole('button', { name: '关闭错误提示' }))
    expect(screen.queryByText('picker-down')).not.toBeInTheDocument()
    // 失败不算致命：仍可手填后保存
    await user.type(screen.getByLabelText('文件夹路径'), 'D:\\tmp')
    await user.type(screen.getByLabelText('项目名称'), '临时')
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  })

  it('字段不全时提交表单不调用 onSave，并把焦点移到缺的字段', async () => {
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(<ProjectDialog onSave={onSave} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('文件夹路径'), 'D:\\Codes\\workbench')
    // 名称留空：保存按钮禁用，但表单提交事件本身会到达 submit 处理器
    await user.click(screen.getByLabelText('项目名称'))
    await user.keyboard('{Enter}')
    // 弹窗内容渲染在 portal 里，表单不在 render 容器内：从弹窗里取
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement)

    expect(onSave).not.toHaveBeenCalled()
    expect(await screen.findByText('项目名称必填')).toBeInTheDocument()
    expect(screen.getByLabelText('项目名称')).toHaveFocus()
    expect(screen.getByText('新建项目')).toBeInTheDocument()
  })

  it('只有名称没有路径：提交落到路径字段错误并聚焦', async () => {
    const onSave = vi.fn()
    render(<ProjectDialog onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '临时' } })
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement)

    expect(onSave).not.toHaveBeenCalled()
    expect(await screen.findByText('文件夹路径必填')).toBeInTheDocument()
    expect(screen.getByLabelText('文件夹路径')).toHaveFocus()
  })

  it('名称/路径/备注提交前都 trim', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<ProjectDialog onSave={onSave} onCancel={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: ' workbench ' } })
    fireEvent.change(screen.getByLabelText('文件夹路径'), {
      target: { value: ' D:\\Codes\\workbench ' },
    })
    fireEvent.change(screen.getByLabelText('项目备注'), { target: { value: ' 备注 ' } })
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]).toEqual([
      { name: 'workbench', path: 'D:\\Codes\\workbench', description: '备注' },
      undefined,
    ])
  })

  it('保存失败就地展示错误、弹窗不关且按钮恢复可点', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('路径不可写'))
    const user = userEvent.setup()
    render(<ProjectDialog onSave={onSave} onCancel={vi.fn()} />)

    await user.type(screen.getByLabelText('文件夹路径'), 'D:\\bad')
    await user.type(screen.getByLabelText('项目名称'), '坏目录')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('路径不可写')).toBeInTheDocument()
    expect(screen.getByText('新建项目')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
    expect(screen.getByLabelText('项目名称')).toHaveValue('坏目录')

    // 错误条可关掉继续改，输入不丢
    await user.click(screen.getByRole('button', { name: '关闭错误提示' }))
    expect(screen.queryByText('路径不可写')).not.toBeInTheDocument()
    expect(screen.getByLabelText('文件夹路径')).toHaveValue('D:\\bad')
  })
})
