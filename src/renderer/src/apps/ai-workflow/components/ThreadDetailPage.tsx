import { useState, type FormEvent, type ReactElement } from 'react'
import type { Task } from '../../../../../protocol/entities'
import { THREAD_LIMITS, type ThreadRow } from '../../../../../protocol/thread'
import { Button } from '../../../components/ui/button'
import { Field } from '../../../components/ui/field'
import { Input, fieldCls } from '../../../components/ui/input'
import { badgeCls } from '../../../components/ui/panel'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'
import { DetailHeader } from './DetailHeader'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const textareaCls = cn(fieldCls, 'min-h-16 resize-y py-2 leading-relaxed')

/** 页面内一次写操作：进行中禁用全部动作，避免并发提交互相覆盖 */
type BusyAction = 'note' | 'bind' | 'close'

export interface ThreadDetailPageProps {
  threadId: string
  /** 返回上一级（看板 / 任务详情） */
  onBack: () => void
  /** 从线程的任务列表进入任务详情页 */
  onOpenTask: (taskId: string) => void
}

/** 任务树节点：`children` 按 `parentTaskId` 归到父任务下 */
interface TaskNode {
  task: Task
  children: TaskNode[]
}

/**
 * 线程任务树（只看 `thread.byId` 给的 `tasks` / `rootTaskIds` 与任务行的 `parentTaskId`）：
 * 根任务按 `rootTaskIds` 顺序，派生子任务缩进一层；数据异常（父任务缺失 / 环）时兜底为根，
 * 不在这里推导任何「什么算子任务」以外的业务规则。
 */
function taskTree(tasks: Task[], rootTaskIds: string[]): TaskNode[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const childrenOf = new Map<string, Task[]>()
  for (const task of tasks) {
    const parentId = task.parentTaskId
    if (parentId === null || !byId.has(parentId)) continue
    const list = childrenOf.get(parentId) ?? []
    list.push(task)
    childrenOf.set(parentId, list)
  }

  const visited = new Set<string>()
  const nodeFor = (task: Task): TaskNode => {
    visited.add(task.id)
    const children = (childrenOf.get(task.id) ?? [])
      .filter((child) => !visited.has(child.id))
      .map(nodeFor)
    return { task, children }
  }

  const roots: TaskNode[] = []
  const rootIds = [
    ...rootTaskIds,
    ...tasks
      .filter((task) => task.parentTaskId === null || !byId.has(task.parentTaskId))
      .map((task) => task.id),
  ]
  for (const id of rootIds) {
    const task = byId.get(id)
    if (task === undefined || visited.has(task.id)) continue
    roots.push(nodeFor(task))
  }
  // 父任务缺失 / 环导致的悬挂节点：作为根展示，不让任务从面板里消失
  for (const task of tasks) {
    if (!visited.has(task.id)) roots.push(nodeFor(task))
  }
  return roots
}

