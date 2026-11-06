/**
 * `conversation.*` 黄金用例（T14a）：聊天并入 `purpose='chat'` 的统一执行路径。
 *
 * 覆盖：create（标题缺省/trim）、send 首轮与续接 prompt、同对话并发拒绝且不落消息、
 * 缺 agent/runtime、title 截断、turn 递增、rename/remove、聊天终态 sessionId 落回对话。
 */
import { describe, expect, it } from 'vitest'
import type { Agent, Conversation, Message, RunRow, Runtime } from '../../src/protocol/entities'
import { decide } from '../../src/kernel/decide'
import { receiptBlockHint } from '../../src/kernel/prompt'
import type { Environment, Id, IdKind, Limits, View } from '../../src/kernel/types'

const NOW = '2026-11-04T12:00:00.000Z'
const CREATED = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-02T00:00:00.000Z'
const OWNER = { kind: 'owner', via: 'ui' } as const
/** 聊天首轮提示词末尾固定追加的回执块说明（M4 D4）。 */
const HINT = receiptBlockHint()

const limits = (over: Partial<Limits> = {}): Limits => ({
  maxStagesPerWorkflow: 50,
  maxArrayLength: 500,
  maxHops: 8,
  leaseMs: 120_000,
  heartbeatMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 300_000,
  backoffCapMs: 3_600_000,
  runTimeoutMs: 1_800_000,
  cancelGraceMs: 3_000,
  killAfterMs: 2_000,
  maxFramesPerBatch: 500,
  ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '助手',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '你是助手。',
  createdAt: CREATED,
  ...over,
})

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机 dsh',
  executorKey: 'dsh',
  argsTemplate: '',
  command: 'dsh',
  profile: 'multica',
  permissionMode: 'workspace-write',
  model: null,
  reasoningEffort: null,
  workdir: 'C:/work',
  maxConcurrent: 1,
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
  ...over,
})

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'cv-1',
  title: '新对话',
  agentId: 'ag-1',
  sessionId: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const message = (over: Partial<Message> = {}): Message => ({
  id: 'ms-1',
  conversationId: 'cv-1',
  role: 'user',
  content: '早',
  error: null,
  createdAt: CREATED,
  ...over,
})

/** 聊天 run 的完整投影行（终态用例与 turn 递增用例复用）。 */
const chatRun = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'chat',
  taskId: null,
  conversationId: 'cv-1',
  stageId: null,
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'dsh',
  threadId: null,
  cwd: 'C:/work',
  access: 'edit',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 0,
  status: 'succeeded',
  prompt: 'p',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  leaseId: null,
  attempt: 1,
  attempts: 0,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  startedAt: CREATED,
  endedAt: LATER,
  createdAt: CREATED,
  ...over,
})

interface Seed {
  agents?: Agent[]
  runtimes?: Runtime[]
  conversations?: Conversation[]
  messages?: Message[]
  runs?: RunRow[]
}

const view = (seed: Seed = {}): View => ({
  seq: 7,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map((seed.agents ?? []).map((row) => [row.id, row])),
  runtimes: new Map((seed.runtimes ?? []).map((row) => [row.id, row])),
  projects: new Map(),
  tasks: new Map(),
  runs: new Map((seed.runs ?? []).map((row) => [row.id, row])),
  conversations: new Map((seed.conversations ?? []).map((row) => [row.id, row])),
  messages: new Map((seed.messages ?? []).map((row) => [row.id, row])),
  cards: new Map(),
  activeTaskIds: new Set(),
  threads: new Map(),
  taskComments: new Map(),
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
})

