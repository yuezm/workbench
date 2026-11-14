/**
 * 智能体命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { Agent, Conversation, WorkflowStage } from '../../../protocol/entities'
import type { Input } from '../../../protocol/inputs'
import { normalizeModelId } from '../../../protocol/model-id'
import type { Decision, Environment, Id, Iso, View } from '../../core/types'
import {
  done,
  normalizeConcurrency,
  normalizeEnv,
  ownerDraft,
  permissionModeOf,
  reject,
} from './common'

/**
 * 模型 id 归一（M28）：空 → null；有值就按 `provider/id` 存（剥 `[1m]` 这类窗口标注、
 * 解 `%2F`），格式不对直接拒。
 *
 * 为什么收在决策层：`[1m]` 后缀进到 CLI 会变成 `unrecognized_model`，`%2F` 不解码会变成
 * `no configured model`——两种都是「存的时候没人管、跑的时候炸一轮」。存入口归一一次，
 * 解析侧（`parseModelId`）再兜一次，两侧同口径。
 */
function modelOf(
  model: string | null | undefined,
): { ok: true; value: string | null } | { ok: false } {
  const trimmed = (model ?? '').trim()
  if (trimmed === '') return { ok: true, value: null }
  const normalized = normalizeModelId(trimmed)
  return normalized === null ? { ok: false } : { ok: true, value: normalized }
}

/** 绑定了该智能体的第一个工作流阶段（阶段绑定的智能体不允许删） */
function stageUsingAgent(view: View, agentId: Id): WorkflowStage | undefined {
  for (const stage of view.stages.values()) {
    if (stage.agentId === agentId) return stage
  }
  return undefined
}

/**
 * 绑定了该智能体的对话（`conversations.agent_id` 是 `ON DELETE RESTRICT`）。
 *
 * 以前这里只查阶段，删「有对话的智能体」会一路走到投影层，把 SQLite 的
 * `FOREIGN KEY constraint failed` 原样抛给界面。对话删不掉智能体，就在决策里拒掉
 * 并说清卡在哪一步。
 */
function conversationsUsingAgent(view: View, agentId: Id): Conversation[] {
  const rows: Conversation[] = []
  for (const conversation of view.conversations.values()) {
    if (conversation.agentId === agentId) rows.push(conversation)
  }
  return rows
}

export function createAgent(
  view: View,
  input: Extract<Input, { type: 'agent.create' }>,
  now: Iso,
  env: Environment,
): Decision {
  const form = input.input
  const name = form.name?.trim()
  if (!name) return reject('invalid_input', '智能体名称必填')
  if (!view.runtimes.has(form.runtimeId)) {
    return reject('not_found', '运行时不存在: ' + form.runtimeId)
  }
  const permissionMode = permissionModeOf(form.permissionMode ?? 'workspace-write')
  if (!permissionMode) {
    return reject('invalid_input', '不支持的权限模式: ' + String(form.permissionMode))
  }
  const maxConcurrent = normalizeConcurrency(form.maxConcurrent, 1)
  if (maxConcurrent === null) return reject('invalid_input', '并发上限必须是正整数')
  const model = modelOf(form.model)
  if (!model.ok) {
    return reject('invalid_input', '模型格式不对（要 `provider/model`）：' + String(form.model))
  }
  const agent: Agent = {
    id: env.nextId('agent'),
    name,
    description: form.description ?? '',
    runtimeId: form.runtimeId,
    systemPrompt: form.systemPrompt ?? '',
    model: model.value,
    reasoningEffort: form.reasoningEffort ?? null,
    maxConcurrent,
    permissionMode,
    workdir: form.workdir ?? null,
    env: normalizeEnv(form.env),
    createdAt: now,
  }
  return done([ownerDraft('agent.created', { agent }, now)])
}

export function updateAgent(
  view: View,
  input: Extract<Input, { type: 'agent.update' }>,
  now: Iso,
): Decision {
  const current = view.agents.get(input.id)
  if (!current) return reject('not_found', '智能体不存在: ' + input.id)
  const patch = input.patch
  const runtimeId = patch.runtimeId ? patch.runtimeId : current.runtimeId
  if (patch.runtimeId && !view.runtimes.has(patch.runtimeId)) {
    return reject('not_found', '运行时不存在: ' + patch.runtimeId)
  }
  const permissionMode =
    patch.permissionMode === undefined
      ? current.permissionMode
      : permissionModeOf(patch.permissionMode)
  if (!permissionMode) {
    return reject('invalid_input', '不支持的权限模式: ' + String(patch.permissionMode))
  }
  const maxConcurrent = normalizeConcurrency(patch.maxConcurrent, current.maxConcurrent)
  if (maxConcurrent === null) return reject('invalid_input', '并发上限必须是正整数')
  const model =
    patch.model === undefined ? { ok: true as const, value: current.model } : modelOf(patch.model)
  if (!model.ok) {
    return reject('invalid_input', '模型格式不对（要 `provider/model`）：' + String(patch.model))
  }
  const agent: Agent = {
    ...current,
    name: patch.name?.trim() || current.name,
    description: patch.description ?? current.description,
    runtimeId,
    systemPrompt: patch.systemPrompt ?? current.systemPrompt,
    model: model.value,
    reasoningEffort:
      patch.reasoningEffort !== undefined ? patch.reasoningEffort : current.reasoningEffort,
    maxConcurrent,
    permissionMode,
    workdir: patch.workdir !== undefined ? patch.workdir : current.workdir,
    env: patch.env !== undefined ? normalizeEnv(patch.env) : current.env,
  }
  return done([ownerDraft('agent.updated', { agent }, now)])
}

export function removeAgent(
  view: View,
  input: Extract<Input, { type: 'agent.remove' }>,
  now: Iso,
): Decision {
  const current = view.agents.get(input.id)
  if (!current) return done([])
  const stage = stageUsingAgent(view, current.id)
  if (stage !== undefined) {
    return reject(
      'conflict',
      `智能体被工作流阶段「${stage.name}」引用，无法删除：先到「工作流」里把这个阶段换绑到别的智能体`,
    )
  }
  const conversations = conversationsUsingAgent(view, current.id)
  if (conversations.length > 0) {
    return reject(
      'conflict',
      `智能体被 ${conversations.length} 个对话引用（含已归档），无法删除：先删除这些对话，再回来删智能体`,
    )
  }
  return done([ownerDraft('agent.removed', { agent: current }, now)])
}
