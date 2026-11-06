/**
 * store 测试夹具：内存 SQLite（v2 全量 schema + 账本表）、十四张投影表的样例行、投影快照。
 *
 * 只被 `src/host/store/*.test.ts` import，不参与运行时装配；测试注入确定性 now / newId，
 * 因此断言可以逐列全等，不依赖时钟与随机数。
 */
import { DatabaseSync } from 'node:sqlite'
import type {
  Agent,
  Card,
  Conversation,
  Message,
  Project,
  RunEventRow,
  RunRow,
  Runtime,
  RuntimeProbe,
  Task,
  Workflow,
  WorkflowStage,
} from '../../../src/protocol/entities'
import type { ThreadRow } from '../../../src/protocol/thread'
import { COMMANDS_SQL, FACTS_SQL, SCHEMA_SQL } from '../../../src/host/schema'

export const SAMPLE_AT = '2026-01-01T00:00:00.000Z'

/** 内存库：建 v2 全部表 + facts / projection_meta（与 openDatabase 之后的库结构一致）。 */
export function createMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  db.exec(FACTS_SQL)
  db.exec(COMMANDS_SQL)
  return db
}

/** 确定性 id 生成器：按给定顺序发 id。 */
export function sequenceIds(...ids: string[]): () => string {
  let index = 0
  return () => {
    const id = ids[index]
    index += 1
    return id
  }
}

/** 捕获同步调用的错误，供断言 `StoreError.code`（不吞错：没抛就失败）。 */
export function captureError(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('预期抛错，但调用没有抛错')
}

export const sampleProbe: RuntimeProbe = {
  state: 'ready',
  path: 'C:\\tools\\dsh.exe',
  cliVersion: '1.2.3',
  protocolVersion: 2,
  pluginVersion: '0.1.0',
  error: null,
  output: 'ok',
  elapsedMs: 12,
  checkedAt: SAMPLE_AT,
}

