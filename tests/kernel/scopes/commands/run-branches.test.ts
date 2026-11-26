// @vitest-environment node
/**
 * 运行命令（`scopes/commands/run.ts`）的几条边界：脚本闸门的失败输出回流、拿不到退出码时
 * 的「没给结论」留痕、出口 `close` 原地结束、无主 run（研判）的领取、以及宿主给聊天 run 兜底。
 *
 * 纯函数 + 显式 `now` / id：不读时钟、不查库，事实即断言对象。
 */
import { describe, expect, it } from 'vitest'
import type {
  Agent,
  Conversation,
  RunRow,
  Runtime,
  StageScript,
  Task,
  Workflow,
  WorkflowStage,
} from '@workbench/protocol/entities'
import type { Authority, Mandate } from '@workbench/protocol/authority'
import type { Input, Receipt } from '@workbench/protocol/inputs'
import { claimRun, receiveRun, settleRunByHost } from '@workbench/kernel/scopes/commands/run'
import type { TaskComment } from '@workbench/protocol/task-comment'
import { TEST_AT, emptyView, testEnv } from '../../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'

const workflow = (): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: '',
  createdAt: CREATED,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-fix',
  workflowId: 'wf-1',
  name: '修复',
  position: 0,
  entryMode: 'agent',
  agentId: 'ag-1',
  script: null,
  exits: {},
  handoffs: [],
  subtaskStageId: null,
  onChildrenSettled: null,
  spawnPolicy: null,
  instructions: '',
  acceptance: [],
  runTimeoutMs: null,
  judge: null,
  builtin: null,
  ...over,
})

const scriptConfig = (over: Partial<StageScript> = {}): StageScript => ({
  runtimeId: 'rt-1',
  steps: [],
  cwd: null,
  env: {},
  timeoutMs: null,
  ...over,
})

const task = (over: Partial<Task> = {}): Task => ({
  id: 't-1',
  title: '任务',
  description: '',
  workflowId: 'wf-1',
  projectId: null,
  currentStageId: 'st-test',
  archivedAt: null,
  origin: 'manual',
  ruleId: null,
  externalRef: null,
  labels: [],
  threadId: null,
  parentTaskId: null,
  handoffFromTaskId: null,
  handoffFromStageId: null,
  handoffFromRunId: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...over,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '',
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: null,
  env: {},
  createdAt: CREATED,
  ...over,
})

const runtime = (over: Partial<Runtime> = {}): Runtime => ({
  id: 'rt-1',
  name: '本机命令',
  executorKey: 'command',
  argsTemplate: '',
  command: 'echo',
  profile: 'default',
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
  ...over,
})

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-test',
  agentId: null,
  runtimeId: 'rt-1',
  status: 'running',
  prompt: '',
  output: '',
  error: null,
  errorCode: null,
  exitCode: null,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: CREATED,
  endedAt: null,
  createdAt: CREATED,
  conversationId: null,
  ruleId: null,
  rulesVersion: 0,
  executorKey: 'command',
  threadId: null,
  cwd: 'C:/work',
  access: 'full',
  skill: null,
  promptRef: null,
  eventIds: [],
  hops: 0,
  turn: 1,
  resumeSessionId: null,
  threadContextRef: null,
  queueSeq: 1,
  attempt: 1,
  attempts: 0,
  leaseId: 'lease-1',
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  deliverables: null,
  script: scriptConfig(),
  ...over,
})

const receipt = (over: Record<string, unknown> = {}): Receipt =>
  ({
    status: 'succeeded',
    leaseId: 'lease-1',
    turn: 1,
    output: '完成',
    ...over,
  }) as unknown as Receipt

const receive = (view: ReturnType<typeof emptyView>, row: Receipt) =>
  receiveRun(
    view,
    { type: 'run.receipt', runId: 'run-1', receipt: row } as unknown as Extract<
      Input,
      { type: 'run.receipt' }
    >,
    TEST_AT,
    testEnv(),
  )

const commentsOf = (facts: Array<{ type: string; payload: unknown }>): string[] =>
  facts
    .filter((fact) => fact.type === 'task.comment_added')
    .map((fact) => (fact.payload as { comment: TaskComment }).comment.text)

