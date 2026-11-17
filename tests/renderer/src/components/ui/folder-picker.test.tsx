import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { DirListing } from '@workbench/protocol/http'
import { FolderPickerDialog } from '@workbench/client-ui-kit/folder-picker'

/**
 * 文件夹选择器（覆盖层组件）：列目录能力由调用方注入，这里直接喂假目录树，
 * 不碰 `window.workbench`——选择器本身不认识桥接。
 */
const listing = (
  path: string,
  entries: DirListing['entries'] = [],
  roots: string[] = [],
): DirListing => ({
  path,
  parent: path === 'D:\\' ? null : path.slice(0, path.lastIndexOf('\\')) || null,
  roots,
  entries,
})

describe('FolderPickerDialog', () => {
  it('打开时从缺省目录开始；上一级在盘根禁用', async () => {
    const list = vi.fn(async () => listing('D:\\'))
    render(<FolderPickerDialog list={list} onPick={vi.fn()} onCancel={vi.fn()} />)

    await waitFor(() => expect(list).toHaveBeenCalledWith(undefined))
    expect(await screen.findByText('D:\\')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '上一级' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '选这个文件夹' })).toBeEnabled()
  })

  it('起始目录传给宿主的列目录；空目录给出说明', async () => {
    const list = vi.fn(async (path?: string) => listing(path ?? '/'))
    render(
      <FolderPickerDialog start={'D:\\empty'} list={list} onPick={vi.fn()} onCancel={vi.fn()} />,
    )

    await waitFor(() => expect(list).toHaveBeenCalledWith('D:\\empty'))
    expect(await screen.findByText('这个目录下没有子目录')).toBeInTheDocument()
  })

  it('盘根处用盘符跨盘：点 D 盘就列 D 盘，当前盘高亮（曾经的 bug：进不了 D 盘）', async () => {
    const roots = ['C:\\', 'D:\\']
    const list = vi
      .fn<(path?: string) => Promise<DirListing>>()
      .mockResolvedValueOnce(listing('C:\\', [], roots))
      .mockResolvedValueOnce(listing('D:\\', [], roots))
    const user = userEvent.setup()
    render(<FolderPickerDialog list={list} onPick={vi.fn()} onCancel={vi.fn()} />)

    // 盘根的上一级是禁用的：不给盘符就再也出不去
    await waitFor(() => expect(screen.getByRole('button', { name: '上一级' })).toBeDisabled())
    const group = screen.getByRole('group', { name: '盘符' })
    expect(within(group).getByRole('button', { name: '切换到 C:\\' })).toHaveAttribute(
      'aria-current',
      'true',
    )

    await user.click(within(group).getByRole('button', { name: '切换到 D:\\' }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('D:\\'))
    await waitFor(() => expect(screen.getByLabelText('当前目录')).toHaveTextContent('D:\\'))
  })

  it('只有一个根（POSIX 的 /）时不画盘符行，免得白占一行', async () => {
    const list = vi.fn(async () => listing('/', [], ['/']))
    render(<FolderPickerDialog list={list} onPick={vi.fn()} onCancel={vi.fn()} />)

    expect(await screen.findByText('/')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '盘符' })).not.toBeInTheDocument()
  })

  it('点目录进去、再确认就回填该目录；取消不发 onPick', async () => {
    const list = vi
      .fn<(path?: string) => Promise<DirListing>>()
      .mockResolvedValueOnce(
        listing('D:\\Codes', [{ name: 'workbench', path: 'D:\\Codes\\workbench' }]),
      )
      .mockResolvedValueOnce(listing('D:\\Codes\\workbench'))
    const onPick = vi.fn()
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(<FolderPickerDialog list={list} onPick={onPick} onCancel={onCancel} />)

    await user.click(await screen.findByRole('button', { name: /workbench/u }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('D:\\Codes\\workbench'))
    await user.click(screen.getByRole('button', { name: '选这个文件夹' }))
    expect(onPick).toHaveBeenCalledWith('D:\\Codes\\workbench')

    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('列目录失败就在原地给可读文案，当前目录与确认按钮不受影响', async () => {
    const list = vi
      .fn<(path?: string) => Promise<DirListing>>()
      .mockResolvedValueOnce(listing('D:\\Codes'))
      .mockRejectedValueOnce('没有权限读取：D:\\Secret')
    const user = userEvent.setup()
    render(<FolderPickerDialog list={list} onPick={vi.fn()} onCancel={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: '上一级' }))
    expect(await screen.findByText('没有权限读取：D:\\Secret')).toBeInTheDocument()
    expect(screen.getByLabelText('当前目录')).toHaveTextContent('D:\\Codes')
    expect(screen.getByRole('button', { name: '选这个文件夹' })).toBeEnabled()
  })
})
