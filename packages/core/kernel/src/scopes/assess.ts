/**
 * 研判（A3）：把一次 `purpose='assess'` 运行的判定折算成结论。
 *
 * 纯函数：不读时钟、不读文件、不调模型。三条硬约束来自 SPEC-authority §研判契约：
 *
 * 1. **覆盖精确**：当前启用的每条规则恰好判一次——漏判、多判、重判都算失败；
 * 2. **命中必须有证据**：`match=true` 时 `evidence` 非空且 ≤300 字（指向具体文字/链接）；
 * 3. **模式决定接不接单**：只有 `auto` 才可能 `accept`；`observe` / `off` 一律 `ignore`，
 *    命中与否另记 `wouldAccept`，用于「本来会接」复盘。
 *
 * 失败不是异常：返回 `{ok:false, reason}`，调用方记 `via='failed'` 并按 A3 口径重试一次，
 * 二次失败落 `event.denied{assess-failed}`——宁可漏接，不可瞎接。
 */
import type { AutomationRule } from '@workbench/protocol/rules'
import type { RunRow } from '@workbench/protocol/entities'
import type { AcceptMode, Assessment, AssessVerdict } from '@workbench/protocol/authority'
import type { Authority } from '@workbench/protocol/authority'
import type { Environment, EventRow, FactDraft, Iso, View } from '../core/types'
import { narrowAccess } from './access'
import { runAccessOf } from './task-effects'

/** 证据长度上限（与 SPEC-authority 一致：一句话，不写小作文） */
export const EVIDENCE_MAX = 300

export type OutcomeFailure = 'coverage' | 'evidence' | 'empty' | 'shape'

export type OutcomeResult =
  { ok: true; assessment: Assessment } | { ok: false; reason: OutcomeFailure }

export interface OutcomeInput {
  id: string
  eventId: string
  policyVersion: number
  /** 当前规则全集（停用的由这里过滤，调用方不必预处理） */
  rules: readonly AutomationRule[]
  verdicts: readonly AssessVerdict[]
  mode: AcceptMode
}

const fail = (reason: OutcomeFailure): OutcomeResult => ({ ok: false, reason })

export function assessmentOutcome(input: OutcomeInput): OutcomeResult {
  if (!Array.isArray(input.verdicts)) return fail('shape')
  const enabled = input.rules.filter((rule) => rule.enabled)
  if (enabled.length === 0) return fail('empty')

  const expected = new Set(enabled.map((rule) => rule.id))
  const seen = new Set<string>()
  for (const verdict of input.verdicts) {
    if (typeof verdict?.ruleId !== 'string' || !expected.has(verdict.ruleId)) {
      return fail('coverage')
    }
    if (seen.has(verdict.ruleId)) return fail('coverage')
    seen.add(verdict.ruleId)
    if (verdict.match) {
      const evidence = typeof verdict.evidence === 'string' ? verdict.evidence.trim() : ''
      if (evidence === '' || Array.from(evidence).length > EVIDENCE_MAX) return fail('evidence')
    }
  }
  if (seen.size !== expected.size) return fail('coverage')

  const matched = input.verdicts.some((verdict) => verdict.match)
  return {
    ok: true,
    assessment: {
      id: input.id,
      eventId: input.eventId,
      policyVersion: input.policyVersion,
      ruleIds: [...expected],
      verdicts: input.verdicts.map((verdict) => ({ ...verdict })),
      decision: matched && input.mode === 'auto' ? 'accept' : 'ignore',
      wouldAccept: matched && input.mode !== 'auto',
      via: 'assessor',
    },
  }
}

// ---------- 研判 run（A3-T3） ----------

export interface AssessPromptInput {
  rules: readonly AutomationRule[]
  events: readonly EventRow[]
  artifactsRoot: string
}

/**
 * 研判提示词：只放**已校验**的字段（类型 / 对象 / 链接）与规则清单，事件正文只以资料路径出现。
 *
 * 这一段是「研判 run 不派生副作用」的前半：模型看不到可以照做的指令，只看到分类题；
 * 后半在回执校验（只收 `assessments[]`）。
 */
