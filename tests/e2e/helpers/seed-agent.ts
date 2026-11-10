/**
 * 执行 / 项目维度 E2E 的种子夹具（纯 Node，不碰 Electron）：
 *
 * 1. 用真实 `openDatabase` + `createStore`（真实 kernel）在临时 userData 里建库；
 * 2. 建一个走 `command` 执行器插件的运行时——命令指向假智能体脚本、参数模板为空，
 *    提示词只经 stdin 传给子进程（与生产同一条执行链：spawn → 帧 → 回执）；
 * 3. 建智能体（绑定该运行时）与项目（项目目录就是 run 的工作目录，必须是真实目录）；
 * 4. 可选：建带闸门的工作流（阶段下标型闸门配置 → 内核按 id 落库）。
 *
 * 所有断言都从库文件读，应用运行中亦可（WAL + busy_timeout）。
 */
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../../src/host/db'
import { createStore } from '../../../src/host/store/index'
import { decide } from '../../../src/kernel/decide'
import { nextWakeAt } from '../../../src/kernel/next-wake'
import { project } from '../../../src/kernel/project'
import type { Fact, KernelPort } from '../../../src/kernel/types'
import { viewSpec } from '../../../src/kernel/view-spec'
import type { Agent, Project, Runtime, Task, Workflow } from '../../../src/protocol/entities'

const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

/** 种子里可建的阶段（闸门用下标型配置：内核按 `stages` 数组下标转成阶段 id）。 */
export interface SeedStage {
  name: string
  entryMode: 'agent' | 'none'
  gate?: { maxFails: number; onPassIndex?: number | null; onFailIndex?: number | null } | null
}

export interface AgentSeed {
  dbPath: string
  runtimeId: string
  agentId: string
  projectId: string
  /** 建了工作流才有 */
  workflowId: string | null
  /** 工作流阶段 id（按位置） */
  stageIds: string[]
}

export interface SeedAgentOptions {
  /** 假智能体命令的绝对路径 */
  command: string
  /** 项目工作目录（必须是真实目录：run 的 cwd 取它） */
  projectPath: string
  /** 工作流阶段（缺省不建工作流：聊天用例不需要） */
  stages?: SeedStage[]
  /** 智能体名称（缺省「e2e 假智能体」） */
  agentName?: string
  /** 智能体提示词（缺省空；设置页弹窗的尺寸用例要种一段超长提示词） */
  systemPrompt?: string
}

function payloadOf<T>(facts: readonly Fact[], type: string, what: string): T {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error(`执行种子缺少事实：${what}（${type}）`)
  return fact.payload as T
}

/** 建一个走 `command` 执行器插件的运行时（命令是假智能体，提示词只走 stdin）。 */
function createRuntime(
  store: ReturnType<typeof createStore>,
  command: string,
  workdir: string,
): Runtime {
  const facts = store.dispatch({
    type: 'runtime.create',
    commandId: 'e2e-agent-runtime',
    input: {
      name: 'e2e 假智能体运行时',
      executorKey: 'command',
      command,
      // 空模板 = 无参数 → 提示词只走 stdin（不进 argv）
      argsTemplate: '',
      profile: '',
      permissionMode: 'workspace-write',
      // 执行工作目录固定到项目目录：run 的 cwd 取它，避免落到宿主默认目录
      workdir,
      maxConcurrent: 1,
      enabled: true,
    },
  }).facts
  return payloadOf<{ runtime: Runtime }>(facts, 'runtime.created', '运行时').runtime
}

function createAgent(
  store: ReturnType<typeof createStore>,
  runtimeId: string,
  options: { name?: string; systemPrompt?: string } = {},
): Agent {
  const facts = store.dispatch({
    type: 'agent.create',
    commandId: 'e2e-agent-agent',
    input: {
      name: options.name ?? 'e2e 假智能体',
      runtimeId,
      systemPrompt: options.systemPrompt,
    },
  }).facts
  return payloadOf<{ agent: Agent }>(facts, 'agent.created', '智能体').agent
}

function createProject(store: ReturnType<typeof createStore>, name: string, path: string): Project {
  const facts = store.dispatch({
    type: 'project.create',
    commandId: 'e2e-project-' + name,
    input: { name, path },
  }).facts
  return payloadOf<{ project: Project }>(facts, 'project.created', '项目').project
}

function createWorkflow(
  store: ReturnType<typeof createStore>,
  name: string,
  stages: SeedStage[],
  agentId: string,
): { workflow: Workflow; stageIds: string[] } {
  const facts = store.dispatch({
    type: 'workflow.create',
    commandId: 'e2e-workflow-' + name,
    input: {
      name,
      stages: stages.map((stage) => ({
        name: stage.name,
        entryMode: stage.entryMode,
        agentId: stage.entryMode === 'agent' ? agentId : null,
        gate: stage.gate ?? null,
      })),
    },
  }).facts
  const workflow = payloadOf<{ workflow: Workflow }>(facts, 'workflow.created', '工作流').workflow
  const view = store.query('workflows.all').find((row) => row.id === workflow.id)
  // M18：内置四阶段由系统补齐；`stageIds` 只给用户阶段（种子声明的那些），按位置排序
  return {
    workflow,
    stageIds: (view?.stages ?? [])
      .filter((stage) => stage.builtin == null)
      .map((stage) => stage.id),
  }
}

function createTask(
  store: ReturnType<typeof createStore>,
  title: string,
  workflowId: string,
  projectId: string,
): Task {
  const facts = store.dispatch({
    type: 'task.create',
    commandId: 'e2e-task-' + title,
    input: { title, workflowId, projectId },
  }).facts
  return payloadOf<{ task: Task }>(facts, 'task.created', '任务').task
}

