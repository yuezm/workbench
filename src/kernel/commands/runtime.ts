/**
 * 运行时 / 项目命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { Agent, Project, Runtime } from '../../protocol/entities'
import type { Input } from '../../protocol/inputs'
import type { Decision, Environment, FactDraft, Id, Iso, View } from '../types'
import { done, ownerDraft, reject, CONCURRENCY_CAP, CONCURRENCY_FLOOR } from './common'

/** 权限模式白名单：`src/protocol/entities.ts` 里的常量是唯一真相源。 */
const PERMISSION_MODES: readonly Runtime['permissionMode'][] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

function permissionModeOf(value: string): Runtime['permissionMode'] | null {
  return (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as Runtime['permissionMode'])
    : null
}

/** 并发上限归一：未给沿用 fallback；非正整数返回 null（交给调用方拒绝）；超过 8 按 8。 */
function normalizeConcurrency(value: number | undefined, fallback: number): number | null {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < CONCURRENCY_FLOOR) return null
  return Math.min(value, CONCURRENCY_CAP)
}

function runtimeNamed(view: View, name: string, exceptId: Id): Runtime | undefined {
  for (const runtime of view.runtimes.values()) {
    if (runtime.name === name && runtime.id !== exceptId) return runtime
  }
  return undefined
}

function projectNamed(view: View, name: string, exceptId: Id): Project | undefined {
  for (const project of view.projects.values()) {
    if (project.name === name && project.id !== exceptId) return project
  }
  return undefined
}

function projectAtPath(view: View, path: string, exceptId: Id): Project | undefined {
  for (const project of view.projects.values()) {
    if (project.path === path && project.id !== exceptId) return project
  }
  return undefined
}

/** 项目下是否还有任务（含已完成的）：有就不允许删项目。 */
function projectHasTasks(view: View, projectId: Id): boolean {
  for (const task of view.tasks.values()) {
    if (task.projectId === projectId) return true
  }
  return false
}

function agentUsingRuntime(view: View, runtimeId: Id): Agent | undefined {
  for (const agent of view.agents.values()) {
    if (agent.runtimeId === runtimeId) return agent
  }
  return undefined
}

export function createRuntime(
  view: View,
  input: Extract<Input, { type: 'runtime.create' }>,
  now: Iso,
  env: Environment,
): Decision {
  const form = input.input
  const name = form.name?.trim()
  if (!name) return reject('invalid_input', '运行时名称必填')
  const executorKey = form.executorKey?.trim() ?? ''
  if (!executorKey) return reject('invalid_input', '运行时缺少执行器键（executorKey）')
  const command = form.command?.trim() ?? ''
  if (!command) return reject('invalid_input', '运行时缺少启动命令（command）')
  const permissionMode = permissionModeOf(form.permissionMode ?? 'workspace-write')
  if (!permissionMode) {
    return reject('invalid_input', '不支持的权限模式: ' + String(form.permissionMode))
  }
  const maxConcurrent = normalizeConcurrency(form.maxConcurrent, 1)
  if (maxConcurrent === null) return reject('invalid_input', '并发上限必须是正整数')
  if (runtimeNamed(view, name, '')) return reject('conflict', '运行时名称已存在: ' + name)
  const runtime: Runtime = {
    id: env.nextId('runtime'),
    name,
    executorKey,
    command,
    profile: form.profile?.trim() ?? '',
    argsTemplate: form.argsTemplate ?? '',
    permissionMode,
    model: form.model ?? null,
    reasoningEffort: form.reasoningEffort ?? null,
    workdir: form.workdir ?? null,
    maxConcurrent,
    enabled: form.enabled !== false,
    createdAt: now,
    lastProbe: null,
  }
  return done([ownerDraft('runtime.created', { runtime }, now)])
}

export function updateRuntime(
  view: View,
  input: Extract<Input, { type: 'runtime.update' }>,
  now: Iso,
): Decision {
  const current = view.runtimes.get(input.id)
  if (!current) return reject('not_found', '运行时不存在: ' + input.id)
  const patch = input.patch
  const executorKey =
    patch.executorKey === undefined ? current.executorKey : patch.executorKey.trim()
  if (!executorKey) return reject('invalid_input', '运行时缺少执行器键（executorKey）')
  const permissionMode =
    patch.permissionMode === undefined
      ? current.permissionMode
      : permissionModeOf(patch.permissionMode)
  if (!permissionMode) {
    return reject('invalid_input', '不支持的权限模式: ' + String(patch.permissionMode))
  }
  const maxConcurrent = normalizeConcurrency(patch.maxConcurrent, current.maxConcurrent)
  if (maxConcurrent === null) return reject('invalid_input', '并发上限必须是正整数')
  const name = patch.name?.trim() || current.name
  if (name !== current.name && runtimeNamed(view, name, current.id)) {
    return reject('conflict', '运行时名称已存在: ' + name)
  }
  const runtime: Runtime = {
    ...current,
    name,
    executorKey,
    permissionMode,
    command: patch.command?.trim() || current.command,
    profile: patch.profile !== undefined ? patch.profile.trim() : current.profile,
    argsTemplate: patch.argsTemplate !== undefined ? patch.argsTemplate : current.argsTemplate,
    model: patch.model !== undefined ? patch.model : current.model,
    reasoningEffort:
      patch.reasoningEffort !== undefined ? patch.reasoningEffort : current.reasoningEffort,
    workdir: patch.workdir !== undefined ? patch.workdir : current.workdir,
    maxConcurrent,
    enabled: patch.enabled !== undefined ? patch.enabled === true : current.enabled,
  }
  return done([ownerDraft('runtime.updated', { runtime }, now)])
}

