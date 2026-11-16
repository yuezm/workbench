// @vitest-environment node
/**
 * 知会：把 sdk.notify 变成 SSE 上的一条 `notice`（取代桌面系统通知）。
 *
 * 断言口径：标题为空不推；正文与标题都截断；落点补上 appId（与 `AppPlugin.id` 同名）；
 * 日志只记标题，不记正文。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '../../src/protocol/http'
import { MAX_NOTICE_CHARS, NOTIFY_APP_ID, createNotifier } from '../../src/server/notify'

const collector = () => {
  const events: ServerEvent[] = []
  return { events, publish: (event: ServerEvent) => events.push(event) }
}

describe('createNotifier', () => {
  it('普通知会：推一条 notice，标题与正文原样', () => {
    const { events, publish } = collector()
    const notify = createNotifier({ publish })
    notify('任务完成', '甲任务已到待办')
    expect(events).toEqual([{ kind: 'notice', title: '任务完成', body: '甲任务已到待办' }])
  })

  it('带落点：appId 由这里补，业务字段透传', () => {
    const { events, publish } = collector()
    const notify = createNotifier({ publish })
    notify('运行失败', '原因见任务详情', { taskId: 't1', cardId: 'c1' })
    expect(events[0]).toMatchObject({
      kind: 'notice',
      target: { appId: NOTIFY_APP_ID, taskId: 't1', cardId: 'c1' },
    })
  })

  it('标题为空不推（没有可告知的事）', () => {
    const { events, publish } = collector()
    const notify = createNotifier({ publish })
    notify('   ', 'body')
    expect(events).toEqual([])
  })

  it('超长文案截断并补省略号', () => {
    const { events, publish } = collector()
    const notify = createNotifier({ publish })
    const long = 'x'.repeat(MAX_NOTICE_CHARS + 50)
    notify(long, long)
    const event = events[0]
    expect(event?.kind).toBe('notice')
    if (event?.kind !== 'notice') throw new Error('不是 notice')
    expect(event.title).toHaveLength(MAX_NOTICE_CHARS)
    expect(event.title.endsWith('…')).toBe(true)
    expect(event.body).toHaveLength(MAX_NOTICE_CHARS)
  })

  it('没有日志通道：照常推送（日志是可选的诊断面）', () => {
    const { events, publish } = collector()
    const notify = createNotifier({ publish })
    notify('任务完成')
    expect(events[0]).toMatchObject({ kind: 'notice', title: '任务完成', body: '' })
  })

  it('日志只记标题（正文可能含任务内容）', () => {
    const { publish } = collector()
    const log = vi.fn()
    const notify = createNotifier({ publish, log })
    notify('任务完成', '含敏感正文')
    expect(log).toHaveBeenCalledWith('[notify] 任务完成')
    expect(String(log.mock.calls[0]?.[0])).not.toContain('含敏感正文')
  })
})
