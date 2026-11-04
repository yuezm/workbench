/**
 * store 测试夹具：内存 SQLite（v2 全量 schema + 账本表）、五表样例行、投影快照。
 *
 * 只被 `src/host/store/*.test.ts` import，不参与运行时装配；测试注入确定性 now / newId，
 * 因此断言可以逐列全等，不依赖时钟与随机数。
 */
import { DatabaseSync } from 'node:sqlite'
import type {
  Agent,
  Runtime,
  RuntimeProbe,
  Task,
  Workflow,
  WorkflowStage,
} from '../../../src/protocol/entities'
import { FACTS_SQL, SCHEMA_SQL } from '../../../src/host/schema'

export const SAMPLE_AT = '2026-01-01T00:00:00.000Z'

/** 内存库：建 v2 全部表 + facts / projection_meta（与 openDatabase 之后的库结构一致）。 */
export function createMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA_SQL)
  db.exec(FACTS_SQL)
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
      protocolFamily: 'dsh',
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
      ...overrides,
    }
  },
  task(overrides: Partial<Task> = {}): Task {
    return {
      id: 'tk-1',
      title: '任务',
      description: '',
      workflowId: 'wf-1',
      currentStageId: 'st-1',
      status: 'active',
      createdAt: SAMPLE_AT,
      updatedAt: SAMPLE_AT,
      ...overrides,
    }
  },
}

/** 五表列清单（与 `projection-apply` 的写列一一对应）；快照只取这些列。 */
const PROJECTION_COLUMNS: Record<string, readonly string[]> = {
  tasks: [
    'id',
    'title',
    'description',
    'workflow_id',
    'current_stage_id',
    'status',
    'created_at',
    'updated_at',
  ],
  workflows: ['id', 'name', 'description', 'created_at'],
  workflow_stages: [
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
  agents: ['id', 'name', 'description', 'runtime_id', 'system_prompt', 'created_at'],
  runtimes: [
    'id',
    'name',
    'protocol_family',
    'command',
    'profile',
    'permission_mode',
    'model',
    'reasoning_effort',
    'workdir',
    'max_concurrent',
    'enabled',
    'last_probe_json',
    'created_at',
  ],
}

/** 五表逐行快照（列固定、按 id 排序），用于「增量 vs 重建」逐表全等比较。 */
export function dumpProjection(db: DatabaseSync): Record<string, unknown[]> {
  const snapshot: Record<string, unknown[]> = {}
  for (const [table, columns] of Object.entries(PROJECTION_COLUMNS)) {
    snapshot[table] = db
      .prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY id`)
      .all() as unknown as unknown[]
  }
  return snapshot
}

export function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number }
  return row.n
}