/** 编排命令：探测需要执行器端口，由宿主命令路由处理。 */
export function probeRuntimeUnsupported(): Decision {
  return reject('unsupported', 'runtime.probe 由宿主编排（探测后落 runtime.probed）')
}

export function probedRuntime(
  view: View,
  input: Extract<Input, { type: 'runtime.probed' }>,
  now: Iso,
): Decision {
  const current = view.runtimes.get(input.id)
  if (!current) return reject('not_found', '运行时不存在: ' + input.id)
  const runtime: Runtime = { ...current, lastProbe: input.probe }
  return done([ownerDraft('runtime.probed', { runtime }, now)])
}

export function removeRuntime(
  view: View,
  input: Extract<Input, { type: 'runtime.remove' }>,
  now: Iso,
): Decision {
  const current = view.runtimes.get(input.id)
  // 旧实现 DELETE 0 行同样静默成功；删除不存在的实体不算非法输入
  if (!current) return done([])
  if (agentUsingRuntime(view, current.id)) {
    return reject('conflict', '运行时被智能体引用，无法删除: ' + current.id)
  }
  return done([ownerDraft('runtime.removed', { runtime: current }, now)])
}

export function createProject(
  view: View,
  input: Extract<Input, { type: 'project.create' }>,
  now: Iso,
  env: Environment,
): Decision {
  const form = input.input
  const name = form.name?.trim()
  if (!name) return reject('invalid_input', '项目名称必填')
  const path = form.path?.trim()
  if (!path) return reject('invalid_input', '项目文件夹必填')
  if (projectNamed(view, name, '')) return reject('conflict', '项目名称已存在: ' + name)
  if (projectAtPath(view, path, '')) return reject('conflict', '该文件夹已作为项目添加: ' + path)
  const project: Project = {
    id: env.nextId('project'),
    name,
    path,
    description: form.description ?? '',
    createdAt: now,
    updatedAt: now,
  }
  return done([ownerDraft('project.created', { project }, now)])
}

export function updateProject(
  view: View,
  input: Extract<Input, { type: 'project.update' }>,
  now: Iso,
): Decision {
  const current = view.projects.get(input.id)
  if (!current) return reject('not_found', '项目不存在: ' + input.id)
  const patch = input.patch
  const name = patch.name?.trim() || current.name
  const path = patch.path === undefined ? current.path : patch.path.trim()
  if (!path) return reject('invalid_input', '项目文件夹必填')
  if (name !== current.name && projectNamed(view, name, current.id)) {
    return reject('conflict', '项目名称已存在: ' + name)
  }
  if (path !== current.path && projectAtPath(view, path, current.id)) {
    return reject('conflict', '该文件夹已作为项目添加: ' + path)
  }
  const project: Project = {
    ...current,
    name,
    path,
    description: patch.description !== undefined ? patch.description : current.description,
    updatedAt: now,
  }
  return done([ownerDraft('project.updated', { project }, now)])
}

export function removeProject(
  view: View,
  input: Extract<Input, { type: 'project.remove' }>,
  now: Iso,
): Decision {
  const current = view.projects.get(input.id)
  // 删除不存在的项目按幂等处理（与 runtime.remove 同口径）
  if (!current) return done([])
  if (projectHasTasks(view, current.id)) {
    return reject('conflict', '项目下还有任务，无法删除: ' + current.name)
  }
  // M11：项目下的会话不随项目消失，归到默认目录（`projectId: null`）；
  // 逐条产 `conversation.updated` 再删项目，重建与增量折出同一行
  const facts: FactDraft[] = []
  for (const conversation of view.conversations.values()) {
    if (conversation.projectId !== current.id) continue
    facts.push(
      ownerDraft(
        'conversation.updated',
        { conversation: { ...conversation, projectId: null, updatedAt: now } },
        now,
      ),
    )
  }
  facts.push(ownerDraft('project.removed', { project: current }, now))
  return done(facts)
}