export function assessPrompt(input: AssessPromptInput): string {
  const rules = input.rules
    .filter((rule) => rule.enabled)
    .map(
      (rule) =>
        `- ${rule.id}（${rule.name}）${rule.prompt === undefined ? '' : `：${rule.prompt}`}`,
    )
  const events = input.events.map((event) => {
    const detail =
      event.detailRef === null
        ? '（没有正文资料）'
        : `${input.artifactsRoot}/${event.detailRef}`.replace(/\/+/g, '/')
    const link = event.link === null ? '（无链接）' : event.link
    return [
      `- ${event.id} · ${event.source} · ${event.type}`,
      `  对象：${event.subject}`,
      `  链接：${link}`,
      `  资料：${detail}`,
    ].join('\n')
  })
  return [
    '# 研判（本轮只做判定，不做工作）',
    '',
    '你只判断「这件事属于哪一类活」，不执行、不改文件、不提交、不派活。',
    '',
    '## 启用的规则',
    '',
    rules.length === 0 ? '（当前没有启用的规则）' : rules.join('\n'),
    '',
    '## 候选事件',
    '',
    events.join('\n'),
    '',
    '## 输出',
    '',
    '最后一条消息附一个 ```json 代码块，形状：',
    '{"assessments":[{"eventId":"…","verdicts":[{"ruleId":"…","match":true,"evidence":"…"}]}]}',
    '',
    `每条启用规则恰好判一次；match=true 必须带 evidence（≤${EVIDENCE_MAX} 字，指向具体文字或链接）。`,
  ].join('\n')
}

export interface AssessRunInput {
  view: View
  /** 本次攒批的候选事件（调用方保证都过了准入、都是 inferred） */
  events: readonly EventRow[]
  now: Iso
  env: Environment
}

/**
 * 建一轮研判：`purpose='assess'`、`taskId=null`、`hops=0`。
 *
 * 缺研判智能体 / 智能体或运行时不在时返回零事实——由调用方按接受模式兜底（A3-T4），
 * 不在这里发明一个默认智能体。批内按到达时间升序、截到 `assessBatch`。
 */
export function assessRunFacts(input: AssessRunInput): FactDraft<'run.queued'>[] {
  const authority: Authority | null = input.view.authority ?? null
  if (authority === null || input.events.length === 0) return []
  const agentId = authority.assessorAgentId
  if (agentId === null) return []
  const agent = input.view.agents.get(agentId)
  if (agent === undefined) return []
  const runtime = input.view.runtimes.get(agent.runtimeId)
  if (runtime === undefined || !runtime.enabled) return []

  const batch = [...input.events]
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, authority.assessBatch))
  const rules = input.view.rules.filter((rule) => rule.enabled)
  const prompt = assessPrompt({
    rules,
    events: batch,
    artifactsRoot: input.view.artifactsRoot ?? '',
  })

  const run: RunRow = {
    id: input.env.nextId('run'),
    purpose: 'assess',
    taskId: null,
    conversationId: null,
    stageId: null,
    agentId: agent.id,
    script: null,
    runtimeId: runtime.id,
    ruleId: null,
    rulesVersion: input.view.rulesVersion,
    executorKey: runtime.executorKey,
    threadId: null,
    cwd: agent.workdir ?? '',
    access: narrowAccess(runAccessOf({ judge: null }, agent.permissionMode), 'read'),
    skill: null,
    promptRef: null,
    eventIds: batch.map((event) => event.id),
    hops: 0,
    turn: 1,
    resumeSessionId: null,
    threadContextRef: null,
    queueSeq: 0,
    status: 'queued',
    prompt,
    output: '',
    error: null,
    errorCode: null,
    exitCode: null,
    sessionId: null,
    usage: null,
    durationMs: null,
    leaseId: null,
    attempt: 0,
    attempts: 0,
    leaseUntil: null,
    notBefore: null,
    deadlineAt: null,
    cancelRequested: false,
    deliverables: null,
    startedAt: null,
    endedAt: null,
    createdAt: input.now,
  }
  return [{ type: 'run.queued', actor: { kind: 'kernel' }, at: input.now, payload: { run } }]
}
