import { useState, type ReactElement } from 'react'
import type {
  Run,
  RunErrorCode,
  RunEvent,
  RunStatus,
  RunUsage,
} from '../../../../../protocol/entities'
import type { TaskComment } from '../../../../../protocol/task-comment'
import { Button } from '../../../components/ui/button'
import { FormError } from '../../../components/ui/form-error'
import { cn } from '../../../lib/cn'
import { useKernelViewState } from '../../../shell/useKernelView'

/** 工具事件内容的展示截断长度 */
const TOOL_TEXT_MAX = 120

/** 正文缩略上限：最多 6 行（多阶段任务每阶段一轮 run，全文会把整页冲垮） */
export const SUMMARY_MAX_LINES = 6

/** 正文缩略上限：最多 400 字符（长段不换行的正文按字数截） */
export const SUMMARY_MAX_CHARS = 400

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
  queued: 'text-brand',
  running: 'text-brand',
  waiting: 'text-info',
  succeeded: 'text-success',
  failed: 'text-destructive',
  cancelled: 'text-faint-foreground',
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
      return <p className="text-sm whitespace-pre-wrap text-muted-foreground">{event.text}</p>
    case 'thinking':
      return (
        <p className="text-sm whitespace-pre-wrap text-faint-foreground italic">{event.text}</p>
      )
    case 'tool_call':
      return (
        <p className="rounded-md bg-muted px-2 py-1 font-mono text-sm text-muted-foreground">
          {['工具调用：' + (event.tool ?? '未知工具'), truncate(event.input ?? '', TOOL_TEXT_MAX)]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )
    case 'tool_result':
      return (
        <p
          className={cn(
            'rounded-md bg-muted px-2 py-1 font-mono text-sm text-muted-foreground',
            event.isError === true && 'text-destructive',
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

/** 过程类事件（思考 / 工具调用 / 工具结果）：默认折起来，只留正文 */
const isProcessEvent = (event: RunEvent): boolean =>
  event.type === 'thinking' || event.type === 'tool_call' || event.type === 'tool_result'

/** 正文缩略：先按行截到 6 行，再按字数截到 400（两个上限都要，长段不换行时按字算） */
function summarizeBody(text: string): string {
  const head = text.split('\n').slice(0, SUMMARY_MAX_LINES).join('\n')
  return head.length > SUMMARY_MAX_CHARS ? head.slice(0, SUMMARY_MAX_CHARS) : head
}

/** 过程折叠行：思考 / 工具调用与结果，默认收起，展开后逐条看 */
function ProcessFold({ process }: { process: RunEvent[] }): ReactElement {
  return (
    <details className="rounded-md bg-muted px-2 py-1">
      <summary className="cursor-pointer text-sm text-faint-foreground select-none">
        过程 · {process.length} 条（思考 / 工具调用与结果）
      </summary>
      <div className="mt-1.5 flex flex-col gap-1.5">
        {process.map((event) => (
          <RunEventLine key={event.seq} event={event} />
        ))}
      </div>
    </details>
  )
}

/**
 * 单个 run 的事件流：一个子组件订阅一个 `run.events` 视图。
 *
 * 事件随事实失效自动重取（`run.` 前缀的失效表里有 `run.events`），不再轮询；
 * 正文（`text`）默认只给缩略版（≤6 行且 ≤400 字），「展开全部」后才是完整正文事件流，
 * 思考与工具过程折进可展开的「过程」行，避免冲掉结论；
 * 折叠状态是这个 run 自己的本地状态（默认收起，切换任务/重跑不影响别的 run）。
 * 事件流为空时回落到 run.output（历史数据仍能看到最终文本）。
 */
function RunEvents({ run }: { run: Run }): ReactElement | null {
  const state = useKernelViewState('run.events', { runId: run.id })
  const [expanded, setExpanded] = useState(false)
  const events = state.data ?? []

  if (state.error !== null) {
    return <FormError message={`事件流加载失败：${state.error}`} className="mt-2" />
  }
  if (events.length > 0) {
    const body = events.filter((event) => !isProcessEvent(event))
    const process = events.filter(isProcessEvent)
    const bodyText = body
      .filter((event) => event.type === 'text')
      .map((event) => event.text ?? '')
      .join('\n')

    // 没有正文（只有思考 / 工具过程）：没有可缩略的东西，直接把过程折叠行摆出来
    if (bodyText === '') {
      return process.length === 0 ? null : (
        <div className="mt-2 flex flex-col gap-1.5">
          <ProcessFold process={process} />
        </div>
      )
    }

    const summary = summarizeBody(bodyText)
    /** 还有没露出来的东西才有必要给「展开全部」（正文被截断，或过程行被挡住） */
    const hidden = summary.length < bodyText.length || process.length > 0

    if (!expanded) {
      return (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">{summary}</p>
          {hidden && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setExpanded(true)}
            >
              展开全部（约 {bodyText.length} 字）
            </Button>
          )}
        </div>
      )
    }

    return (
      <div className="mt-2 flex flex-col gap-1.5">
        {body.map((event) => (
          <RunEventLine key={event.seq} event={event} />
        ))}
        {process.length > 0 && <ProcessFold process={process} />}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setExpanded(false)}
        >
          收起
        </Button>
      </div>
    )
  }
  if (run.output === '') return null
  return (
    <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-muted p-2.5 text-sm whitespace-pre-wrap text-muted-foreground">
      {run.output}
    </pre>
  )
}

/** 提权结果 → 中文标签；未知值原样显示（会话日志是外部数据，不锁词表） */
const APPROVAL_LABEL: Record<string, string> = {
  'allowed-once': '已自动放行',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '无人应答',
}

/**
 * 沙箱提权记录（`run.approvals`，宿主视图）：只读该 run 的 dsh 会话日志。
 *
 * 运行时对提权请求的回答是自动的（恒为 `allowed-once`），界面上原本没有任何痕迹；
 * 这里至少把「哪个工具、什么理由、结果如何」摆在运行卡片里，让自动放行可复核。
 * 无记录时不占版面；读取失败按空处理（审计缺失不拖垮任务详情）。
 */
function RunApprovals({ runId }: { runId: string }): ReactElement | null {
  const state = useKernelViewState('run.approvals', { runId })
  const approvals = state.data ?? []
  if (approvals.length === 0) return null

  return (
    <ul aria-label="提权记录" className="mt-2 flex flex-col gap-1">
      {approvals.map((item) => (
        <li
          key={item.id}
          className="rounded-md border border-warning/20 bg-warning/[0.06] px-2 py-1 text-sm text-warning"
        >
          <span className="font-medium">提权 · {item.tool === '' ? '未知工具' : item.tool}</span>
          <span className="ml-1.5 text-faint-foreground">
            {item.outcome === null ? '未落定' : (APPROVAL_LABEL[item.outcome] ?? item.outcome)}
          </span>
          {item.reason !== '' && (
            <span className="mt-0.5 block text-faint-foreground">{item.reason}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** 阶段引用（页面传进来的当前工作流阶段，只需要 id + 名字） */
export type StageRef = { id: string; name: string }

/** 阶段徽标文案：阶段被删 / run 属于别的工作流时退化为「未知阶段」 */
function stageLabelOf(stages: ReadonlyArray<StageRef>, stageId: string | null): string {
  if (stageId === null) return '未知阶段'
  return stages.find((item) => item.id === stageId)?.name ?? '未知阶段'
}

/** 一轮运行的卡片：阶段 + 轮次 + 状态 / 时间 / 耗时 / 退出码 / 失败归类 / 用量 + 事件流 */
function RunBlock({
  run,
  turn,
  stages,
}: {
  run: Run
  /** 同任务内 run 的序号（1 基，按 createdAt；IPC Run 没有 turn 字段，轮次由活动流算） */
  turn: number
  stages: ReadonlyArray<StageRef>
}): ReactElement {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="rounded-sm bg-primary/15 px-1.5 py-0.5 text-brand">
          {stageLabelOf(stages, run.stageId)}
        </span>
        <span className="text-faint-foreground tabular-nums">第 {turn} 轮</span>
        <span className={cn('rounded-sm bg-accent px-2 py-0.5', STATUS_TONE[run.status])}>
          {STATUS_LABEL[run.status]}
        </span>
        <span className="tabular-nums">{run.startedAt ?? run.createdAt}</span>
        {run.durationMs !== null && (
          <span className="tabular-nums">耗时 {formatDuration(run.durationMs)}</span>
        )}
        {run.exitCode !== null && <span className="tabular-nums">退出码 {run.exitCode}</span>}
        {run.errorCode !== null && (
          <span className="text-destructive">{ERROR_CODE_LABEL[run.errorCode]}</span>
        )}
        {run.usage !== null && <UsageLine usage={run.usage} />}
      </div>

      <FormError message={run.error} className="mt-2" />

      <RunApprovals runId={run.id} />

      <RunEvents run={run} />
    </div>
  )
}

/** 一条任务上下文 / 反馈：作者 + 时间 + 正文（只作资料） */
function CommentBlock({ comment }: { comment: TaskComment }): ReactElement {
  return (
    <div className="rounded-xl border border-border bg-muted px-4 py-2.5">
      <div className="flex items-center gap-2 text-xs text-faint-foreground">
        <span className="rounded-sm bg-primary/15 px-1.5 py-0.5 text-brand">
          {comment.author === 'owner' ? '我' : '智能体'}
        </span>
        <span className="tabular-nums">{comment.createdAt}</span>
      </div>
      <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">{comment.text}</p>
    </div>
  )
}

/** 活动流条目：运行与反馈按时间同序排列（同毫秒按 id，稳定可测） */
type ActivityItem =
  | { kind: 'run'; at: string; id: string; run: Run; turn: number }
  | { kind: 'comment'; at: string; id: string; comment: TaskComment }

/** 同任务内 run 的轮次（1 基）：按 createdAt、同毫秒按 id 排，与活动流顺序一致 */
function sortRuns(runs: readonly Run[]): Run[] {
  return [...runs].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )
}

function mergeActivity(runs: readonly Run[], comments: readonly TaskComment[]): ActivityItem[] {
  const items: ActivityItem[] = [
    ...sortRuns(runs).map((run, index): ActivityItem => ({
      kind: 'run',
      at: run.createdAt,
      id: run.id,
      run,
      turn: index + 1,
    })),
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
  /** 当前工作流的阶段（阶段名从这里查；缺数据时运行卡片显示「未知阶段」） */
  stages: ReadonlyArray<StageRef>
}

/**
 * 任务上下文活动流（像 issue 的时间线）：智能体每一轮运行与我的反馈按时间混排。
 *
 * 数据都来自内核视图：`runs` 是 `runs.byTask`，`comments` 是 `comments.byTask`；
 * 事件流由每个 run 的子组件订阅 `run.events`，事实到达后自动刷新。
 * 多阶段任务每阶段一轮 run：卡片头部标出阶段名与「第 N 轮」，正文默认只给缩略，
 * 由使用者按需展开（详见 `RunEvents`）。
 */
export function TaskActivity({ runs, comments, stages }: TaskActivityProps): ReactElement {
  const items = mergeActivity(runs, comments)
  if (items.length === 0) {
    return (
      <div className="grid place-items-center rounded-xl border border-dashed border-border py-6 text-sm text-faint-foreground">
        还没有运行记录或反馈
      </div>
    )
  }

  return (
    <ol aria-label="上下文" className="flex flex-col gap-2.5">
      {items.map((item) => (
        <li key={`${item.kind}:${item.id}`}>
          {item.kind === 'run' ? (
            <RunBlock run={item.run} turn={item.turn} stages={stages} />
          ) : (
            <CommentBlock comment={item.comment} />
          )}
        </li>
      ))}
    </ol>
  )
}
