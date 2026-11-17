/**
 * 授权（A2）：授予、撤销、恢复前重校验，以及权限上限的取交集。
 *
 * 纯函数：不读时钟、不读文件；`at` / `id` / `policyVersion` 由调用方（内核命令）给。
 *
 * 三条口径来自 SPEC-authority §授权生命周期：
 *
 * - **授予只在建任务时发生**：范围取规则目标（工作流 / 阶段 / 项目）与智能体权限上限；
 *   未被任务使用的字段给 `null`（不限），不编造默认额度。
 * - **撤销只有三种原因**：人叫停、恢复前重校验失败、换版后依据不再成立；任务完成不算撤销。
 * - **重校验按 `basis` 分支**：同一份 Mandate 在不同来源强度下成立条件不同，见 `revalidate`。
 *
 * `access` 只收紧不放宽：`permissionMode` 是配置侧原意，Mandate 记的是当时被允许的上限。
 */
import type { Access, Agent, Task, WorkflowStage } from '@workbench/protocol/entities'
import type { Environment, FactDraft, Id, Iso, View } from '../core/types'
import type {
  AdmissionBasis,
  AdmissionReason,
  Authority,
  Mandate,
  MandateBy,
  MandateRevokedReason,
  MandateScope,
  Strength,
} from '@workbench/protocol/authority'
import { admit } from './admission'
import { runAccessOf } from './task-effects'

export interface GrantInput {
  id: string
  task: Task
  /** 命中的规则（proactive 任务可能有多个） */
  ruleIds: string[]
  strength: Strength
  basis: AdmissionBasis
  by: MandateBy
  policyVersion: number
  grantedAt: string
  /** 阶段的闸门语义参与权限折算（闸门阶段恒 `full`，与 M27 一致） */
  stage: Pick<WorkflowStage, 'judge'> | null
  agent: Pick<Agent, 'permissionMode'> | null
}

/** 按任务的落点与智能体配置算出范围：只填已知项，其余留 `null`。 */
export function grantMandate(input: GrantInput): Mandate {
  const access: Access =
    input.agent === null
      ? 'read'
      : input.stage === null
        ? runAccessOf({ judge: null }, input.agent.permissionMode)
        : runAccessOf(input.stage, input.agent.permissionMode)
  const scope: MandateScope = {
    workflowId: input.task.workflowId,
    stageId: input.task.currentStageId,
    projectId: input.task.projectId,
    access,
    maxRuns: null,
    maxTokens: null,
    expiresAt: null,
  }
  return {
    id: input.id,
    taskId: input.task.id,
    scope,
    strength: input.strength,
    basis: input.basis,
    policyVersion: input.policyVersion,
    ruleIds: [...input.ruleIds],
    by: input.by,
    grantedAt: input.grantedAt,
    revokedAt: null,
    revokedReason: null,
    legacy: false,
  }
}

/** 撤销：已撤销的幂等返回原行（重放/重试不该产生第二条撤销事实）。 */
export function revokeMandate(mandate: Mandate, reason: MandateRevokedReason, at: string): Mandate {
  if (mandate.revokedAt !== null) return mandate
  return { ...mandate, revokedAt: at, revokedReason: reason }
}

export interface Revalidation {
  ok: boolean
  reason: string | null
}

const OK: Revalidation = { ok: true, reason: null }
const fail = (reason: string): Revalidation => ({ ok: false, reason })

const RANK: Record<Strength, number> = { inferred: 1, explicit: 2 }

/** 触发来源是否还在策略里；不在就说得清楚是「谁」不在了。 */
function sourcePolicyOf(authority: Authority, source: string): Authority['sources'][number] | null {
  for (const policy of authority.sources) {
    if (policy.id === source) return policy
  }
  return null
}