function TaskTreeItem({
  node,
  depth,
  onOpenTask,
}: {
  node: TaskNode
  depth: number
  onOpenTask: (taskId: string) => void
}): ReactElement {
  const completed = node.task.status === 'completed'
  return (
    <li>
      {/* 整行都是详情入口：点标题、状态徽标或行内空白都进任务详情 */}
      <button
        type="button"
        aria-label={`打开任务：${node.task.title}`}
        title={node.task.title}
        onClick={() => onOpenTask(node.task.id)}
        style={{ paddingLeft: depth * 14 }}
        className={cn(
          'group flex w-full items-center gap-2 rounded-lg py-1 pr-1 text-left',
          'transition-colors duration-200 hover:bg-white/[0.06]',
          'focus-visible:ring-2 focus-visible:ring-focus/60 focus-visible:outline-none',
        )}
      >
        {depth > 0 && (
          <span aria-hidden="true" className="text-[10px] text-ink-faint">
            ↳
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-ink-dim transition-colors group-hover:text-ink">
          {node.task.title}
        </span>
        <span
          className={cn(
            'shrink-0 rounded-sm px-1.5 py-0.5 text-[10px]',
            completed ? 'bg-white/[0.06] text-ink-faint' : 'bg-focus/15 text-focus-soft',
          )}
        >
          {completed ? '已完成' : '进行中'}
        </span>
        {depth > 0 && (
          <span className="shrink-0 rounded-sm bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-ink-faint">
            子任务
          </span>
        )}
        <span
          aria-hidden="true"
          className="shrink-0 text-[11px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
        >
          ›
        </span>
      </button>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TaskTreeItem
              key={child.task.id}
              node={child}
              depth={depth + 1}
              onOpenTask={onOpenTask}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/** 笔记：列表 + 追加输入（写命令由 `ThreadContent` 统一发，进行中禁用） */
function NotesSection({
  thread,
  text,
  busy,
  onChange,
  onSubmit,
}: {
  thread: ThreadRow
  text: string
  busy: boolean
  onChange: (text: string) => void
  onSubmit: (event: FormEvent) => void
}): ReactElement {
  return (
    <section aria-label="笔记" className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-2 text-[13px] font-medium tracking-wide text-ink">
        笔记
        <span className={badgeCls}>{thread.notes.length}</span>
        <span className="text-[11px] font-normal text-ink-faint">仅资料</span>
      </h3>
      {thread.notes.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-faint">
          暂无笔记
        </p>
      ) : (
        <ul className="max-h-56 divide-y divide-line overflow-auto rounded-xl border border-line">
          {thread.notes.map((note) => (
            <li key={note.id} className="px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] text-ink-faint">
                <span>{note.author === 'owner' ? '我' : '智能体'}</span>
                <span className="tabular-nums">{note.at}</span>
              </div>
              <p className="text-xs leading-relaxed whitespace-pre-wrap text-ink-dim">
                {note.text}
              </p>
            </li>
          ))}
        </ul>
      )}

      <form className="flex flex-col gap-2" onSubmit={onSubmit}>
        <textarea
          aria-label="线程笔记"
          className={textareaCls}
          maxLength={THREAD_LIMITS.noteText}
          placeholder="补充背景，仅作资料"
          value={text}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" size="sm" disabled={busy}>
            添加笔记
          </Button>
        </div>
      </form>
    </section>
  )
}

/** 绑定入口：未绑定时给表单；已绑定只读展示（重复绑定由内核拒绝，界面不提供入口） */
function BindSection({
  thread,
  source,
  externalRef,
  busy,
  onChangeSource,
  onChangeExternalRef,
  onSubmit,
}: {
  thread: ThreadRow
  source: string
  externalRef: string
  busy: boolean
  onChangeSource: (value: string) => void
  onChangeExternalRef: (value: string) => void
  onSubmit: (event: FormEvent) => void
}): ReactElement {
  return (
    <section aria-label="绑定入口" className="flex flex-col gap-1.5">
      <h3 className="text-[13px] font-medium tracking-wide text-ink">绑定入口</h3>
      {thread.externalRef !== null ? (
        <p className="rounded-lg border border-line bg-surface px-3 py-2 text-[11px] text-ink-dim">
          已绑定：
          <span className="font-mono text-ink-dim">{thread.source}</span>
          {' / '}
          <span className="font-mono text-ink-dim">{thread.externalRef}</span>
        </p>
      ) : (
        <form className="flex flex-col gap-2" onSubmit={onSubmit}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="入口来源">
              <Input
                aria-label="入口来源"
                maxLength={THREAD_LIMITS.source}
                placeholder="github / mail / app:pomodoro"
                value={source}
                disabled={busy}
                onChange={(e) => onChangeSource(e.target.value)}
              />
            </Field>
            <Field label="外部入口键">
              <Input
                aria-label="外部入口键"
                maxLength={THREAD_LIMITS.externalRef}
                placeholder="issue-123 / thread-id"
                value={externalRef}
                disabled={busy}
                onChange={(e) => onChangeExternalRef(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] leading-relaxed text-ink-faint">
              同一入口的新事件续进本线程。
            </p>
            <Button type="submit" variant="secondary" size="sm" disabled={busy}>
              绑定
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

/**
 * 线程内容（线程行已就绪时渲染）：元信息 / 任务列表 / 笔记 / 绑定入口 / 归档。
 *
 * 只读视图、只发命令：绑定与关闭的合法性（入口键是否被占用等）一律由内核判，
 * 失败文案就地展示；一次只允许一个写操作，进行中禁用全部动作。
 * 任务行是页面跳转入口：任务详情在内容区展开，不再弹窗。
 */
function ThreadContent({
  thread,
  tasks,
  onOpenTask,
}: {
  thread: ThreadRow
  tasks: Task[]
  onOpenTask: (taskId: string) => void
}): ReactElement {
  const [busy, setBusy] = useState<BusyAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [bindSource, setBindSource] = useState('')
  const [bindRef, setBindRef] = useState('')

  const busyNow = busy !== null
  const closed = thread.status === 'closed'

  const runAction = (action: BusyAction, task: () => Promise<void>): void => {
    setBusy(action)
    setActionError(null)
    void (async () => {
      try {
        await task()
      } catch (e) {
        setActionError(errMsg(e))
      } finally {
        setBusy(null)
      }
    })()
  }

  const addNote = (event: FormEvent): void => {
    event.preventDefault()
    const text = noteText.trim()
    if (text === '') {
      setActionError('笔记不能为空')
      return
    }
    runAction('note', async () => {
      await getKernelStore().dispatch({
        type: 'thread.note',
        commandId: '',
        threadId: thread.id,
        text,
      })
      setNoteText('')
    })
  }

  const bind = (event: FormEvent): void => {
    event.preventDefault()
    const source = bindSource.trim()
    const externalRef = bindRef.trim()
    if (source === '') {
      setActionError('入口来源必填')
      return
    }
    if (externalRef === '') {
      setActionError('入口键必填')
      return
    }
    runAction('bind', async () => {
      await getKernelStore().dispatch({
        type: 'thread.bind',
        commandId: '',
        threadId: thread.id,
        source,
        externalRef,
      })
      setBindSource('')
      setBindRef('')
    })
  }

  const closeThread = (): void => {
    runAction('close', async () => {
      await getKernelStore().dispatch({ type: 'thread.close', commandId: '', threadId: thread.id })
    })
  }

  const roots = taskTree(tasks, thread.rootTaskIds)

  return (
    <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3 text-[11px] sm:grid-cols-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[11px] tracking-wide text-ink-dim">来源</dt>
          <dd className="truncate font-mono text-ink-dim">{thread.source}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[11px] tracking-wide text-ink-dim">外部入口</dt>
          <dd className="truncate font-mono text-ink-dim">{thread.externalRef ?? '未绑定'}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[11px] tracking-wide text-ink-dim">状态</dt>
          <dd className="text-ink-dim">{closed ? '已归档' : '进行中'}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[11px] tracking-wide text-ink-dim">并发</dt>
          <dd className="text-ink-dim tabular-nums">{thread.concurrency}</dd>
        </div>
      </dl>

      {actionError !== null && (
        <p
          role="alert"
          className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300"
        >
          {actionError}
        </p>
      )}

      <section aria-label="任务列表" className="flex flex-col gap-1.5">
        <h3 className="flex items-center gap-2 text-[13px] font-medium tracking-wide text-ink">
          任务列表
          <span className={badgeCls}>{thread.taskIds.length}</span>
          <span className="text-[11px] font-normal text-ink-faint">点任务看详情</span>
        </h3>
        {roots.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-faint">
            暂无任务
          </p>
        ) : (
          <ul className="rounded-xl border border-line bg-surface px-2 py-1">
            {roots.map((node) => (
              <TaskTreeItem key={node.task.id} node={node} depth={0} onOpenTask={onOpenTask} />
            ))}
          </ul>
        )}
      </section>

      <NotesSection
        thread={thread}
        text={noteText}
        busy={busyNow}
        onChange={setNoteText}
        onSubmit={addNote}
      />

      <BindSection
        thread={thread}
        source={bindSource}
        externalRef={bindRef}
        busy={busyNow}
        onChangeSource={setBindSource}
        onChangeExternalRef={setBindRef}
        onSubmit={bind}
      />

      <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
        <p className="text-[11px] leading-relaxed text-ink-faint">
          {closed ? '线程已归档。' : '归档只影响界面。'}
        </p>
        {!closed && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busyNow}
            onClick={closeThread}
          >
            归档
          </Button>
        )}
      </div>
    </>
  )
}

/**
 * 线程详情页（M6.5 起是页面，不再是弹窗）：读 `thread.byId`，把线程行与任务列表交给
 * `ThreadContent`；读失败 / 线程不存在在这里收口，写错误在内容区就地展示。
 */
export function ThreadDetailPage({
  threadId,
  onBack,
  onOpenTask,
}: ThreadDetailPageProps): ReactElement {
  const state = useKernelViewState('thread.byId', { threadId })
  const detail = state.data
  const title = detail === undefined || detail === null ? '线程' : `线程 · ${detail.thread.title}`
  const hint =
    detail === undefined || detail === null
      ? '读取线程中'
      : `${detail.thread.source} · ${detail.thread.taskIds.length} 个任务`

  return (
    <section aria-label="线程详情" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <DetailHeader title={title} hint={hint} onBack={onBack} />

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {state.error !== null && (
          <p
            role="alert"
            className="rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-300"
          >
            {state.error}
          </p>
        )}

        {detail === undefined ? (
          state.error === null && <p className="text-xs text-ink-faint">正在读取线程…</p>
        ) : detail === null ? (
          <p className="rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-faint">
            线程不存在
          </p>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            <ThreadContent thread={detail.thread} tasks={detail.tasks} onOpenTask={onOpenTask} />
          </div>
        )}
      </div>
    </section>
  )
}
