import { useEffect, useState, type ReactElement } from 'react'
import type {
  Run,
  RunErrorCode,
  RunEvent,
  RunStatus,
  RunUsage,
} from '../../../../../shared/ai-workflow-api'
import { cn } from '../../../lib/cn'
import { wfApi } from '../api'

/** 运行中 run 的增量轮询间隔 */
const POLL_MS = 1000
/** 工具事件内容的展示截断长度 */
const TOOL_TEXT_MAX = 120

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: '排队中',
  running: '运行中',
  waiting: '等待回答',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}

/** 运行状态配色：成功绿、失败红、进行中紫、取消灰 */
const STATUS_TONE: Record<RunStatus, string> = {
  queued: 'text-focus',
  running: 'text-focus',
  waiting: 'text-long',
  succeeded: 'text-short',
  failed: 'text-red-400',
  cancelled: 'text-ink-faint',
}

const ERROR_CODE_LABEL: Record<RunErrorCode, string> = {
  spawn_failed: '命令启动失败',
  exit_nonzero: '非零退出',
  timeout: '超时',
  cancelled: '已取消',
  protocol_error: '协议错误',
  no_result: '没有终态结果',
  runtime_missing: '运行时不存在',
  runtime_disabled: '运行时已停用',
  executor_lost: '执行器失联',
  run_failed: '执行失败',
}

/** 耗时：1 秒内用毫秒，超过用秒（保留一位小数） */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 合并两次拉取的事件：按 seq 去重并保持顺序 */
function mergeEvents(prev: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  if (prev.length === 0) return incoming
  const known = new Set(prev.map((event) => event.seq))
  const added = incoming.filter((event) => !known.has(event.seq))
  if (added.length === 0) return prev
  return [...prev, ...added].sort((a, b) => a.seq - b.seq)
}

/** 事件流的一行：正文 / 思考次要样式 / 工具调用与结果的无交互次要行 */
function RunEventLine({ event }: { event: RunEvent }): ReactElement | null {
  switch (event.type) {
    case 'text':
      return (
        <p className="text-xs leading-relaxed whitespace-pre-wrap text-ink-dim">{event.text}</p>
      )
    case 'thinking':
      return (
        <p className="text-[11px] leading-relaxed whitespace-pre-wrap text-ink-faint italic">
          {event.text}
        </p>
      )
    case 'tool_call':
      return (
        <p className="rounded-md bg-white/[0.04] px-2 py-1 font-mono text-[11px] leading-relaxed text-ink-faint">
          {['工具调用：' + (event.tool ?? '未知工具'), truncate(event.input ?? '', TOOL_TEXT_MAX)]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )
    case 'tool_result':
      return (
        <p
          className={cn(
            'rounded-md bg-white/[0.04] px-2 py-1 font-mono text-[11px] leading-relaxed text-ink-faint',
            event.isError === true && 'text-red-300',
          )}
        >
          {['工具结果：' + (event.tool ?? '未知工具'), truncate(event.output ?? '', TOOL_TEXT_MAX)]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )
    default:
      return null
  }
}

function UsageLine({ usage }: { usage: RunUsage }): ReactElement {
  return (
    <span className="tabular-nums">
      输入 {usage.inputTokens} / 输出 {usage.outputTokens} tokens
    </span>
  )
}

export interface RunLogProps {
  runs: Run[]
}

/**
 * 某任务的运行记录：状态 / 耗时 / 退出码 / 失败归类 / 用量 + 事件流。
 *
 * 先拉每个 run 的事件；运行中的 run 每 ~1s 轮询增量，卸载或 run 结束后停表。
 * 事件流为空时回落到 run.output（历史数据/事件接口失败时仍能看到最终文本）。
 */
export function RunLog({ runs }: RunLogProps): ReactElement {
  const [eventsByRun, setEventsByRun] = useState<Record<string, RunEvent[]>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const timers: ReturnType<typeof setInterval>[] = []

    const load = async (runId: string): Promise<void> => {
      try {
        const incoming = await wfApi().runs.events(runId)
        if (!alive) return
        setEventsByRun((prev) => {
          const merged = mergeEvents(prev[runId] ?? [], incoming)
          return merged === prev[runId] ? prev : { ...prev, [runId]: merged }
        })
        setError(null)
      } catch (e) {
        if (alive) setError(errMsg(e))
      }
    }

    for (const run of runs) {
      void load(run.id)
      if (run.status === 'running') {
        timers.push(setInterval(() => void load(run.id), POLL_MS))
      }
    }

    return () => {
      alive = false
      for (const timer of timers) clearInterval(timer)
    }
  }, [runs])

  if (runs.length === 0) {
    return (
      <div className="grid place-items-center rounded-xl border border-dashed border-line py-6 text-xs text-ink-faint">
        暂无运行记录
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {error !== null && (
        <p className="rounded-lg border border-red-400/30 bg-red-400/10 px-2.5 py-1.5 text-[11px] text-red-300">
          事件流加载失败：{error}
        </p>
      )}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {runs.map((run) => {
          const events = eventsByRun[run.id] ?? []
          return (
            <li key={run.id} className="px-4 py-3 transition-colors hover:bg-white/[0.03]">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-faint">
                <span
                  className={cn(
                    'rounded-full bg-white/[0.06] px-2 py-0.5',
                    STATUS_TONE[run.status],
                  )}
                >
                  {STATUS_LABEL[run.status]}
                </span>
                <span className="tabular-nums">{run.startedAt ?? run.createdAt}</span>
                {run.durationMs !== null && (
                  <span className="tabular-nums">耗时 {formatDuration(run.durationMs)}</span>
                )}
                {run.exitCode !== null && (
                  <span className="tabular-nums">退出码 {run.exitCode}</span>
                )}
                {run.errorCode !== null && (
                  <span className="text-red-300">{ERROR_CODE_LABEL[run.errorCode]}</span>
                )}
                {run.usage !== null && <UsageLine usage={run.usage} />}
              </div>

              {run.error !== null && (
                <p className="mt-2 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">
                  {run.error}
                </p>
              )}

              {events.length > 0 ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  {events.map((event) => (
                    <RunEventLine key={event.seq} event={event} />
                  ))}
                </div>
              ) : (
                run.output !== '' && (
                  <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-black/30 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-dim">
                    {run.output}
                  </pre>
                )
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
