import type { ReactElement } from 'react'
import type {
  Run,
  RunErrorCode,
  RunEvent,
  RunStatus,
  RunUsage,
} from '../../../../../protocol/entities'
import type { TaskComment } from '../../../../../protocol/task-comment'
import { cn } from '../../../lib/cn'
import { useKernelViewState } from '../../../shell/useKernelView'

/** 工具事件内容的展示截断长度 */
const TOOL_TEXT_MAX = 120

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

/**
 * 单个 run 的事件流：一个子组件订阅一个 `run.events` 视图。
 *
 * 事件随事实失效自动重取（`run.` 前缀的失效表里有 `run.events`），不再轮询；
 * 事件流为空时回落到 run.output（历史数据仍能看到最终文本）。
 */
function RunEvents({ run }: { run: Run }): ReactElement | null {
  const state = useKernelViewState('run.events', { runId: run.id })
  const events = state.data ?? []

  if (state.error !== null) {
    return (
      <p className="mt-2 rounded-lg border border-red-400/30 bg-red-400/10 px-2.5 py-1.5 text-[11px] text-red-300">
        事件流加载失败：{state.error}
      </p>
    )
  }
  if (events.length > 0) {
    return (
      <div className="mt-2 flex flex-col gap-1.5">
        {events.map((event) => (
          <RunEventLine key={event.seq} event={event} />
        ))}
      </div>
    )
  }
  if (run.output === '') return null
  return (
    <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-black/30 p-2.5 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-dim">
      {run.output}
    </pre>
  )
}

/** 一轮运行的卡片：状态 / 时间 / 耗时 / 退出码 / 失败归类 / 用量 + 事件流 */
function RunBlock({ run }: { run: Run }): ReactElement {
  return (
    <div className="rounded-xl border border-line bg-white/[0.02] px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-faint">
        <span className={cn('rounded-full bg-white/[0.06] px-2 py-0.5', STATUS_TONE[run.status])}>
          {STATUS_LABEL[run.status]}
        </span>
        <span className="tabular-nums">{run.startedAt ?? run.createdAt}</span>
        {run.durationMs !== null && (
          <span className="tabular-nums">耗时 {formatDuration(run.durationMs)}</span>
        )}
        {run.exitCode !== null && <span className="tabular-nums">退出码 {run.exitCode}</span>}
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

      <RunEvents run={run} />
    </div>
  )
}

/** 一条任务上下文 / 反馈：作者 + 时间 + 正文（只作资料） */
function CommentBlock({ comment }: { comment: TaskComment }): ReactElement {
  return (
    <div className="rounded-xl border border-line bg-white/[0.03] px-4 py-2.5">
      <div className="flex items-center gap-2 text-[10px] text-ink-faint">
        <span className="rounded-full bg-focus/15 px-1.5 py-0.5 text-focus">
          {comment.author === 'owner' ? '我' : '智能体'}
        </span>
        <span className="tabular-nums">{comment.createdAt}</span>
      </div>
      <p className="mt-1 text-xs leading-relaxed whitespace-pre-wrap text-ink-dim">
        {comment.text}
      </p>
    </div>
  )
}

/** 活动流条目：运行与反馈按时间同序排列（同毫秒按 id，稳定可测） */
type ActivityItem =
  | { kind: 'run'; at: string; id: string; run: Run }
  | { kind: 'comment'; at: string; id: string; comment: TaskComment }

function mergeActivity(runs: readonly Run[], comments: readonly TaskComment[]): ActivityItem[] {
  const items: ActivityItem[] = [
    ...runs.map((run): ActivityItem => ({ kind: 'run', at: run.createdAt, id: run.id, run })),
    ...comments.map((comment): ActivityItem => ({
      kind: 'comment',
      at: comment.createdAt,
      id: comment.id,
      comment,
    })),
  ]
  return items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

export interface TaskActivityProps {
  runs: Run[]
  comments: TaskComment[]
}

/**
 * 任务上下文活动流（像 issue 的时间线）：智能体每一轮运行与我的反馈按时间混排。
 *
 * 数据都来自内核视图：`runs` 是 `runs.byTask`，`comments` 是 `comments.byTask`；
 * 事件流由每个 run 的子组件订阅 `run.events`，事实到达后自动刷新。
 */
export function TaskActivity({ runs, comments }: TaskActivityProps): ReactElement {
  const items = mergeActivity(runs, comments)
  if (items.length === 0) {
    return (
      <div className="grid place-items-center rounded-xl border border-dashed border-line py-6 text-xs text-ink-faint">
        还没有运行记录或反馈
      </div>
    )
  }

  return (
    <ol aria-label="上下文" className="flex flex-col gap-2.5">
      {items.map((item) => (
        <li key={`${item.kind}:${item.id}`}>
          {item.kind === 'run' ? (
            <RunBlock run={item.run} />
          ) : (
            <CommentBlock comment={item.comment} />
          )}
        </li>
      ))}
    </ol>
  )
}
