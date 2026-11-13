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
import type { Task, WorkflowStage } from '../protocol/entities'
import type { Access, PermissionMode } from '../protocol/entities'
import { ACCESS_BY_PERMISSION } from '../protocol/entities'
import type { ThreadRow } from '../protocol/thread'
import type { TaskComment } from '../protocol/task-comment'
import type { Actor, Environment, FactDraft, View } from './types'
import { taskPrompt } from './prompt'
import { sourceHandoffOf } from './handoff-source'
import { locateReport } from './review'
import { runCountOfTask, stageRoundCount, taskSessions } from './threads'
import { threadContextText, hasThreadHistory } from './thread-context'

/** 规则触发的首轮元信息（规则建任务时传给 `entryRunFacts`）。 */
export interface RunTrigger {
  ruleId: string | null
  rulesVersion: number
  eventIds: string[]
  hops: number
  /** 规则附加说明（固定文本，不拼外部事件正文） */
  promptExtra?: string
}

/**
 * 派活权限（M28）：**闸门阶段至少 full**。
 *
 * 为什么要有这条：闸门阶段的验收要求「`checks` 里给命令与退出码」，而 `workspace-write`
 * 在 Claude Code 里是 `acceptEdits`——只能改文件，跑 `pnpm` / `pytest` 这类命令仍要审批；
 * 无审批面时被自动拒（实测 2026-11-12 线程 `27787670`：三轮评审 31 次 permission denied，
 * 评审者只能静态通读，判据「checks 全部退出码 0」永远拿不到）。闸门阶段本来就要跑门禁，
 * 所以它的权限由阶段语义决定，不受智能体 `permissionMode` 拖累。
 *
 * 非闸门阶段仍按智能体配置走（`ACCESS_BY_PERMISSION`）。
 */
export function runAccessOf(stage: Pick<WorkflowStage, 'judge'>, mode: PermissionMode): Access {
  const gated = stage.judge !== null && stage.judge !== undefined
  return gated ? 'full' : ACCESS_BY_PERMISSION[mode]
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
  options?: {
    thread?: ThreadRow
    turn?: number
    pendingComment?: TaskComment
    /**
     * 本轮的会话策略（M28）：
     * - `resume`：接同任务同智能体上一轮的会话（重跑 / 反馈顺带再跑）；
     * - `fresh`：新开会话（阶段流转进入新一轮、人工拖拽重进）；
     * - 缺省：本阶段第 1 轮续接，第 2 轮起新开。
     */
    roundSession?: 'resume' | 'fresh'
  },
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
  // 新开的隐式线程没有历史（无事件 / 笔记 / 兄弟任务 / 已终态 run）：不拼上下文段，避免提示词噪音。
  // 判据收在 `hasThreadHistory`：同一任务重跑、打回重做时线程只有它自己，但仍要看到上一轮产出。
  const context =
    thread !== undefined && hasThreadHistory(view, thread)
      ? threadContextText(view, thread, task.id)
      : null
  const comments = [
    ...[...view.taskComments.values()].filter((comment) => comment.taskId === task.id),
    ...(options?.pendingComment === undefined ? [] : [options.pendingComment]),
  ]
  // M24：本阶段要处理的评审报告决定回执里有没有 `addresses` 的出口——没有报告时
  // 提示词不再念「逐条回应」，省掉一段用不上的指令。
  const reviewing = locateReport(view, task) !== undefined
  // M28：本阶段已跑过几次（不含本轮）。它只决定会话策略（第 2 次起开新会话），
  // M34 起不再进提示词——续轮已删除，「第 N 轮」对执行没有行动指引。
  const previousRounds = stageRoundCount(view, task.id, stage.id)
  const prompt = [
    taskPrompt(agent, task, stage, context, comments, {
      reviewing,
      handoffSource: sourceHandoffOf(view, task),
    }),
    trigger?.promptExtra ?? '',
  ]
    .filter(Boolean)
    .join('\n\n')
  // M15：会话键 = (taskId, agentId)。同一任务续接（打回重做 / 反馈 / turn+1），
  // 换任务或换智能体都开新会话——跨任务信息走「任务索引 + 产物路径」，不共享历史。
  //
  // M28：**本阶段第 2 轮起默认不再续接**。评审 / 复核这类阶段第二轮读的是「新的代码状态 +
  // 上一轮待改项」，而续接会把上一轮全部工具流水再送一遍（实测单轮 input 从 305k 涨到
  // 696k，cacheRead 18M）。上一轮的正文与待修复清单已经在提示词里（`precedingBlock` /
  // `reviewBlock`），续接没有新信息。调用方可以用 `roundSession` 明确覆盖：
  // `task.rerun` / 反馈顺带重跑传 `resume`（人主动重跑，要记忆），阶段流转传 `fresh`。
  const attachSession =
    options?.roundSession === undefined ? previousRounds === 0 : options.roundSession === 'resume'
  const resumeSessionId = attachSession ? (taskSessions(view, task.id)[agent.id] ?? null) : null
  const turn = options?.turn ?? runCountOfTask(view, task.id) + 1
  // M10：项目文件夹就是本轮的工作目录；任务没有项目（存量 / 未归属）时退回智能体配置。
  const project = task.projectId === null ? undefined : view.projects.get(task.projectId)
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
          cwd: project?.path ?? agent.workdir ?? '',
          access: runAccessOf(stage, agent.permissionMode),
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
          deliverables: null,
          startedAt: null,
          endedAt: null,
          createdAt: now,
        },
      },
    },
  ]
}