/**
 * 恢复新一轮之前判授权是否仍成立（A2）。
 *
 * `authority === null`（兼容模式）恒过：没有准入配置就没有可失效的依据。其余按 `basis`：
 *
 * - `manual`：恒过（人建的，只有人能撤）。
 * - `addressed` / `followup`：来源仍在、身份仍在名单；`followup` 额外承认
 *   「名单外点名」格被设成 explicit 的来源。
 * - `table`：按今天的准入表重判，强度不得低于原强度。
 * - `bot`：机器人仍在名单，且来源仍是自动接单（`auto`）。
 *
 * 失败原因用一句话说明，直接进 `mandate.revalidated.reason` 给人看。
 */
export function revalidateMandate(mandate: Mandate, authority: Authority | null): Revalidation {
  if (mandate.legacy) return OK
  if (mandate.by.kind === 'manual') return OK
  if (authority === null) return OK

  const { source, identity } = mandate.by
  const policy = sourcePolicyOf(authority, source)
  if (policy === null) return fail(`来源「${source}」已不在准入配置里`)

  switch (mandate.basis) {
    case 'manual':
      return OK
    case 'bot':
      if (!policy.bots.includes(identity.id)) return fail(`机器人「${identity.id}」已移出名单`)
      if (authority.mode !== 'auto') return fail('来源已不再自动接单')
      return OK
    case 'addressed':
      return policy.allowed.includes(identity.id) ? OK : fail(`「${identity.id}」已移出名单`)
    case 'followup':
      if (policy.allowed.includes(identity.id)) return OK
      return policy.admission.unlistedAddressed === 'explicit'
        ? OK
        : fail(`「${identity.id}」已不在名单，且不再允许名单外点名`)
    case 'table': {
      const verdict = admit({ source, identity }, authority)
      if (!verdict.allow) return fail(reasonText(verdict.reason))
      return RANK[verdict.strength] >= RANK[mandate.strength]
        ? OK
        : fail('准入表今天只给到更弱的强度')
    }
  }
}

const reasonText = (reason: AdmissionReason): string => {
  switch (reason) {
    case 'not-listed':
      return '身份已不在允许范围'
    case 'mode-off':
      return '来源已不再接受推断候选'
    case 'bot-not-listed':
      return '机器人已移出名单'
    case 'no-rule':
      return '没有匹配的规则'
    case 'assess-failed':
      return '研判未给出结论'
  }
}

export interface GrantFactsInput {
  view: View
  /** 本次刚建出来的任务（同一批事实里已产 `task.created`） */
  tasks: readonly Task[]
  strength: Strength
  basis: AdmissionBasis
  by: MandateBy
  policyVersion: number
  now: Iso
  env: Environment
}

/**
 * 建任务时顺带授予：`mandate.granted` 与 `task.created` 在同一批事实里。
 *
 * 只对**本次新建**的任务授予；复用任务 / 派生任务 / 交接任务各自有来源，不在这里补发
 * （存量任务一律 `legacy`，不伪造因果）。
 */
export function grantFacts(input: GrantFactsInput): FactDraft<'mandate.granted'>[] {
  return input.tasks.map((task) => {
    const stage =
      task.currentStageId === null ? null : (input.view.stages.get(task.currentStageId) ?? null)
    const agent =
      task.currentStageId === null ? null : agentOfStage(input.view, task.currentStageId)
    const mandate = grantMandate({
      id: input.env.nextId('mandate') satisfies Id,
      task,
      ruleIds: task.ruleId === null ? [] : [task.ruleId],
      strength: input.strength,
      basis: input.basis,
      by: input.by,
      policyVersion: input.policyVersion,
      grantedAt: input.now,
      stage,
      agent,
    })
    return {
      type: 'mandate.granted',
      actor: { kind: 'kernel' } as const,
      at: input.now,
      payload: { mandate },
    }
  })
}

/** 阶段绑定的智能体（只取权限字段）；阶段没有智能体或行缺失时为 null。 */
function agentOfStage(view: View, stageId: string): Pick<Agent, 'permissionMode'> | null {
  const stage = view.stages.get(stageId)
  if (stage === undefined || stage.agentId === null) return null
  return view.agents.get(stage.agentId) ?? null
}