/** 脚本闸门工作流：跑门禁（脚本 + 判定）→ 未通过打回修复。 */
const scriptGateView = (over: Parameters<typeof emptyView>[0] = {}) =>
  emptyView({
    workflows: new Map([['wf-1', workflow()]]),
    stages: new Map([
      [
        'st-test',
        stage({
          id: 'st-test',
          name: '跑门禁',
          entryMode: 'script',
          judge: { maxFails: null },
          script: scriptConfig(),
          exits: { failed: { do: 'goto', stageId: 'st-fix' } },
        }),
      ],
      ['st-fix', stage()],
    ]),
    tasks: new Map([['t-1', task()]]),
    runs: new Map([['run-1', run()]]),
    ...over,
  })

describe('receiveRun：脚本闸门失败回流', () => {
  it('失败输出超过上限：截尾回流，评论里带省略标记', () => {
    const decision = receive(
      scriptGateView(),
      receipt({
        status: 'failed',
        errorCode: 'exit_nonzero',
        exitCode: 7,
        output: `${'日志行\n'.repeat(600)}最后一行：断言失败`,
      }),
    )
    const [text] = commentsOf(decision.facts)
    expect(text).toContain('闸门「跑门禁」未通过（退出码 7）')
    expect(text).toContain('…（前文略）')
    expect(text).toContain('最后一行：断言失败')
    expect(decision.facts.some((fact) => fact.type === 'task.moved')).toBe(true)
  })

  it('拿不到退出码：不推进阶段，留一句「没拿到退出码」的说明', () => {
    const decision = receive(
      scriptGateView(),
      receipt({ status: 'succeeded', output: '跑完了但没报退出码' }),
    )
    const [text] = commentsOf(decision.facts)
    expect(text).toContain('这一轮没拿到退出码（原因未知）')
    expect(decision.facts.some((fact) => fact.type === 'task.moved')).toBe(false)
  })
})

describe('receiveRun：出口 close 原地结束', () => {
  it('没有下一阶段可去：任务完成并归档，不留「移动」事实', () => {
    const decision = receive(
      emptyView({
        workflows: new Map([['wf-1', workflow()]]),
        stages: new Map([['st-only', stage({ id: 'st-only', name: '收尾', agentId: 'ag-1' })]]),
        tasks: new Map([['t-1', task({ currentStageId: 'st-only' })]]),
        runs: new Map([['run-1', run({ stageId: 'st-only', agentId: 'ag-1', script: null })]]),
      }),
      receipt(),
    )
    const finished = decision.facts.find((fact) => fact.type === 'task.finished')
    expect((finished?.payload as { outcome: string }).outcome).toBe('done')
    expect(decision.facts.some((fact) => fact.type === 'task.archived')).toBe(true)
    expect(decision.facts.some((fact) => fact.type === 'task.moved')).toBe(false)
  })
})

describe('claimRun：无主 run 与兼容模式的授权检查', () => {
  const claimView = (over: Parameters<typeof emptyView>[0] = {}) =>
    emptyView({
      runtimes: new Map([['rt-1', runtime()]]),
      agents: new Map([['ag-1', agent()]]),
      ...over,
    })

  const claim = (view: ReturnType<typeof claimView>) =>
    claimRun(
      view,
      { type: 'run.claim', runtimeId: 'rt-1', capacity: 1 } as unknown as Extract<
        Input,
        { type: 'run.claim' }
      >,
      TEST_AT,
      testEnv(),
    )

  it('研判 run（没挂任务）：照常领取（它不凭任务授权）', () => {
    const decision = claim(
      claimView({
        runs: new Map([
          [
            'run-assess',
            run({
              id: 'run-assess',
              purpose: 'assess',
              taskId: null,
              stageId: null,
              status: 'queued',
              leaseId: null,
              script: null,
            }),
          ],
        ]),
      }),
    )
    const claimed = decision.facts.find((fact) => fact.type === 'run.claimed')
    expect((claimed?.payload as { run: RunRow }).run.id).toBe('run-assess')
  })

  it('兼容模式（视图没有 authority 块）：有授权且未撤销的任务照常在名单里领取', () => {
    const mandate: Mandate = {
      id: 'mandate-1',
      taskId: 't-1',
      scope: {
        workflowId: 'wf-1',
        stageId: 'st-test',
        projectId: null,
        access: 'edit',
        maxRuns: null,
        maxTokens: null,
        expiresAt: null,
      },
      strength: 'explicit',
      basis: 'manual',
      policyVersion: 1,
      ruleIds: [],
      by: { kind: 'manual', via: 'ui' },
      grantedAt: CREATED,
      revokedAt: null,
      revokedReason: null,
      legacy: true,
    }
    const decision = claim(
      claimView({
        authority: undefined as Authority | null | undefined,
        mandates: new Map([['t-1', mandate]]),
        runs: new Map([['run-1', run({ status: 'queued', leaseId: null, script: null })]]),
      }),
    )
    expect(decision.facts.some((fact) => fact.type === 'run.claimed')).toBe(true)
    expect(decision.facts.some((fact) => fact.type === 'mandate.revoked')).toBe(false)
  })
})