const env = (): Environment => {
  const counters = new Map<IdKind, number>()
  return {
    timezone: 'Asia/Shanghai',
    limits: limits(),
    nextId: (kind: IdKind): Id => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-new-${next}`
    },
  }
}

const send = (
  target: View,
  content: string,
  environment = env(),
  conversationId = 'cv-1',
): ReturnType<typeof decide> =>
  decide(
    target,
    { commandId: 'm5-chat', type: 'chat.send', conversationId, content },
    NOW,
    environment,
  )

const fullChatView = (over: Partial<Seed> = {}): View =>
  view({
    agents: [agent()],
    runtimes: [runtime()],
    conversations: [conversation()],
    ...over,
  })

describe('kernel/decide conversation.create', () => {
  it('缺省标题「新对话」；标题 trim 后落 conversation.created', () => {
    const decision = decide(
      view({ agents: [agent()] }),
      { commandId: 'm5-chat', type: 'chat.create', agentId: 'ag-1' },
      NOW,
      env(),
    )

    expect(decision).toEqual({
      facts: [
        {
          type: 'conversation.created',
          actor: OWNER,
          at: NOW,
          payload: {
            conversation: {
              id: 'conversation-new-1',
              title: '新对话',
              agentId: 'ag-1',
              sessionId: null,
              createdAt: NOW,
              updatedAt: NOW,
            },
          },
        },
      ],
    })

    const titled = decide(
      view({ agents: [agent()] }),
      { commandId: 'm5-chat', type: 'chat.create', agentId: 'ag-1', title: '  我的对话  ' },
      NOW,
      env(),
    )
    expect((titled.facts[0]?.payload as { conversation: Conversation }).conversation.title).toBe(
      '我的对话',
    )
  })

  it('智能体不存在：reject not_found', () => {
    expect(
      decide(view(), { commandId: 'm5-chat', type: 'chat.create', agentId: 'ag-404' }, NOW, env()),
    ).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '智能体不存在: ag-404' },
    })
  })
})

describe('kernel/decide conversation.send', () => {
  it('首轮：落用户消息 + 首条消息命名 + 完整 run.queued（purpose=chat）', () => {
    const decision = send(fullChatView(), '  帮我看看\n第二行  ')

    expect(decision.facts.map((fact) => fact.type)).toEqual([
      'message.appended',
      'conversation.updated',
      'run.queued',
    ])
    expect(decision.facts[0]?.payload).toEqual({
      conversationId: 'cv-1',
      messageId: 'message-new-1',
      role: 'user',
      content: '帮我看看\n第二行',
      runId: 'run-new-1',
    })
    expect(decision.facts[1]?.payload).toEqual({
      conversation: {
        ...conversation(),
        title: '帮我看看',
        updatedAt: NOW,
      },
    })
    expect((decision.facts[2]?.payload as { run: RunRow }).run).toEqual({
      id: 'run-new-1',
      purpose: 'chat',
      taskId: null,
      conversationId: 'cv-1',
      stageId: null,
      agentId: 'ag-1',
      runtimeId: 'rt-1',
      ruleId: null,
      rulesVersion: 0,
      executorKey: 'dsh',
      threadId: null,
      cwd: 'C:/work',
      access: 'edit',
      skill: null,
      promptRef: null,
      eventIds: [],
      hops: 0,
      turn: 1,
      resumeSessionId: null,
      threadContextRef: null,
      queueSeq: 0,
      status: 'queued',
      prompt: `你是助手。\n\n# 对话记录\n\n用户：帮我看看\n第二行\n\n请回答最后一条用户消息。\n\n${HINT}`,
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
      createdAt: NOW,
    })
  })

  it('首轮带历史时 prompt 含完整对话记录（用户/助手逐行）', () => {
    const decision = send(
      fullChatView({
        messages: [
          message({ id: 'ms-1', role: 'user', content: '早', createdAt: CREATED }),
          message({ id: 'ms-2', role: 'assistant', content: '早呀', createdAt: LATER }),
        ],
      }),
      '继续',
    )

    expect((decision.facts[1]?.payload as { run: RunRow }).run.prompt).toBe(
      `你是助手。\n\n# 对话记录\n\n用户：早\n助手：早呀\n用户：继续\n\n请回答最后一条用户消息。\n\n${HINT}`,
    )
  })

  it('历史排序：只取本对话消息，同 createdAt 按 id 兜底', () => {
    const decision = send(
      fullChatView({
        messages: [
          message({ id: 'ms-b', content: '后', createdAt: CREATED }),
          message({ id: 'ms-a', content: '先', createdAt: CREATED }),
          message({ id: 'ms-x', conversationId: 'cv-2', content: '别的对话', createdAt: CREATED }),
        ],
      }),
      '继续',
    )

    expect((decision.facts[1]?.payload as { run: RunRow }).run.prompt).toContain(
      '用户：先\n用户：后\n用户：继续',
    )
    expect((decision.facts[1]?.payload as { run: RunRow }).run.prompt).not.toContain('别的对话')
  })

  it('续接轮：prompt 只发新消息，resumeSessionId 取对话会话，turn = 已有 run 数 + 1', () => {
    const decision = send(
      fullChatView({
        conversations: [conversation({ sessionId: 'sess-old' })],
        messages: [
          message({ id: 'ms-1', role: 'user', content: '早', createdAt: CREATED }),
          message({ id: 'ms-2', role: 'assistant', content: '早呀', createdAt: LATER }),
        ],
        runs: [
          chatRun({ id: 'run-0', turn: 1, status: 'succeeded' }),
          chatRun({ id: 'run-0b', turn: 2, status: 'failed', createdAt: LATER }),
          // 别的对话的 run 不参与本对话的 turn 计数
          chatRun({ id: 'run-foreign', conversationId: 'cv-2' }),
        ],
      }),
      '继续',
    )

    // 续接轮不重命名（已有历史）
    expect(decision.facts.map((fact) => fact.type)).toEqual(['message.appended', 'run.queued'])
    expect((decision.facts[1]?.payload as { run: RunRow }).run).toMatchObject({
      prompt: '继续',
      resumeSessionId: 'sess-old',
      turn: 3,
    })
  })

  it('同对话已有 queued/running/waiting run：拒绝且不落消息（无关对话的 run 不算）', () => {
    for (const status of ['queued', 'running', 'waiting'] as const) {
      const decision = send(
        fullChatView({
          runs: [
            chatRun({ id: 'run-other', conversationId: 'cv-2', status: 'succeeded' }),
            chatRun({ status, conversationId: 'cv-1' }),
          ],
        }),
        '再来一轮',
      )

      expect(decision).toEqual({
        facts: [],
        reject: { code: 'conflict', message: '该对话正在执行中，请先等待或中止' },
      })
    }
  })

  it('终态 run 不占「执行中」：可以继续发下一轮', () => {
    const decision = send(fullChatView({ runs: [chatRun({ status: 'succeeded' })] }), '下一轮')

    expect(decision.reject).toBeUndefined()
    expect(decision.facts.map((fact) => fact.type)).toEqual([
      'message.appended',
      'conversation.updated',
      'run.queued',
    ])
  })

  it('缺对话 / 智能体 / 运行时、运行时停用、空内容：拒绝且零事实', () => {
    expect(send(fullChatView(), 'hi', env(), 'cv-404')).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '对话不存在: cv-404' },
    })
    expect(send(fullChatView({ agents: [] }), 'hi')).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '智能体不存在: ag-1' },
    })
    expect(send(fullChatView({ runtimes: [] }), 'hi')).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '运行时不存在: rt-1' },
    })
    expect(send(fullChatView({ runtimes: [runtime({ enabled: false })] }), 'hi')).toEqual({
      facts: [],
      reject: { code: 'conflict', message: '运行时已停用，请先在设置里启用' },
    })
    expect(send(fullChatView(), '   ')).toEqual({
      facts: [],
      reject: { code: 'invalid_input', message: '消息内容不能为空' },
    })
  })

  it('首条消息标题：取首行、24 码点截断加省略号（emoji 不切代理对）', () => {
    const long = '😀'.repeat(25)
    const decision = send(fullChatView(), `${long}\n第二行`)

    expect((decision.facts[1]?.payload as { conversation: Conversation }).conversation.title).toBe(
      '😀'.repeat(24) + '…',
    )
  })

  it('标题为空（存量/导入对话）且有历史：发送时按首行补标题', () => {
    const decision = send(
      fullChatView({
        conversations: [conversation({ title: '', sessionId: 'sess-old' })],
        messages: [message({ id: 'ms-1', role: 'user', content: '早', createdAt: CREATED })],
      }),
      '补个标题',
    )

    expect(decision.facts.map((fact) => fact.type)).toEqual([
      'message.appended',
      'conversation.updated',
      'run.queued',
    ])
    expect((decision.facts[1]?.payload as { conversation: Conversation }).conversation.title).toBe(
      '补个标题',
    )
  })
})

