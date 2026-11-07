/**
 * 智能体命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { Agent, WorkflowStage } from '../../protocol/entities'
import type { Input } from '../../protocol/inputs'
import type { Decision, Environment, Id, Iso, View } from '../types'
import { done, ownerDraft, reject } from './common'

function stageUsingAgent(view: View, agentId: Id): WorkflowStage | undefined {
  for (const stage of view.stages.values()) {
    if (stage.agentId === agentId) return stage
  }
  return undefined
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
  const agent: Agent = {
    id: env.nextId('agent'),
    name,
    description: form.description ?? '',
    runtimeId: form.runtimeId,
    systemPrompt: form.systemPrompt ?? '',
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
  const agent: Agent = {
    ...current,
    name: patch.name?.trim() || current.name,
    description: patch.description ?? current.description,
    runtimeId,
    systemPrompt: patch.systemPrompt ?? current.systemPrompt,
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
  if (stageUsingAgent(view, current.id)) {
    return reject('conflict', '智能体被工作流阶段或对话引用，无法删除: ' + current.id)
  }
  return done([ownerDraft('agent.removed', { agent: current }, now)])
}
