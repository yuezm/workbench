import { useState, type FormEvent, type ReactElement } from 'react'
import type { Task } from '../../../../../protocol/entities'
import { THREAD_LIMITS, type ThreadRow } from '../../../../../protocol/thread'
import { Button } from '../../../components/ui/button'
import { Field } from '../../../components/ui/field'
import { FormError } from '../../../components/ui/form-error'
import { Input } from '../../../components/ui/input'
import { badgeCls } from '../../../components/ui/panel'
import { Textarea } from '../../../components/ui/textarea'
import { cn } from '../../../lib/cn'
import { getKernelStore } from '../../../shell/kernelStore'
import { useKernelViewState } from '../../../shell/useKernelView'
import { DetailHeader } from './DetailHeader'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const textareaCls = 'min-h-16 resize-y'

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
          'transition-colors duration-200 hover:bg-accent',
          'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none',
        )}
      >
        {depth > 0 && (
          <span aria-hidden="true" className="text-xs text-faint-foreground">
            ↳
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground transition-colors group-hover:text-foreground">
          {node.task.title}
        </span>
        <span
          className={cn(
            'shrink-0 rounded-sm px-1.5 py-0.5 text-xs',
            completed ? 'bg-accent text-faint-foreground' : 'bg-primary/15 text-brand',
          )}
        >
          {completed ? '已完成' : '进行中'}
        </span>
        {depth > 0 && (
          <span className="shrink-0 rounded-sm bg-accent px-1.5 py-0.5 text-xs text-faint-foreground">
            子任务
          </span>
        )}
        <span
          aria-hidden="true"
          className="shrink-0 text-xs text-faint-foreground opacity-0 transition-opacity group-hover:opacity-100"
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
  error,
  onChange,
  onSubmit,
}: {
  thread: ThreadRow
  text: string
  busy: boolean
  error: string | null
  onChange: (text: string) => void
  onSubmit: (event: FormEvent) => void
}): ReactElement {
  return (
    <section aria-label="笔记" className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
        笔记
        <span className={badgeCls}>{thread.notes.length}</span>
        <span className="text-xs font-normal text-faint-foreground">仅资料</span>
      </h3>
      {thread.notes.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-faint-foreground">
          暂无笔记
        </p>
      ) : (
        <ul className="max-h-56 divide-y divide-border overflow-auto rounded-xl border border-border">
          {thread.notes.map((note) => (
            <li key={note.id} className="px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-faint-foreground">
                <span>{note.author === 'owner' ? '我' : '智能体'}</span>
                <span className="tabular-nums">{note.at}</span>
              </div>
              <p className="text-sm whitespace-pre-wrap text-muted-foreground">{note.text}</p>
            </li>
          ))}
        </ul>
      )}

      <form className="flex flex-col gap-2" onSubmit={onSubmit}>
        <Textarea
          aria-label="线程笔记"
          className={textareaCls}
          maxLength={THREAD_LIMITS.noteText}
          placeholder="补充背景，仅作资料"
          value={text}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
        />
        {/* 笔记的失败就地贴在自己的输入框下方，不用去页顶找 */}
        <FormError message={error} />
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
  sourceError,
  refError,
  formError,
  onChangeSource,
  onChangeExternalRef,
  onSubmit,
}: {
  thread: ThreadRow
  source: string
  externalRef: string
  busy: boolean
  sourceError?: string
  refError?: string
  formError?: string | null
  onChangeSource: (value: string) => void
  onChangeExternalRef: (value: string) => void
  onSubmit: (event: FormEvent) => void
}): ReactElement {
  return (
    <section aria-label="绑定入口" className="flex flex-col gap-1.5">
      <h3 className="text-base font-medium text-foreground">绑定入口</h3>
      {thread.externalRef !== null ? (
        <p className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
          已绑定：
          <span className="font-mono text-muted-foreground">{thread.source}</span>
          {' / '}
          <span className="font-mono text-muted-foreground">{thread.externalRef}</span>
        </p>
      ) : (
        <form className="flex flex-col gap-2" onSubmit={onSubmit}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="入口来源" required error={sourceError}>
              <Input
                aria-label="入口来源"
                maxLength={THREAD_LIMITS.source}
                placeholder="github / mail / app:pomodoro"
                value={source}
                disabled={busy}
                onChange={(e) => onChangeSource(e.target.value)}
              />
            </Field>
            <Field label="外部入口键" required error={refError}>
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
          {/* 内核拒绝绑定的原因（入口键被占用等）就地贴在提交按钮上方 */}
          <FormError message={formError} />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-faint-foreground">同一入口的新事件续进本线程。</p>
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
  /** 笔记失败原因：贴在笔记输入框下方 */
  const [noteError, setNoteError] = useState<string | null>(null)
  /** 绑定失败原因：字段级 or 表单级（内核拒绝），都留在绑定表单里 */
  const [bindErrors, setBindErrors] = useState<{
    source?: string
    ref?: string
    form?: string
  }>({})
  /** 归档失败原因：贴在归档按钮旁边 */
  const [closeError, setCloseError] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [bindSource, setBindSource] = useState('')
  const [bindRef, setBindRef] = useState('')

  const busyNow = busy !== null
  const closed = thread.status === 'closed'

  /**
   * 写操作的错误按「哪一块表单」分开存：失败文案要贴在用户刚动过的地方，
   * 而不是统一丢到页面顶部（在长页面里那等于没提示）。
   */
  const runAction = (
    action: BusyAction,
    task: () => Promise<void>,
    fail: (message: string) => void,
  ): void => {
    setBusy(action)
    setNoteError(null)
    setBindErrors({})
    setCloseError(null)
    void (async () => {
      try {
        await task()
      } catch (e) {
        fail(errMsg(e))
      } finally {
        setBusy(null)
      }
    })()
  }

  const addNote = (event: FormEvent): void => {
    event.preventDefault()
    const text = noteText.trim()
    if (text === '') {
      setNoteError('笔记不能为空')
      return
    }
    runAction(
      'note',
      async () => {
        await getKernelStore().dispatch({
          type: 'thread.note',
          commandId: '',
          threadId: thread.id,
          text,
        })
        setNoteText('')
      },
      setNoteError,
    )
  }

  const bind = (event: FormEvent): void => {
    event.preventDefault()
    const source = bindSource.trim()
    const externalRef = bindRef.trim()
    if (source === '') {
      setBindErrors({ source: '入口来源必填' })
      return
    }
    if (externalRef === '') {
      setBindErrors({ ref: '入口键必填' })
      return
    }
    runAction(
      'bind',
      async () => {
        await getKernelStore().dispatch({
          type: 'thread.bind',
          commandId: '',
          threadId: thread.id,
          source,
          externalRef,
        })
        setBindSource('')
        setBindRef('')
      },
      (message) => setBindErrors({ form: message }),
    )
  }

  const closeThread = (): void => {
    runAction(
      'close',
      async () => {
        await getKernelStore().dispatch({
          type: 'thread.close',
          commandId: '',
          threadId: thread.id,
        })
      },
      setCloseError,
    )
  }

  const roots = taskTree(tasks, thread.rootTaskIds)

  return (
    <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 text-sm sm:grid-cols-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">来源</dt>
          <dd className="truncate font-mono text-muted-foreground">{thread.source}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">外部入口</dt>
          <dd className="truncate font-mono text-muted-foreground">
            {thread.externalRef ?? '未绑定'}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">状态</dt>
          <dd className="text-muted-foreground">{closed ? '已归档' : '进行中'}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">并发</dt>
          <dd className="text-muted-foreground tabular-nums">{thread.concurrency}</dd>
        </div>
      </dl>

      {/* 写操作进行中：按钮会一起变灰，这里说清楚为什么点不动其它动作 */}
      {busyNow && <p className="text-xs text-faint-foreground">正在提交，其他操作暂不可用。</p>}

      <section aria-label="任务列表" className="flex flex-col gap-1.5">
        <h3 className="flex items-center gap-2 text-base font-medium text-foreground">
          任务列表
          <span className={badgeCls}>{thread.taskIds.length}</span>
          <span className="text-xs font-normal text-faint-foreground">点任务看详情</span>
        </h3>
        {roots.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-faint-foreground">
            暂无任务
          </p>
        ) : (
          <ul className="rounded-xl border border-border bg-card px-2 py-1">
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
        error={noteError}
        onChange={(value) => {
          setNoteError(null)
          setNoteText(value)
        }}
        onSubmit={addNote}
      />

      <BindSection
        thread={thread}
        source={bindSource}
        externalRef={bindRef}
        busy={busyNow}
        sourceError={bindErrors.source}
        refError={bindErrors.ref}
        formError={bindErrors.form}
        onChangeSource={(value) => {
          setBindErrors({})
          setBindSource(value)
        }}
        onChangeExternalRef={(value) => {
          setBindErrors({})
          setBindRef(value)
        }}
        onSubmit={bind}
      />

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <FormError message={closeError} />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-faint-foreground">
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
        <FormError message={state.error} />

        {detail === undefined ? (
          state.error === null && <p className="text-xs text-faint-foreground">正在读取线程…</p>
        ) : detail === null ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-2 text-sm text-faint-foreground">
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
