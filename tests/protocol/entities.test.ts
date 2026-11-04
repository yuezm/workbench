import { describe, expect, it } from 'vitest'
import type {
  Agent as SharedAgent,
  AgentInput as SharedAgentInput,
  EntryMode as SharedEntryMode,
  PermissionMode as SharedPermissionMode,
  Runtime as SharedRuntime,
  RuntimeInput as SharedRuntimeInput,
  RuntimeProbe as SharedRuntimeProbe,
  RuntimeProbeState as SharedRuntimeProbeState,
  RuntimeProtocolFamily as SharedRuntimeProtocolFamily,
  StageInput as SharedStageInput,
  Task as SharedTask,
  TaskInput as SharedTaskInput,
  TaskStatus as SharedTaskStatus,
  Workflow as SharedWorkflow,
  WorkflowInput as SharedWorkflowInput,
  WorkflowStage as SharedWorkflowStage,
  WorkflowWithStages as SharedWorkflowWithStages,
} from '../../src/shared/ai-workflow-api'
import {
  ENTRY_MODES,
  ENTITY_TABLES,
  PERMISSION_MODES,
  PROBE_STATES,
  PROTOCOL_FAMILIES,
  TASK_STATUSES,
  type Agent,
  type AgentInput,
  type EntryMode,
  type PermissionMode,
  type Runtime,
  type RuntimeInput,
  type RuntimeProbe,
  type RuntimeProbeState,
  type RuntimeProtocolFamily,
  type StageInput,
  type Task,
  type TaskInput,
  type TaskStatus,
  type Workflow,
  type WorkflowInput,
  type WorkflowStage,
  type WorkflowWithStages,
} from '../../src/protocol/entities'

/** 类型相等断言：A 与 B 必须逐字段相同（任一侧多/少字段都会失败）。 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

/**
 * 实体契约必须与 `shared/ai-workflow-api.ts` 暴露给 preload / renderer 的类型一致
 * （shared 现在只是 re-export，这里防止有人再次在 shared 里重复定义）。
 */
const contractChecks: [
  Assert<Equal<RuntimeProtocolFamily, SharedRuntimeProtocolFamily>>,
  Assert<Equal<PermissionMode, SharedPermissionMode>>,
  Assert<Equal<RuntimeProbeState, SharedRuntimeProbeState>>,
  Assert<Equal<RuntimeProbe, SharedRuntimeProbe>>,
  Assert<Equal<Runtime, SharedRuntime>>,
  Assert<Equal<RuntimeInput, SharedRuntimeInput>>,
  Assert<Equal<Agent, SharedAgent>>,
  Assert<Equal<AgentInput, SharedAgentInput>>,
  Assert<Equal<EntryMode, SharedEntryMode>>,
  Assert<Equal<WorkflowStage, SharedWorkflowStage>>,
  Assert<Equal<StageInput, SharedStageInput>>,
  Assert<Equal<Workflow, SharedWorkflow>>,
  Assert<Equal<WorkflowWithStages, SharedWorkflowWithStages>>,
  Assert<Equal<WorkflowInput, SharedWorkflowInput>>,
  Assert<Equal<TaskStatus, SharedTaskStatus>>,
  Assert<Equal<Task, SharedTask>>,
  Assert<Equal<TaskInput, SharedTaskInput>>,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
]

const sampleRuntime = {
  id: 'rt1',
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
  createdAt: '2026-01-01T00:00:00.000Z',
  lastProbe: null,
} satisfies Runtime

const sampleAgent = {
  id: 'ag1',
  name: '实现者',
  description: '',
  runtimeId: 'rt1',
  systemPrompt: '',
  createdAt: '2026-01-01T00:00:00.000Z',
} satisfies Agent

const sampleStage = {
  id: 'st1',
  workflowId: 'wf1',
  name: '待办',
  position: 0,
  entryMode: 'none',
  agentId: null,
  onCompleteStageId: null,
  onRejectStageId: null,
} satisfies WorkflowStage

const sampleWorkflow = {
  id: 'wf1',
  name: '默认流程',
  description: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  stages: [sampleStage],
} satisfies WorkflowWithStages

const sampleTask = {
  id: 't1',
  title: '写计划',
  description: '',
  workflowId: 'wf1',
  currentStageId: 'st1',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} satisfies Task

const keysOf = (row: object): string[] => Object.keys(row).sort()

describe('protocol/entities', () => {
  it('ENTITY_TABLES 只含五张投影表，顺序稳定且不重复', () => {
    expect([...ENTITY_TABLES]).toEqual([
      'tasks',
      'workflows',
      'workflow_stages',
      'agents',
      'runtimes',
    ])
    expect(new Set(ENTITY_TABLES).size).toBe(ENTITY_TABLES.length)
  })

  it('枚举常量是校验与代理共用的唯一取值来源', () => {
    expect([...PROTOCOL_FAMILIES]).toEqual(['dsh'])
    expect([...PERMISSION_MODES]).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    expect([...PROBE_STATES]).toEqual(['ready', 'unavailable'])
    expect([...ENTRY_MODES]).toEqual(['none', 'agent', 'user'])
    expect([...TASK_STATUSES]).toEqual(['active', 'completed'])
  })

  it('五张表的行字段与现有投影列（camelCase 映射）逐一对应', () => {
    expect(keysOf(sampleTask)).toEqual([
      'createdAt',
      'currentStageId',
      'description',
      'id',
      'status',
      'title',
      'updatedAt',
      'workflowId',
    ])
    expect(keysOf(sampleWorkflow)).toEqual(['createdAt', 'description', 'id', 'name', 'stages'])
    expect(keysOf(sampleStage)).toEqual([
      'agentId',
      'entryMode',
      'id',
      'name',
      'onCompleteStageId',
      'onRejectStageId',
      'position',
      'workflowId',
    ])
    expect(keysOf(sampleAgent)).toEqual([
      'createdAt',
      'description',
      'id',
      'name',
      'runtimeId',
      'systemPrompt',
    ])
    expect(keysOf(sampleRuntime)).toEqual([
      'command',
      'createdAt',
      'enabled',
      'id',
      'lastProbe',
      'maxConcurrent',
      'model',
      'name',
      'permissionMode',
      'profile',
      'protocolFamily',
      'reasoningEffort',
      'workdir',
    ])
  })

  it('与 shared/ai-workflow-api 的实体类型逐一相等（类型级断言）', () => {
    expect(contractChecks).toHaveLength(17)
    expect(contractChecks.every(Boolean)).toBe(true)
  })
})