/** 建库 → 运行时（command 执行器）→ 智能体 → 项目 →（可选）工作流。 */
export async function seedAgentBase(dbPath: string, options: SeedAgentOptions): Promise<AgentSeed> {
  const db = openDatabase(dbPath)
  try {
    const store = createStore({ db, kernel })

    const runtime = createRuntime(store, options.command, options.projectPath)
    const agent = createAgent(store, runtime.id, {
      name: options.agentName,
      systemPrompt: options.systemPrompt,
    })
    const project = createProject(store, 'e2e 项目', options.projectPath)

    let workflowId: string | null = null
    let stageIds: string[] = []
    if (options.stages !== undefined && options.stages.length > 0) {
      const created = createWorkflow(store, 'e2e 执行流程', options.stages, agent.id)
      workflowId = created.workflow.id
      stageIds = created.stageIds
    }

    return {
      dbPath,
      runtimeId: runtime.id,
      agentId: agent.id,
      projectId: project.id,
      workflowId,
      stageIds,
    }
  } finally {
    db.close()
  }
}

export interface ProjectSeed {
  dbPath: string
  agentId: string
  workflowId: string
  stageIds: string[]
  projectA: { id: string; name: string }
  projectB: { id: string; name: string }
  taskAId: string
  taskBId: string
  conversationAId: string
}

export interface SeedProjectOptions {
  /** 假智能体命令（聊天会话要挂智能体） */
  command: string
  /** 项目 A / B 的工作目录（必须是真实目录） */
  dirA: string
  dirB: string
}

/**
 * 项目维度种子：两个项目各一个任务 + 只挂在项目 A 的一个会话。
 *
 * 用来验证 M11「项目是聊天与任务共用的顶层上下文」：切项目 → 任务与会话都跟着换。
 */
export async function seedProjectDimension(
  dbPath: string,
  options: SeedProjectOptions,
): Promise<ProjectSeed> {
  const db = openDatabase(dbPath)
  try {
    const store = createStore({ db, kernel })

    const runtime = createRuntime(store, options.command, options.dirA)
    const agent = createAgent(store, runtime.id)
    const { workflow, stageIds } = createWorkflow(
      store,
      'e2e 项目流程',
      [{ name: '待办', entryMode: 'none' }],
      agent.id,
    )
    const projectA = createProject(store, '项目甲', options.dirA)
    const projectB = createProject(store, '项目乙', options.dirB)
    const taskA = createTask(store, '甲任务', workflow.id, projectA.id)
    const taskB = createTask(store, '乙任务', workflow.id, projectB.id)

    // 会话只挂在项目 A：切到项目 B 后它不该出现在会话清单里
    // 注意：`chat.create` 的载荷是平铺的（不走 `input`），与 `chat.send` 同口径
    const chatFacts = store.dispatch({
      type: 'chat.create',
      commandId: 'e2e-project-chat',
      agentId: agent.id,
      title: '甲会话',
      projectId: projectA.id,
    }).facts
    const conversation = payloadOf<{ conversation: { id: string } }>(
      chatFacts,
      'conversation.created',
      '会话',
    ).conversation

    return {
      dbPath,
      agentId: agent.id,
      workflowId: workflow.id,
      stageIds,
      projectA: { id: projectA.id, name: projectA.name },
      projectB: { id: projectB.id, name: projectB.name },
      taskAId: taskA.id,
      taskBId: taskB.id,
      conversationAId: conversation.id,
    }
  } finally {
    db.close()
  }
}

export interface AgentState {
  messages: Array<{ role: string; content: string; error: string | null }>
  runs: Array<{
    id: string
    purpose: string
    status: string
    output: string
    error: string | null
    taskId: string | null
    conversationId: string | null
  }>
  tasks: Array<{
    id: string
    status: string
    currentStageId: string | null
    gateFails: number
    labels: string[]
  }>
  /** 事实条数（按类型） */
  factCounts: Record<string, number>
}

/** 只读复查（应用运行中也可读）：消息 / run / 任务与关键事实计数。 */
export function readAgentState(dbPath: string): AgentState {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const messages = (
      db.prepare('SELECT role, content, error FROM messages ORDER BY created_at').all() as Array<{
        role: string
        content: string
        error: string | null
      }>
    ).map((row) => ({ role: row.role, content: row.content, error: row.error }))

    const runs = (
      db
        .prepare(
          `SELECT id, purpose, status, output, error, task_id, conversation_id
           FROM runs ORDER BY created_at`,
        )
        .all() as Array<{
        id: string
        purpose: string
        status: string
        output: string
        error: string | null
        task_id: string | null
        conversation_id: string | null
      }>
    ).map((row) => ({
      id: row.id,
      purpose: row.purpose,
      status: row.status,
      output: row.output,
      error: row.error,
      taskId: row.task_id,
      conversationId: row.conversation_id,
    }))

    const tasks = (
      db
        .prepare(
          'SELECT id, status, current_stage_id, gate_fails, labels_json FROM tasks ORDER BY created_at',
        )
        .all() as Array<{
        id: string
        status: string
        current_stage_id: string | null
        gate_fails: number
        labels_json: string
      }>
    ).map((row) => ({
      id: row.id,
      status: row.status,
      currentStageId: row.current_stage_id,
      gateFails: row.gate_fails,
      labels: JSON.parse(row.labels_json) as string[],
    }))

    const factCounts: Record<string, number> = {}
    const factRows = db
      .prepare('SELECT type, COUNT(*) AS n FROM facts GROUP BY type')
      .all() as Array<{ type: string; n: number }>
    for (const row of factRows) factCounts[row.type] = row.n

    return { messages, runs, tasks, factCounts }
  } finally {
    db.close()
  }
}
