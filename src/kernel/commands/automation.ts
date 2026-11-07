/**
 * 自动化规则 / 插件设置 / 外部事件命令（R2 从 `decide.ts` 拆出，行为不变）。
 */
import type { Input } from '../../protocol/inputs'
import type { Decision, Environment, Iso, View } from '../types'
import { validatePluginSettings, replacedPluginSettings } from '../plugins'
import { manualTriggerFacts, validateRuleBatch } from '../rules'
import { done, HOST_SCHEDULER, OWNER, ownerDraft, receivedEventFacts, reject } from './common'

export function replaceRules(
  view: View,
  input: Extract<Input, { type: 'rules.replace' }>,
  now: Iso,
): Decision {
  // 整批替换：任一条非法 → 整批 reject（零事实），旧版继续生效；版本由内核 +1。
  const result = validateRuleBatch(view, input.rules)
  if ('error' in result) return reject('invalid_input', result.error)
  return done([
    ownerDraft(
      'rules.replaced',
      {
        ruleSet: {
          id: 'current',
          version: result.version,
          replacedAt: now,
          rules: result.rules,
        },
      },
      now,
    ),
  ])
}

export function triggerRule(
  view: View,
  input: Extract<Input, { type: 'rule.trigger' }>,
  now: Iso,
  env: Environment,
): Decision {
  // 规则页「立即运行」：直接按规则建任务，不依赖事件、不写 rule.fired
  return manualTriggerFacts(view, input.ruleId, now, env)
}

export function replacePluginSettings(
  view: View,
  input: Extract<Input, { type: 'plugins.replace' }>,
  now: Iso,
): Decision {
  // 整批替换：任一条非法 → 整批 reject（零事实），旧版继续生效；版本由内核 +1。
  const result = validatePluginSettings(input.settings)
  if ('error' in result) return reject('invalid_input', result.error)
  return done([
    ownerDraft(
      'plugins.replaced',
      {
        pluginSettings: replacedPluginSettings(
          result.settings,
          view.pluginSettingsVersion + 1,
          now,
        ),
      },
      now,
    ),
  ])
}

/** 编排命令：宿主读当前快照 + 磁盘 manifest 后合并，再转 `plugins.replace`。 */
export function setPluginUnsupported(): Decision {
  return reject('unsupported', 'plugin.set 由宿主编排（合并后落 plugins.replaced）')
}

export function receiveAppEvent(
  view: View,
  input: Extract<Input, { type: 'app.event' }>,
  now: Iso,
  env: Environment,
): Decision {
  // app 插件事件（M5 只入账，M6 起命中规则建任务）：类型白名单由宿主入口先校验。
  return done(
    receivedEventFacts(
      view,
      {
        source: 'app',
        type: input.eventType,
        subject: input.subject,
        summary: input.summary,
        detailRef: null,
        link: input.link ?? null,
        hops: 1,
        originRunId: null,
        dedupeKey: input.dedupeKey ?? null,
      },
      now,
      env,
      OWNER,
    ),
  )
}

export function receiveExternalEvent(
  view: View,
  input: Extract<Input, { type: 'event.received' }>,
  now: Iso,
  env: Environment,
): Decision {
  // source 插件 / 宿主注入的外部事件（M6）：入账后立即匹配规则建任务。
  return done(
    receivedEventFacts(
      view,
      {
        source: input.event.source,
        type: input.event.type,
        subject: input.event.subject,
        summary: input.event.summary,
        detailRef: input.detailRef ?? null,
        link: input.event.link ?? null,
        hops: input.hops ?? 1,
        originRunId: input.originRunId ?? null,
        dedupeKey: input.event.dedupeKey ?? null,
      },
      now,
      env,
      HOST_SCHEDULER,
    ),
  )
}