describe('settleRunByHost：聊天 run 兜底落终态', () => {
  it('宿主取消：落 run.cancelled 并补一条 assistant 消息', () => {
    const conversation: Conversation = {
      id: 'conv-1',
      title: '聊一句',
      agentId: 'ag-1',
      projectId: null,
      sessionId: null,
      archivedAt: null,
      createdAt: CREATED,
      updatedAt: CREATED,
    }
    const decision = settleRunByHost(
      emptyView({
        conversations: new Map([['conv-1', conversation]]),
        runs: new Map([
          [
            'run-1',
            run({
              purpose: 'chat',
              taskId: null,
              stageId: null,
              conversationId: 'conv-1',
              script: null,
              status: 'running',
            }),
          ],
        ]),
      }),
      {
        type: 'run.host_settled',
        runId: 'run-1',
        status: 'cancelled',
        leaseId: 'lease-1',
        turn: 1,
      } as unknown as Extract<Input, { type: 'run.host_settled' }>,
      TEST_AT,
      testEnv(),
    )
    expect(decision.facts.some((fact) => fact.type === 'run.cancelled')).toBe(true)
    const message = decision.facts.find((fact) => fact.type === 'message.appended')
    expect((message?.payload as { role: string }).role).toBe('assistant')
  })
})

describe('receiveRun：阶段行缺 id（脏投影）', () => {
  /**
   * 老库里的阶段行 `id` 为空时，任务行也停在 `currentStageId = null`：
   * 流转照常按出口 `close` 收口，但「下一个阶段」无从查起——不猜、也不拿 null 去查表。
   */
  it('currentStageId 为 null：不解析目标阶段，按出口 close 直接完成并归档', () => {
    const decision = receive(
      emptyView({
        workflows: new Map([['wf-1', workflow()]]),
        stages: new Map([['st-dirty', stage({ id: null as unknown as string, name: '脏行' })]]),
        tasks: new Map([['t-1', task({ currentStageId: null as unknown as string })]]),
        runs: new Map([['run-1', run({ stageId: null, script: null })]]),
      }),
      receipt(),
    )
    const finished = decision.facts.find((fact) => fact.type === 'task.finished')
    expect((finished?.payload as { outcome: string }).outcome).toBe('done')
    expect(decision.facts.some((fact) => fact.type === 'task.archived')).toBe(true)
    expect(decision.facts.some((fact) => fact.type === 'task.moved')).toBe(false)
  })
})

describe('receiveRun：老 run 行没有 script 列', () => {
  /**
   * M40 之前的 run 行没有 `script` 列（`undefined`）。闸门判定因此走「回执给结论」那一侧，
   * 但失败回流仍要能写：退出码拿不到时文案不能空着。
   */
  it('判 fail 且没有退出码：评论里退出码写「未知」，失败输出照样回流', () => {
    const decision = receive(
      emptyView({
        workflows: new Map([['wf-1', workflow()]]),
        stages: new Map([
          [
            'st-test',
            stage({
              id: 'st-test',
              name: '跑门禁',
              position: 0,
              judge: { maxFails: null },
              exits: { failed: { do: 'goto', stageId: 'st-fix' } },
            }),
          ],
          ['st-fix', stage({ position: 1 })],
        ]),
        tasks: new Map([['t-1', task()]]),
        runs: new Map([['run-1', run({ script: undefined as unknown as null })]]),
      }),
      receipt({ verdict: 'fail', output: 'RUN src/a.test.ts\n  ✕ adds' }),
    )
    const [text] = commentsOf(decision.facts)
    expect(text).toContain('闸门「跑门禁」未通过（退出码 未知）')
    expect(text).toContain('失败输出末尾')
    expect(text).toContain('✕ adds')
  })
})
