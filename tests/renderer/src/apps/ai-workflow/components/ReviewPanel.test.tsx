import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewFinding, ReviewReport } from '../../../../../../src/protocol/review'
import { ReviewPanel } from '../../../../../../src/renderer/src/apps/ai-workflow/components/ReviewPanel'

afterEach(cleanup)

const at = '2026-11-10T00:00:00.000Z'

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: 'run-1:1#R1',
  key: 'R1',
  severity: 'blocker',
  location: 'src/a.ts:64',
  claim: 'BOM 文件被判非法 JSON',
  evidence: 'python verify.py',
  requiredAction: '改成 utf-8-sig 后复跑',
  status: 'open',
  note: null,
  addressedByRunId: null,
  updatedAt: at,
  ...over,
})

const report = (over: Partial<ReviewReport> = {}): ReviewReport => ({
  id: 'run-1:1',
  taskId: 't-1',
  stageId: 'st-review',
  runId: 'run-1',
  threadId: null,
  rev: 1,
  verdict: 'fail',
  checks: [{ cmd: 'pnpm check', exitCode: 1 }],
  findings: [finding()],
  artifact: null,
  createdAt: at,
  updatedAt: at,
  ...over,
})

describe('ReviewPanel（任务详情里的评审结论）', () => {
  it('没有报告：给空态文案，不渲染清单', () => {
    render(<ReviewPanel reports={[]} onExport={async () => ''} />)
    expect(screen.getByText(/还没有评审结论/)).toBeTruthy()
    expect(screen.queryByLabelText('待改清单')).toBeNull()
  })

  it('渲染最新一版：rev / 判定 / 判定证据 / 清单（位置、状态、验收）', () => {
    render(<ReviewPanel reports={[report()]} onExport={async () => ''} />)
    const panel = screen.getByLabelText('评审结论')
    expect(within(panel).getByText('rev 1')).toBeTruthy()
    expect(within(panel).getByText('fail')).toBeTruthy()
    expect(within(panel).getByText('待处理 1')).toBeTruthy()
    expect(within(panel).getByText('pnpm check')).toBeTruthy()
    const list = within(panel).getByLabelText('待改清单')
    expect(within(list).getByText('R1')).toBeTruthy()
    expect(within(list).getByText('阻断')).toBeTruthy()
    expect(within(list).getByText('src/a.ts:64')).toBeTruthy()
    expect(within(list).getByText('BOM 文件被判非法 JSON')).toBeTruthy()
    expect(within(list).getByText('验收：改成 utf-8-sig 后复跑')).toBeTruthy()
    expect(within(list).getByText('待处理')).toBeTruthy()
  })

  it('多版本：只展开最新一版，其余给历史计数', () => {
    render(
      <ReviewPanel
        reports={[report({ id: 'run-0:1', rev: 1 }), report({ id: 'run-1:2', rev: 2 })]}
        onExport={async () => ''}
      />,
    )
    expect(screen.getByText('rev 2')).toBeTruthy()
    expect(screen.getByText('另有 1 个历史版本')).toBeTruthy()
  })

  it('已处置条目的状态文案与「不改 / 延后」的说明', () => {
    render(
      <ReviewPanel
        reports={[
          report({
            verdict: 'pass',
            checks: [],
            findings: [
              finding({
                status: 'rejected',
                note: '这是设计取舍',
                severity: 'low',
                location: null,
              }),
              finding({ id: 'run-1:1#R2', key: 'R2', status: 'deferred', note: '下轮' }),
            ],
          }),
        ]}
        onExport={async () => ''}
      />,
    )
    const list = screen.getByLabelText('待改清单')
    expect(within(list).getByText('不改')).toBeTruthy()
    expect(within(list).getByText('说明：这是设计取舍')).toBeTruthy()
    expect(within(list).getByText('延后')).toBeTruthy()
    expect(screen.getByText('pass')).toBeTruthy()
    expect(screen.queryByText('（未给出复核命令）')).toBeNull()
  })

  it('无判定 / 无条目 / 无证据：给对应占位文案', () => {
    render(
      <ReviewPanel
        reports={[report({ verdict: null, checks: [], findings: [] })]}
        onExport={async () => ''}
      />,
    )
    expect(screen.getByText('无判定')).toBeTruthy()
    expect(screen.getByText(/这份评审没有列出待改条目/)).toBeTruthy()
  })

  it('提升为文档：点了才调用注入的 onExport（带最新报告 id），成功回显路径', async () => {
    const onExport = vi.fn(async (reportId: string) => `/repo/docs/reviews/${reportId}.md`)
    render(<ReviewPanel reports={[report()]} onExport={onExport} />)
    await userEvent.click(screen.getByRole('button', { name: '提升为文档' }))
    expect(onExport).toHaveBeenCalledWith('run-1:1')
    await waitFor(() => expect(screen.getByText(/已写入/)).toBeTruthy())
    expect(screen.getByText(/run-1:1\.md/)).toBeTruthy()
  })

  it('导出失败：就地展示后端文案，不显示路径', async () => {
    const onExport = vi.fn(async () => {
      throw new Error('任务未归属项目，无法落到 docs/reviews')
    })
    render(<ReviewPanel reports={[report()]} onExport={onExport} />)
    await userEvent.click(screen.getByRole('button', { name: '提升为文档' }))
    await waitFor(() =>
      expect(screen.getByText('任务未归属项目，无法落到 docs/reviews')).toBeTruthy(),
    )
    expect(screen.queryByText(/已写入/)).toBeNull()
  })

  it('导出进行中：按钮置忙且不可重复点', async () => {
    let release: (value: string) => void = () => {}
    const onExport = (): Promise<string> =>
      new Promise((resolve) => {
        release = resolve
      })
    render(<ReviewPanel reports={[report()]} onExport={onExport} />)
    await userEvent.click(screen.getByRole('button', { name: '提升为文档' }))
    const busy = screen.getByRole('button', { name: '正在写文件…' })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    release('/x.md')
    await waitFor(() => expect(screen.getByRole('button', { name: '提升为文档' })).toBeTruthy())
  })
})
