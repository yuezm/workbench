/**
 * 任务进入阶段的效果（纯函数，M6 从 `decide.ts` 抽出）。
 *
 * 进入阶段：落点 `entryMode='agent'` 且智能体 / 运行时都在时，产一条 `run.queued`
 * （完整 `RunRow`，宿主直接领取执行）。人工拖拽、建任务、回执流转、规则建任务
 * 共用这一条路径——「规则只建任务，进入阶段后与手工任务同一个引擎」。
 *
 * 规则触发的首轮可带 `RunTrigger`：`ruleId/rulesVersion/eventIds/hops` 写进 run 行，
 * 规则 `prompt` 追加到提示词末尾（固定段，不拼外部事件正文）。
 */
import type { Runtime, Task } from '../protocol/entities'
import type { ThreadRow } from '../protocol/thread'
import type { TaskComment } from '../protocol/task-comment'
import type { Actor, Environment, FactDraft, View } from './types'
import { taskPrompt } from './prompt'
import { runCountOfTask, threadSessions } from './threads'
import { threadContextText } from './thread-context'

/** 权限模式 → 协议帧的 access 级别（SPEC-plugins「Turn」）。 */
export const ACCESS_BY_PERMISSION: Record<Runtime['permissionMode'], 'read' | 'edit' | 'full'> = {
  'read-only': 'read',
  'workspace-write': 'edit',
  'danger-full-access': 'full',
}

/** 规则触发的首轮元信息（规则建任务时传给 `entryRunFacts`）。 */
export interface RunTrigger {
  ruleId: string
  rulesVersion: number
  eventIds: string[]
  hops: number
  /** 规则附加说明（固定文本，不拼外部事件正文） */
  promptExtra?: string
}

/**
 * 进入阶段的效果：落点阶段 `entryMode='agent'` 且智能体 / 运行时都在时，产一条
 * `run.queued`。
 *
 * 每次进入都触发（人工拖拽、建任务、回执流转、规则建任务都重新建 run）；以下零事实：
 * - 阶段是 `user` / `none`（等人或仅停留）；
 * - 任务已完成 / 无当前阶段；
 * - 阶段没有绑定智能体，或智能体 / 运行时已不存在（旧 `applyStageEffects` 同口径）。
 *
 * M6.5：任务挂线程时，run 写 `threadId`、拼线程上下文、按「同线程同智能体最近的会话」
 * 续接；`options.thread` 用于本批刚打开的新线程（视图里还没有），`options.turn` 用于
 * 复用任务追加一轮（视图里的 run 数没有算上本批新 run）。
 *
 * M7.5：任务的上下文 / 反馈拼成固定资料段（`taskCommentsText`）；`options.pendingComment`
 * 是本批刚追加、视图里还没有的那条（反馈顺带再跑一轮时用）。
 */
export function entryRunFacts(
  view: View,
  task: Task,
  now: string,
  env: Environment,
  actor: Actor,
  trigger?: RunTrigger,
  options?: { thread?: ThreadRow; turn?: number; pendingComment?: TaskComment },
): FactDraft<'run.queued'>[] {
  if (task.status !== 'active' || task.currentStageId === null) return []
  const stage = view.stages.get(task.currentStageId)
  if (!stage || stage.entryMode !== 'agent') return []
  const agent = stage.agentId === null ? undefined : view.agents.get(stage.agentId)
  if (!agent) return []
  const runtime = view.runtimes.get(agent.runtimeId)
  if (!runtime) return []

  const thread =
    options?.thread ?? (task.threadId === null ? undefined : view.threads.get(task.threadId))
  // 新开的隐式线程没有历史（无事件 / 笔记 / 兄弟任务）：不拼上下文段，避免提示词噪音。
  const hasHistory =
    thread !== undefined &&
    (thread.events.length > 0 || thread.notes.length > 0 || thread.taskIds.length > 1)
  const context = thread !== undefined && hasHistory ? threadContextText(view, thread) : null
  const comments = [
    ...[...view.taskComments.values()].filter((comment) => comment.taskId === task.id),
    ...(options?.pendingComment === undefined ? [] : [options.pendingComment]),
  ]
  const prompt = [
    taskPrompt(agent, task, stage.name, context, comments),
    trigger?.promptExtra ?? '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const resumeSessionId =
    thread === undefined ? null : (threadSessions(view, thread.id)[agent.id] ?? null)
  const turn = options?.turn ?? runCountOfTask(view, task.id) + 1
  return [
    {
      type: 'run.queued',
      actor,
      at: now,
      payload: {
        run: {
          id: env.nextId('run'),
          purpose: 'stage',
          taskId: task.id,
          conversationId: null,
          stageId: stage.id,
          agentId: agent.id,
          runtimeId: runtime.id,
          ruleId: trigger?.ruleId ?? null,
          rulesVersion: trigger?.rulesVersion ?? 0,
          executorKey: runtime.executorKey,
          threadId: thread?.id ?? task.threadId,
          cwd: runtime.workdir ?? '',
          access: ACCESS_BY_PERMISSION[runtime.permissionMode],
          skill: null,
          promptRef: null,
          eventIds: trigger?.eventIds ?? [],
          hops: trigger?.hops ?? 0,
          turn,
          resumeSessionId,
          threadContextRef: null,
          queueSeq: 0,
          status: 'queued',
          prompt,
          output: '',
          error: null,
          errorCode: null,
          exitCode: null,
          sessionId: null,
          usage: null,
          durationMs: null,
          leaseId: null,
          attempt: 0,
          attempts: 0,
          leaseUntil: null,
          notBefore: null,
          deadlineAt: null,
          cancelRequested: false,
          startedAt: null,
          endedAt: null,
          createdAt: now,
        },
      },
    },
  ]
}