export const sample = {
  runtime(overrides: Partial<Runtime> = {}): Runtime {
    return {
      id: 'rt-1',
      name: '本机 dsh',
      executorKey: 'dsh',
      argsTemplate: '',
      command: 'dsh',
      profile: 'multica',
      permissionMode: 'workspace-write',
      model: null,
      reasoningEffort: null,
      workdir: null,
      maxConcurrent: 1,
      enabled: true,
      createdAt: SAMPLE_AT,
      lastProbe: null,
      ...overrides,
    }
  },
  agent(overrides: Partial<Agent> = {}): Agent {
    return {
      id: 'ag-1',
      name: '实现者',
      description: '',
      runtimeId: 'rt-1',
      systemPrompt: '',
      createdAt: SAMPLE_AT,
      ...overrides,
    }
  },
  workflow(overrides: Partial<Workflow> = {}): Workflow {
    return {
      id: 'wf-1',
      name: '默认流程',
      description: '',
      createdAt: SAMPLE_AT,
      ...overrides,
    }
  },
  /** M10：项目样例行（任务的容器与执行工作目录） */
  project(overrides: Partial<Project> = {}): Project {
    return {
      id: 'pj-1',
      name: '工作台',
      path: 'D:/work',
      description: '',
      createdAt: SAMPLE_AT,
      updatedAt: SAMPLE_AT,
      ...overrides,
    }
  },
  stage(overrides: Partial<WorkflowStage> = {}): WorkflowStage {
    return {
      id: 'st-1',
      workflowId: 'wf-1',
      name: '待办',
      position: 0,
      entryMode: 'none',
      agentId: null,
      onCompleteStageId: null,
      onRejectStageId: null,
      handoffWorkflowId: null,
      handoffStageId: null,
      subtaskStageId: null,
      onChildrenSettled: null,
      spawnPolicy: null,
      instructions: '',
      ...overrides,
    }
  },
  task(overrides: Partial<Task> = {}): Task {
    return {
      id: 'tk-1',
      title: '任务',
      description: '',
      workflowId: 'wf-1',
      projectId: null,
      currentStageId: 'st-1',
      status: 'active',
      origin: 'manual',
      ruleId: null,
      externalRef: null,
      labels: [],
      threadId: null,
      parentTaskId: null,
      spawnedByRunId: null,
      batchNo: null,
      spawnKey: null,
      handoffFromTaskId: null,
      handoffFromStageId: null,
      createdAt: SAMPLE_AT,
      updatedAt: SAMPLE_AT,
      ...overrides,
    }
  },
  run(overrides: Partial<RunRow> = {}): RunRow {
    return {
      id: 'run-1',
      purpose: 'stage',
      taskId: 'tk-1',
      stageId: 'st-1',
      agentId: 'ag-1',
      runtimeId: 'rt-1',
      status: 'queued',
      ruleId: null,
      rulesVersion: 0,
      executorKey: 'dsh',
      threadId: null,
      cwd: 'D:/work',
      access: 'edit',
      skill: null,
      promptRef: null,
      eventIds: [],
      hops: 0,
      turn: 1,
      resumeSessionId: null,
      threadContextRef: null,
      queueSeq: 1,
      prompt: '做点什么',
      output: '',
      error: null,
      errorCode: null,
      exitCode: null,
      sessionId: null,
      usage: null,
      durationMs: null,
      startedAt: null,
      endedAt: null,
      createdAt: SAMPLE_AT,
      conversationId: null,
      leaseId: null,
      attempt: 0,
      attempts: 0,
      leaseUntil: null,
      notBefore: null,
      deadlineAt: null,
      cancelRequested: false,
      ...overrides,
    }
  },
  runEvent(overrides: Partial<RunEventRow> = {}): RunEventRow {
    return {
      runId: 'run-1',
      seq: 1,
      type: 'text',
      text: 'hi',
      ...overrides,
    }
  },
  conversation(overrides: Partial<Conversation> = {}): Conversation {
    return {
      id: 'cv-1',
      title: '新对话',
      agentId: 'ag-1',
      sessionId: null,
      archivedAt: null,
      createdAt: SAMPLE_AT,
      updatedAt: SAMPLE_AT,
      ...overrides,
    }
  },
  message(overrides: Partial<Message> = {}): Message {
    return {
      id: 'ms-1',
      conversationId: 'cv-1',
      role: 'user',
      content: '你好',
      error: null,
      createdAt: SAMPLE_AT,
      ...overrides,
    }
  },
  card(overrides: Partial<Card> = {}): Card {
    return {
      id: 'card-1',
      runId: 'run-1',
      taskId: 'tk-1',
      conversationId: null,
      title: '选一个',
      text: '做哪个？',
      options: ['甲', '乙'],
      key: null,
      version: 1,
      status: 'open',
      delivery: 'pending',
      deliveryRef: null,
      optionIndex: null,
      answeredBy: null,
      answeredAt: null,
      createdAt: SAMPLE_AT,
      updatedAt: SAMPLE_AT,
      ...overrides,
    }
  },
  thread(overrides: Partial<ThreadRow> = {}): ThreadRow {
    return {
      id: 'th-1',
      source: 'github',
      externalRef: 'issue-1',
      title: 'Issue 一号',
      status: 'open',
      taskIds: [],
      rootTaskIds: [],
      concurrency: 1,
      notesVersion: 0,
      notes: [],
      events: [],
      lastActivityAt: SAMPLE_AT,
      createdAt: SAMPLE_AT,
      ...overrides,
    }
  },
}