describe('kernel/decide chat.cancel / remove', () => {
  it('cancel：对该对话的 queued/running/waiting run 逐条产 run.cancel_requested', () => {
    const runs = [
      chatRun({ id: 'run-1', status: 'queued' }),
      chatRun({ id: 'run-2', status: 'running' }),
      chatRun({ id: 'run-3', status: 'waiting' }),
      chatRun({ id: 'run-4', status: 'succeeded' }),
      chatRun({ id: 'run-5', conversationId: 'cv-404', status: 'running' }),
    ]
    const decision = decide(
      view({ conversations: [conversation()], runs }),
      { commandId: 'm5-chat', type: 'chat.cancel', conversationId: 'cv-1' },
      NOW,
      env(),
    )
    expect(decision.reject).toBeUndefined()
    expect(decision.facts.map((fact) => fact.type)).toEqual([
      'run.cancel_requested',
      'run.cancel_requested',
      'run.cancel_requested',
    ])
    expect(decision.facts.map((fact) => (fact.payload as { run: RunRow }).run.id)).toEqual([
      'run-1',
      'run-2',
      'run-3',
    ])
    expect((decision.facts[0]?.payload as { run: RunRow }).run.cancelRequested).toBe(true)
  })

  it('cancel：已请求取消的跳过、无活跃 run 零事实', () => {
    const requested = chatRun({ id: 'run-1', status: 'running', cancelRequested: true })
    expect(
      decide(
        view({ conversations: [conversation()], runs: [requested] }),
        { commandId: 'm5-chat', type: 'chat.cancel', conversationId: 'cv-1' },
        NOW,
        env(),
      ),
    ).toEqual({ facts: [] })
    expect(
      decide(
        view({ conversations: [conversation()] }),
        { commandId: 'm5-chat', type: 'chat.cancel', conversationId: 'cv-1' },
        NOW,
        env(),
      ),
    ).toEqual({ facts: [] })
  })

  it('cancel：对话不存在 → reject', () => {
    expect(
      decide(
        view(),
        { commandId: 'm5-chat', type: 'chat.cancel', conversationId: 'cv-404' },
        NOW,
        env(),
      ),
    ).toEqual({ facts: [], reject: { code: 'not_found', message: '对话不存在: cv-404' } })
  })

  it('remove：产 tombstone conversation.removed；不存在静默', () => {
    expect(
      decide(
        view({ conversations: [conversation()] }),
        { commandId: 'm5-chat', type: 'chat.remove', conversationId: 'cv-1' },
        NOW,
        env(),
      ),
    ).toEqual({
      facts: [
        {
          type: 'conversation.removed',
          actor: OWNER,
          at: NOW,
          payload: { conversation: conversation() },
        },
      ],
    })

    expect(
      decide(
        view(),
        { commandId: 'm5-chat', type: 'chat.remove', conversationId: 'cv-404' },
        NOW,
        env(),
      ),
    ).toEqual({ facts: [] })
  })
})

