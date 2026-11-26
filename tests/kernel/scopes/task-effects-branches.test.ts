// @vitest-environment node
/**
 * 脚本轮的工作目录（B，`scopes/task-effects.ts#resolveScriptWorktree`）。
 *
 * 脚本读不到上游的「分支 / 工作树」，只能由内核按交付物把工作目录传下来。这里逐条构造
 * 不该采用的声明（别人的 run、没声明 worktree、空白 worktree），再看最终 cwd 落在哪一棵树。
 */
import { describe, expect, it } from 'vitest'
import type {
  Agent,
  RunDeliverables,
  RunRow,
  Runtime,
  Task,
  WorkflowStage,
} from '@workbench/protocol/entities'
import { entryRunFacts } from '@workbench/kernel/scopes/task-effects'
import type { Environment, Limits, View } from '@workbench/kernel/core/types'
import { testLimits } from '../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'
const LATER = '2026-11-24T09:00:00.000Z'
const NOW = '2026-11-24T10:00:00.000Z'

/** 限制取内核契约默认值（与生产同口径；不在这里抄数字，抄的那份会漂）。 */
const limits = (): Limits => testLimits()

const env = (): Environment => ({
  timezone: 'Asia/Shanghai',
  limits: limits(),
  nextId: (kind) => `${kind}-next`,
})

const agent = (): Agent => ({
  id: 'ag-1',
  name: '实现者',
  description: '',
  runtimeId: 'rt-1',
  systemPrompt: '',
  model: null,
  reasoningEffort: null,
  maxConcurrent: 1,
  permissionMode: 'workspace-write',
  workdir: 'C:/agent',
  env: {},
  createdAt: CREATED,
})

const runtime = (): Runtime => ({
  id: 'rt-1',
  name: '本机命令',
  executorKey: 'command',
  argsTemplate: '',
  command: 'echo',
  profile: 'default',
  enabled: true,
  createdAt: CREATED,
  lastProbe: null,
})

/** 脚本阶段：没有提示词，工作目录只能由交付物传下来。 */
const scriptStage = (): WorkflowStage => ({
  id: 'st-test',
  workflowId: 'wf-1',
  name: '跑门禁',
  position: 1,
  entryMode: 'script',
  agentId: null,
  script: { runtimeId: 'rt-1', steps: [], cwd: null, env: {}, timeoutMs: null },
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
})

const task = (): Task => ({
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
})

const deliverables = (worktree: string | null): RunDeliverables => ({
  branch: null,
  base: null,
  worktree,
  commits: [],
  files: [],
  gates: [],
})

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'run-1',
  purpose: 'stage',
  taskId: 't-1',
  stageId: 'st-fix',
  agentId: 'ag-1',
  runtimeId: 'rt-1',
  status: 'succeeded',
  prompt: '',
  output: '',
  error: null,
  errorCode: null,
  exitCode: 0,
  sessionId: null,
  usage: null,
  durationMs: null,
  startedAt: CREATED,
  endedAt: LATER,
  createdAt: CREATED,
  conversationId: null,
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
  queueSeq: 1,
  attempt: 1,
  attempts: 0,
  leaseId: null,
  leaseUntil: null,
  notBefore: null,
  deadlineAt: null,
  cancelRequested: false,
  deliverables: null,
  ...over,
})

const view = (over: Partial<View> = {}): View => ({
  seq: 5,
  workflows: new Map(),
  stages: new Map([[scriptStage().id, scriptStage()]]),
  agents: new Map([[agent().id, agent()]]),
  runtimes: new Map([[runtime().id, runtime()]]),
  projects: new Map(),
  tasks: new Map([[task().id, task()]]),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  threads: new Map(),
  taskComments: new Map(),
  reviewReports: new Map(),
  events: new Map(),
  ruleSkips: [],
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
  activeTaskIds: new Set(),
  ...over,
})

const cwdOf = (facts: ReturnType<typeof entryRunFacts>): string =>
  (facts[0]!.payload as { run: { cwd: string } }).run.cwd

describe('resolveScriptWorktree：按交付物选树', () => {
  it('别人的 run / 没声明 worktree / 空白 worktree 都不采用：取最近一条真路径', () => {
    const facts = entryRunFacts(
      view({
        runs: new Map([
          [
            'run-other',
            run({ id: 'run-other', taskId: 't-9', deliverables: deliverables('C:/other') }),
          ],
          ['run-null', run({ id: 'run-null', deliverables: null })],
          ['run-blank', run({ id: 'run-blank', deliverables: deliverables('   ') })],
          ['run-old', run({ id: 'run-old', endedAt: null, deliverables: deliverables('C:/old') })],
          [
            'run-late',
            run({ id: 'run-late', endedAt: LATER, deliverables: deliverables('C:/wt') }),
          ],
          [
            'run-early',
            run({ id: 'run-early', endedAt: CREATED, deliverables: deliverables('C:/newest') }),
          ],
        ]),
      }),
      task(),
      NOW,
      env(),
      { kind: 'kernel' },
    )
    expect(cwdOf(facts)).toBe('C:/wt')
  })

  it('一条声明都没有：退回脚本自己的 cwd（这里没配，落空串）', () => {
    const facts = entryRunFacts(view(), task(), NOW, env(), { kind: 'kernel' })
    expect(cwdOf(facts)).toBe('')
  })

  it('本批刚结算的 worktree 优先于视图里的历史声明', () => {
    const facts = entryRunFacts(
      view({
        runs: new Map([
          [
            'run-late',
            run({ id: 'run-late', endedAt: LATER, deliverables: deliverables('C:/old') }),
          ],
        ]),
      }),
      task(),
      NOW,
      env(),
      { kind: 'kernel' },
      undefined,
      { worktree: 'C:/incoming' },
    )
    expect(cwdOf(facts)).toBe('C:/incoming')
  })
})
