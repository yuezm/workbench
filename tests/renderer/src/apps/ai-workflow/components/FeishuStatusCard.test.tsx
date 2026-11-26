import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LarkStatusView } from '@workbench/protocol/ipc'
import { FeishuStatusCard } from '@workbench/client-app-ai-workflow/components/FeishuStatusCard'

/**
 * 飞书状态卡：本机 lark-cli 连的是谁、能不能用、还差哪一步。
 *
 * 缺口都集中在「探测结果缺字段」这一档（`program` / `identity` / `tokenStatus` 为空、
 * `foreign` 里工作区与应用名缺失）——真实环境里 CLI 只报一半时就会这样，卡片不能空着。
 */
const status = (over: Partial<LarkStatusView> = {}): LarkStatusView => ({
  ok: true,
  program: '/usr/local/bin/lark-cli',
  error: null,
  workspace: 'ws-home',
  appId: 'cli_workbench',
  identity: 'bot',
  available: true,
  tokenStatus: 'ready',
  profiles: [],
  foreign: null,
  conflict: false,
  hint: null,
  ...over,
})

const renderCard = (
  over: Partial<LarkStatusView> | null,
  error: string | null = null,
  busy = false,
): void => {
  render(
    <FeishuStatusCard
      status={over === null ? null : status(over)}
      error={error}
      busy={busy}
      onRefresh={vi.fn()}
    />,
  )
}

describe('FeishuStatusCard', () => {
  it('重新探测进行中：按钮写「探测中…」并禁用', () => {
    renderCard({}, null, true)
    const button = screen.getByRole('button', { name: '探测中…' })
    expect(button).toHaveProperty('disabled', true)
  })

  it('还没探测到：状态点「探测中」，三格给占位而不是空白', () => {
    renderCard(null)
    expect(screen.getAllByText('探测中').length).toBeGreaterThan(0)
    // lark-cli 一格：探测中…；工作区 / 身份 / 应用都给占位「—」
    expect(screen.getByText('探测中…')).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    // 未探测时没有「打开事件与回调」的链接
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('探测结果只报了一半：program / identity / tokenStatus 缺失时给「未找到 / —」', () => {
    renderCard({
      program: null,
      identity: null,
      tokenStatus: null,
      appId: null,
      workspace: null,
    })
    expect(screen.getByText('未找到')).toBeInTheDocument()
    expect(screen.getByText('— · —')).toBeInTheDocument()
    // 应用 id 缺失时应用一格给占位，不出现「打开 undefined 的…」链接
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('别的 agent 撞车且它自己也没报工作区 / 应用：按「未知」写出来，并说明会抢长连接', () => {
    renderCard({
      conflict: false,
      foreign: { workspace: null, appId: null },
      hint: '给工作台换一个应用',
    })
    // foreign 的工作区 / 应用名缺失 → 未知占位；conflict=false 时不多出「会抢事件」那句
    const foreignLine = screen.getByText(/别的 agent 绑定在「未知工作区」/)
    expect(foreignLine.textContent).toContain('未知）')
    expect(screen.queryByText(/会抢事件长连接/)).not.toBeInTheDocument()
    // 有 hint 时它在下面单独一行
    expect(screen.getByText('给工作台换一个应用')).toBeInTheDocument()
  })

  it('撞车（conflict）：同一行补一句「会抢事件长连接，请换应用」', () => {
    renderCard({
      conflict: true,
      foreign: { workspace: 'ws-other', appId: 'cli_other' },
      hint: '建议换应用',
    })
    expect(screen.getByText(/ws-other/)).toBeInTheDocument()
    expect(screen.getByText(/会抢事件长连接/)).toBeInTheDocument()
    // foreign 与 hint 同时存在：hint 单独一行
    expect(screen.getByText('建议换应用')).toBeInTheDocument()
  })

  it('只有 hint（没有别的 agent）：把建议写成一行，不显示撞车说明', () => {
    renderCard({ foreign: null, conflict: false, hint: '还没有授权，先登录' })
    expect(screen.getByText('还没有授权，先登录')).toBeInTheDocument()
    expect(screen.queryByText(/别的 agent 绑定/)).not.toBeInTheDocument()
  })

  it('正常可用：状态「可用」、应用 id 可见，并给出「打开事件与回调」的链接', () => {
    renderCard({})
    expect(screen.getByText('可用')).toBeInTheDocument()
    expect(screen.getByText('cli_workbench')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /打开「cli_workbench」的事件与回调/ })
    expect(link.getAttribute('href')).toBe('https://open.feishu.cn/app/cli_workbench/event')
  })
})
