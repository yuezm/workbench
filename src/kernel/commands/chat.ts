/**
 * 对话命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type {
  Agent,
  Conversation,
  Message,
  Project,
  RunRow,
  Runtime,
} from '../../protocol/entities'
import { ACCESS_BY_PERMISSION } from '../../protocol/entities'
import type { Input } from '../../protocol/inputs'
import type { Decision, Environment, FactDraft, Id, Iso, View } from '../types'
import { chatPrompt, titleFromContent } from '../prompt'
import { done, ownerDraft, reject } from './common'

/** 对话下的消息，按创建时间排序（同毫秒按 id 兜底），供首轮提示词拼历史。 */
function messagesOf(view: View, conversationId: Id): Message[] {
  const messages: Message[] = []
  for (const message of view.messages.values()) {
    if (message.conversationId === conversationId) messages.push(message)
  }
  return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** 同一对话同时只跑一轮：存在 queued/running/waiting 的 run 即视为忙。 */
function conversationBusy(view: View, conversationId: Id): boolean {
  for (const run of view.runs.values()) {
    if (run.conversationId !== conversationId) continue
    if (run.status === 'queued' || run.status === 'running' || run.status === 'waiting') {
      return true
    }
  }
  return false
}

/** 对话下已有的 run 数（聊天 run 的 `turn` = 已有轮次 + 1）。 */
function conversationRunCount(view: View, conversationId: Id): number {
  let count = 0
  for (const run of view.runs.values()) {
    if (run.conversationId === conversationId) count += 1
  }
  return count
}

/**
 * 聊天 run 的完整投影行：purpose='chat'，连接来自运行时、执行配置来自智能体。
 *
 * 工作目录（M11）：对话所属项目的文件夹；没有项目（默认目录）时回落智能体的 `workdir`，
 * 再空串——空串由宿主在执行时换成宿主的默认工作目录（`runtimes.default-workdir`）。
 */
function chatRunRow(
  conversation: Conversation,
  agent: Agent,
  runtime: Runtime,
  projects: ReadonlyMap<Id, Project>,
  runId: Id,
  prompt: string,
  turn: number,
  now: Iso,
): RunRow {
  return {
    id: runId,
    purpose: 'chat',
    taskId: null,
    conversationId: conversation.id,
    stageId: null,
    agentId: agent.id,
    runtimeId: runtime.id,
    ruleId: null,
    rulesVersion: 0,
    executorKey: runtime.executorKey,
    threadId: null,
    cwd: projects.get(conversation.projectId ?? '')?.path ?? agent.workdir ?? '',
    access: ACCESS_BY_PERMISSION[agent.permissionMode],
    skill: null,
    promptRef: null,
    eventIds: [],
    hops: 0,
    turn,
    resumeSessionId: conversation.sessionId,
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
  }
}

export function createConversation(
  view: View,
  input: Extract<Input, { type: 'chat.create' }>,
  now: Iso,
  env: Environment,
): Decision {
  const agent = view.agents.get(input.agentId)
  if (!agent) return reject('not_found', '智能体不存在: ' + input.agentId)
  // M11：聊天和任务共用项目这一顶层上下文；没给项目 = 默认目录（`projectId` 落 null）
  const projectId = input.projectId?.trim() || null
  if (projectId !== null && !view.projects.has(projectId)) {
    return reject('not_found', '项目不存在: ' + projectId)
  }
  const conversation: Conversation = {
    id: env.nextId('conversation'),
    title: input.title?.trim() || '新对话',
    agentId: agent.id,
    projectId,
    sessionId: null,
    createdAt: now,
    updatedAt: now,
  }
  return done([ownerDraft('conversation.created', { conversation }, now)])
}

export function sendChat(
  view: View,
  input: Extract<Input, { type: 'chat.send' }>,
  now: Iso,
  env: Environment,
): Decision {
  const conversation = view.conversations.get(input.conversationId)
  if (!conversation) return reject('not_found', '对话不存在: ' + input.conversationId)
  const agent = view.agents.get(conversation.agentId)
  if (!agent) return reject('not_found', '智能体不存在: ' + conversation.agentId)
  const runtime = view.runtimes.get(agent.runtimeId)
  if (!runtime) return reject('not_found', '运行时不存在: ' + agent.runtimeId)
  if (!runtime.enabled) return reject('conflict', '运行时已停用，请先在设置里启用')
  const content = input.content.trim()
  if (!content) return reject('invalid_input', '消息内容不能为空')
  // 同一对话同时只跑一轮：被拒绝时不落任何消息
  if (conversationBusy(view, conversation.id)) {
    return reject('conflict', '该对话正在执行中，请先等待或中止')
  }

  const history = messagesOf(view, conversation.id)
  const messageId = env.nextId('message')
  const runId = env.nextId('run')
  const userMessage: Message = {
    id: messageId,
    conversationId: conversation.id,
    role: 'user',
    content,
    error: null,
    createdAt: now,
  }
  // 首轮带完整历史与 systemPrompt；续接轮只发新消息（执行器用 resumeSessionId 续接）
  const prompt =
    conversation.sessionId === null ? chatPrompt(agent, [...history, userMessage]) : content
  const turn = conversationRunCount(view, conversation.id) + 1
  const facts: FactDraft[] = [
    ownerDraft(
      'message.appended',
      { conversationId: conversation.id, messageId, role: 'user', content, runId },
      now,
    ),
  ]
  // 首条消息（或标题为空）给对话命名（旧 ChatService 同口径：取首行、24 码点截断）
  if (history.length === 0 || conversation.title.trim() === '') {
    facts.push(
      ownerDraft(
        'conversation.updated',
        { conversation: { ...conversation, title: titleFromContent(content), updatedAt: now } },
        now,
      ),
    )
  }
  facts.push(
    ownerDraft(
      'run.queued',
      { run: chatRunRow(conversation, agent, runtime, view.projects, runId, prompt, turn, now) },
      now,
    ),
  )
  return done(facts)
}

export function removeConversation(
  view: View,
  input: Extract<Input, { type: 'chat.remove' }>,
  now: Iso,
): Decision {
  const conversation = view.conversations.get(input.conversationId)
  if (!conversation) return done([])
  // tombstone：消息随对话一起删除由 project 级联；历史 run 保留 conversationId 作为引用
  return done([ownerDraft('conversation.removed', { conversation }, now)])
}

export function cancelChat(
  view: View,
  input: Extract<Input, { type: 'chat.cancel' }>,
  now: Iso,
): Decision {
  // 中止该对话进行中的一轮：逐条产取消请求（与 run.cancel 同一收尾链路）
  const conversation = view.conversations.get(input.conversationId)
  if (!conversation) return reject('not_found', '对话不存在: ' + input.conversationId)
  const facts: FactDraft[] = []
  for (const run of view.runs.values()) {
    if (run.conversationId !== conversation.id) continue
    if (run.status !== 'queued' && run.status !== 'running' && run.status !== 'waiting') continue
    if (run.cancelRequested) continue
    facts.push(
      ownerDraft(
        'run.cancel_requested',
        { run: { ...run, cancelRequested: true }, by: 'owner' },
        now,
      ),
    )
  }
  return done(facts)
}

export function archiveChat(
  view: View,
  input: Extract<Input, { type: 'chat.archive' }>,
  now: Iso,
): Decision {
  const conversation = view.conversations.get(input.conversationId)
  if (!conversation) return reject('not_found', '对话不存在: ' + input.conversationId)
  const archived = input.archived ?? true
  // 幂等：状态已经一致时不产事实，重复点不会把归档时间刷新成新的
  const isArchived = (conversation.archivedAt ?? null) !== null
  if (isArchived === archived) return done([])
  return done([
    ownerDraft(
      'conversation.updated',
      { conversation: { ...conversation, archivedAt: archived ? now : null, updatedAt: now } },
      now,
    ),
  ])
}