describe('kernel/decide conversation.archive', () => {
  const archive = (
    target: View,
    conversationId = 'cv-1',
    archived?: boolean,
  ): ReturnType<typeof decide> =>
    decide(
      target,
      {
        commandId: 'm9-archive',
        type: 'chat.archive',
        conversationId,
        ...(archived === undefined ? {} : { archived }),
      },
      NOW,
      env(),
    )

  it('归档：只改 archivedAt / updatedAt，不产消息事实', () => {
    expect(archive(fullChatView())).toEqual({
      facts: [
        {
          type: 'conversation.updated',
          actor: OWNER,
          at: NOW,
          payload: { conversation: { ...conversation(), archivedAt: NOW, updatedAt: NOW } },
        },
      ],
    })
  })

  it('恢复：archived=false 清空 archivedAt', () => {
    const decision = archive(fullChatView({ conversations: [conversation({ archivedAt: LATER })] }), 'cv-1', false)
    expect(decision.facts).toHaveLength(1)
    expect((decision.facts[0]?.payload as { conversation: Conversation }).conversation).toEqual({
      ...conversation(),
      archivedAt: null,
      updatedAt: NOW,
    })
  })

  it('幂等：状态已经一致时零事实', () => {
    expect(
      archive(fullChatView({ conversations: [conversation({ archivedAt: LATER })] })).facts,
    ).toEqual([])
    expect(archive(fullChatView(), 'cv-1', false).facts).toEqual([])
  })

  it('对话不存在 → reject not_found', () => {
    expect(archive(fullChatView({ conversations: [] }), 'cv-404')).toEqual({
      facts: [],
      reject: { code: 'not_found', message: '对话不存在: cv-404' },
    })
  })
})

describe('kernel/decide 聊天 run 终态', () => {
  it('成功终态：assistant 消息 + 会话 id 落回对话', () => {
    const running = chatRun({
      status: 'running',
      leaseId: 'run-1:1',
      attempt: 1,
      sessionId: null,
    })
    const decision = decide(
      view({ runs: [running], conversations: [conversation({ sessionId: null })] }),
      {
        type: 'run.receipt',
        runId: 'run-1',
        receipt: {
          status: 'succeeded',
          leaseId: 'run-1:1',
          turn: 1,
          output: '好的',
          sessionId: 'sess-new',
        },
      },
      NOW,
      env(),
    )

    expect(decision.facts.map((fact) => fact.type)).toEqual([
      'run.succeeded',
      'message.appended',
      'conversation.updated',
    ])
    expect(decision.facts[1]?.payload).toEqual({
      conversationId: 'cv-1',
      messageId: 'message-new-1',
      role: 'assistant',
      content: '好的',
      runId: 'run-1',
      error: null,
    })
    expect(decision.facts[2]?.payload).toEqual({
      conversation: {
        ...conversation(),
        sessionId: 'sess-new',
        updatedAt: NOW,
      },
    })
  })

  it('失败终态：message.error 用回执文案；无 sessionId 不改对话', () => {
    const running = chatRun({ status: 'running', leaseId: 'run-1:1', attempt: 1 })
    const decision = decide(
      view({ runs: [running], conversations: [conversation()] }),
      {
        type: 'run.receipt',
        runId: 'run-1',
        receipt: {
          status: 'failed',
          leaseId: 'run-1:1',
          turn: 1,
          error: '进程崩溃',
        },
      },
      NOW,
      env(),
    )

    expect(decision.facts.map((fact) => fact.type)).toEqual(['run.failed', 'message.appended'])
    expect((decision.facts[1]?.payload as { error: string }).error).toBe('进程崩溃')
  })
})