/** 十四表列清单（与 `projection-apply` 的写列一一对应）与快照排序键；快照只取这些列。 */
const PROJECTION_COLUMNS: Record<string, { columns: readonly string[]; orderBy: string }> = {
  tasks: {
    columns: [
      'id',
      'title',
      'description',
      'workflow_id',
      'current_stage_id',
      'status',
      'origin',
      'rule_id',
      'external_ref',
      'labels_json',
      'thread_id',
      'parent_task_id',
      'project_id',
      'created_at',
      'updated_at',
    ],
    orderBy: 'id',
  },
  projects: {
    columns: ['id', 'name', 'path', 'description', 'created_at', 'updated_at'],
    orderBy: 'id',
  },
  workflows: { columns: ['id', 'name', 'description', 'created_at'], orderBy: 'id' },
  workflow_stages: {
    columns: [
      'id',
      'workflow_id',
      'name',
      'position',
      'entry_mode',
      'agent_id',
      'on_complete_stage_id',
      'on_reject_stage_id',
      'created_at',
    ],
    orderBy: 'id',
  },
  agents: {
    columns: ['id', 'name', 'description', 'runtime_id', 'system_prompt', 'created_at'],
    orderBy: 'id',
  },
  runtimes: {
    columns: [
      'id',
      'name',
      'executor_key',
      'command',
      'profile',
      'args_template',
      'permission_mode',
      'model',
      'reasoning_effort',
      'workdir',
      'max_concurrent',
      'enabled',
      'last_probe_json',
      'created_at',
    ],
    orderBy: 'id',
  },
  runs: {
    columns: [
      'id',
      'purpose',
      'task_id',
      'stage_id',
      'agent_id',
      'runtime_id',
      'conversation_id',
      'rule_id',
      'rules_version',
      'executor_key',
      'thread_id',
      'cwd',
      'access',
      'skill',
      'prompt_ref',
      'event_ids_json',
      'hops',
      'turn',
      'resume_session_id',
      'thread_context_ref',
      'queue_seq',
      'status',
      'prompt',
      'output',
      'error',
      'error_code',
      'exit_code',
      'session_id',
      'usage_json',
      'duration_ms',
      'lease_id',
      'attempt',
      'attempts',
      'lease_until',
      'not_before',
      'deadline_at',
      'cancel_requested',
      'started_at',
      'ended_at',
      'created_at',
    ],
    orderBy: 'id',
  },
  run_events: {
    columns: ['run_id', 'seq', 'type', 'payload_json', 'created_at'],
    orderBy: 'run_id, seq',
  },
  conversations: {
    columns: ['id', 'title', 'agent_id', 'session_id', 'created_at', 'updated_at'],
    orderBy: 'id',
  },
  messages: {
    columns: ['id', 'conversation_id', 'role', 'content', 'error', 'created_at'],
    orderBy: 'id',
  },
  cards: {
    columns: [
      'id',
      'run_id',
      'task_id',
      'conversation_id',
      'title',
      'text',
      'options_json',
      'key',
      'version',
      'status',
      'delivery',
      'delivery_ref',
      'option_index',
      'answered_by',
      'answered_at',
      'created_at',
      'updated_at',
    ],
    orderBy: 'id',
  },
  rule_sets: {
    columns: ['id', 'version', 'replaced_at', 'rules_json'],
    orderBy: 'id',
  },
  rule_fires: {
    columns: ['id', 'rule_id', 'version', 'scheduled_for', 'fired_at', 'task_id'],
    orderBy: 'id',
  },
  threads: {
    columns: [
      'id',
      'source',
      'external_ref',
      'title',
      'status',
      'task_ids_json',
      'root_task_ids_json',
      'concurrency',
      'notes_version',
      'notes_json',
      'events_json',
      'last_activity_at',
      'created_at',
    ],
    orderBy: 'id',
  },
  plugin_settings: {
    columns: ['id', 'version', 'replaced_at', 'settings_json'],
    orderBy: 'id',
  },
}

/** 十四表逐行快照（列固定、按表内排序键），用于「增量 vs 重建」逐表全等比较。 */
export function dumpProjection(db: DatabaseSync): Record<string, unknown[]> {
  const snapshot: Record<string, unknown[]> = {}
  for (const [table, spec] of Object.entries(PROJECTION_COLUMNS)) {
    snapshot[table] = db
      .prepare(`SELECT ${spec.columns.join(', ')} FROM ${table} ORDER BY ${spec.orderBy}`)
      .all() as unknown as unknown[]
  }
  return snapshot
}

export function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number }
  return row.n
}
