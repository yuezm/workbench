// @vitest-environment node
/**
 * 规则投影专项（M6 T3）：真实 SQLite 临时库 + 真实内核上的「规则事实 → 投影 → 重建」。
 *
 * 覆盖：
 * 1. `rules.replace` 整批替换 → `rules.replaced` 事实与 `rule_sets` 单行（版本 / 替换时刻 / 规则 JSON）；
 * 2. `event.received` 命中 github 规则 → `task.created` + `run.queued`；同 rule + 同 externalRef
 *    的第二次事件只入账、不重复建任务；
 * 3. `clock.tick` 到 cron 点 → `task.created` + `rule.fired`，`tasks.rule_id` / `external_ref`、
 *    `rule_fires` 行与 `rules.all` 版本一致；同一到点时刻不重复触发；
 * 4. `store.rebuild()` 后 `dumpProjection` 与增量逐表全等（重点 `rule_sets` / `rule_fires` /
 *    `tasks` 新列）。
 *
 * 用 `openDatabase` 打开的真实文件库（不是内存库、不是假 project），内核是真实的
 * `decide` / `project` / `viewSpec`——验证的是「事实 → 投影 → 重建」真实链路。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { decide } from '../../src/kernel/decide'
import { project } from '../../src/kernel/project'
import type { Iso, KernelPort } from '../../src/kernel/types'
import { viewSpec } from '../../src/kernel/view-spec'
import type { AutomationRule, RuleFireRow } from '../../src/protocol/rules'
import { openDatabase } from '../../src/host/db'
import { createStore, type Store } from '../../src/host/store/index'
import { dumpProjection } from './store/test-support'

/** cron 表达式按注入的时区求值：固定 UTC，避免测试随本机时区漂移。 */
const TZ = 'UTC'
const AT = '2026-06-01T08:00:00.000Z'
/** 规则替换（08:00）之后、cron 到点（09:00）之后的 tick 时刻。 */
const CRON_AT = '2026-06-01T09:00:10.000Z'
const CRON_SCHEDULED = '2026-06-01T09:00:00.000Z'

const kernel: KernelPort = { decide, project, viewSpec }

let openDbs: DatabaseSync[] = []
let roots: string[] = []

afterEach(() => {
  for (const db of openDbs) db.close()
  openDbs = []
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

interface World {
  db: DatabaseSync
  store: Store
  /** 推进注入的 `now`：cron 到点与 `rule.fired.firedAt` 都取它。 */
  setNow: (at: Iso) => void
}

/** 每个用例一个真实 SQLite 临时文件库（走 `openDatabase` 的完整建库路径）。 */
function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'aiwf-rules-'))
  roots.push(root)
  const db = openDatabase(path.join(root, 'ai-workflow.db'))
  openDbs.push(db)
  let now = AT
  const store = createStore({ db, kernel, now: () => now, timezone: TZ })
  store.ensureProjection()
  return {
    db,
    store,
    setNow: (at) => {
      now = at
    },
  }
}

function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`缺少${label}`)
  return value
}

/** 运行时 / 智能体 / 单阶段 agent 入口工作流：规则任务进入该阶段即产入口 run。 */
function seedWorkflow(store: Store): { workflowId: string; stageId: string; agentId: string } {
  store.dispatch({
    type: 'runtime.create',
    commandId: 'rules-rt',
    input: { name: '本机 dsh', executorKey: 'dsh', command: 'dsh' },
  })
  const runtime = must(store.query('runtimes.all')[0], '运行时')
  store.dispatch({
    type: 'agent.create',
    commandId: 'rules-ag',
    input: { name: '实现者', runtimeId: runtime.id },
  })
  const agent = must(store.query('agents.all')[0], '智能体')
  store.dispatch({
    type: 'workflow.create',
    commandId: 'rules-wf',
    input: {
      name: '研发',
      stages: [{ name: '待办', entryMode: 'agent', agentId: agent.id }],
    },
  })
  const workflow = must(store.query('workflows.all')[0], '工作流')
  return {
    workflowId: workflow.id,
    stageId: must(workflow.stages[0], '阶段').id,
    agentId: agent.id,
  }
}

const cronRule = (workflowId: string): AutomationRule => ({
  id: 'rule-cron',
  name: '每日早报',
  when: { cron: '0 9 * * *' },
  to: { workflowId },
  enabled: true,
})

const githubRule = (workflowId: string): AutomationRule => ({
  id: 'rule-github',
  name: 'Issue 进研发',
  when: { source: 'github', types: ['issues.opened'] },
  to: { workflowId, task: { labels: ['bug'] } },
  enabled: true,
})

/** 外部事件输入（宿主输入，不经命令路由）：字段与 `protocol/inputs` 的 RawEvent 一致。 */
const eventInput = (subject: string) => ({
  type: 'event.received',
  event: { source: 'github', type: 'issues.opened', subject },
  hops: 1,
})

describe('规则投影：rules.replace / event.received / clock.tick', () => {
  it('rules.replace：版本 +1、rule_sets 单行写入，rules.all 立即可读', () => {
    const { db, store } = world()
    const { workflowId } = seedWorkflow(store)
    const rules = [cronRule(workflowId), githubRule(workflowId)]

    const result = store.dispatch({ type: 'rules.replace', commandId: 'rules-1', rules })
    expect(result.facts.map((fact) => fact.type)).toEqual(['rules.replaced'])
    const payload = result.facts[0]?.payload as {
      ruleSet: { id: string; version: number; replacedAt: string; rules: AutomationRule[] }
    }
    expect(payload.ruleSet).toEqual({
      id: 'current',
      version: 1,
      replacedAt: AT,
      rules,
    })

    // 读路径与投影逐字一致（rules_json 存完整规则清单）
    expect(store.query('rules.all')).toEqual({ version: 1, rules })
    expect(db.prepare('SELECT id, version, replaced_at, rules_json FROM rule_sets').get()).toEqual({
      id: 'current',
      version: 1,
      replaced_at: AT,
      rules_json: JSON.stringify(rules),
    })
  })

  it('event.received：命中规则建任务 + 入口 run；同 externalRef 第二次事件只入账', () => {
    const { db, store } = world()
    const { workflowId, stageId, agentId } = seedWorkflow(store)
    store.dispatch({
      type: 'rules.replace',
      commandId: 'rules-1',
      rules: [cronRule(workflowId), githubRule(workflowId)],
    })

    const first = store.dispatch(eventInput('issue-1'))
    expect(first.facts.map((fact) => fact.type)).toEqual([
      'event.received',
      // M6.5：事件归入新线程（opened + 事件引用），任务建好后挂进同一线程
      'thread.opened',
      'thread.event_attached',
      'task.created',
      'thread.task_attached',
      'run.queued',
    ])
    const eventId = (first.facts[0]?.payload as { eventId: string }).eventId

    const task = must(
      store
        .query('tasks.byWorkflow', { workflowId })
        .find((item) => item.externalRef === 'issue-1'),
      '规则任务',
    )
    expect(task).toMatchObject({
      origin: 'rule',
      ruleId: 'rule-github',
      externalRef: 'issue-1',
      currentStageId: stageId,
      labels: ['bug'],
    })

    const active = must(store.query('runs.active-by-task', { taskId: task.id })[0], '入口 run')
    expect(active).toMatchObject({ status: 'queued', taskId: task.id, stageId })
    const run = must(store.query('run.byId', { runId: active.id }), '入口 run 行')
    expect(run).toMatchObject({ agentId, ruleId: 'rule-github', rulesVersion: 1, hops: 1 })
    // run 的规则追溯列：ruleId / 版本 / 事件 id / 跳数
    expect(
      db
        .prepare('SELECT rule_id, rules_version, event_ids_json, hops FROM runs WHERE id = ?')
        .get(run.id),
    ).toEqual({
      rule_id: 'rule-github',
      rules_version: 1,
      event_ids_json: JSON.stringify([eventId]),
      hops: 1,
    })

    // 同 rule + 同 subject：事件照常入账；线程已存在 → 只挂事件引用，不新建任务，
    // 已有 queued run → event.merged 把事件并入该 run（D5）
    const second = store.dispatch(eventInput('issue-1'))
    expect(second.facts.map((fact) => fact.type)).toEqual([
      'event.received',
      'thread.event_attached',
      'event.merged',
    ])
    const secondEventId = (second.facts[0]?.payload as { eventId: string }).eventId
    const mergedRun = (
      second.facts.find((fact) => fact.type === 'event.merged')?.payload as {
        run: { id: string; eventIds: string[] }
      }
    ).run
    expect(mergedRun.id).toBe(active.id)
    expect(mergedRun.eventIds).toEqual([eventId, secondEventId])
    expect(
      store
        .query('tasks.byWorkflow', { workflowId })
        .filter((item) => item.ruleId === 'rule-github'),
    ).toHaveLength(1)
  })

  it('clock.tick：cron 到点建任务 + rule.fired，rule_fires 行与 rules.all 版本一致', () => {
    const { db, store, setNow } = world()
    const { workflowId } = seedWorkflow(store)
    const rules = [cronRule(workflowId), githubRule(workflowId)]
    store.dispatch({ type: 'rules.replace', commandId: 'rules-1', rules })

    setNow(CRON_AT)
    const tick = store.dispatch({ type: 'clock.tick' })
    expect(tick.facts.map((fact) => fact.type)).toEqual([
      // M6.5：cron 任务同样建隐式线程并挂进去
      'thread.opened',
      'thread.task_attached',
      'task.created',
      'run.queued',
      'rule.fired',
    ])

    const fired = must(
      tick.facts.find((fact) => fact.type === 'rule.fired'),
      'rule.fired 事实',
    )
    const fire = (fired.payload as { fire: RuleFireRow }).fire
    expect(fire).toMatchObject({
      ruleId: 'rule-cron',
      version: 1,
      scheduledFor: CRON_SCHEDULED,
      firedAt: CRON_AT,
    })

    const task = must(
      store.query('tasks.byWorkflow', { workflowId }).find((item) => item.ruleId === 'rule-cron'),
      'cron 任务',
    )
    expect(task).toMatchObject({
      title: '每日早报',
      origin: 'rule',
      ruleId: 'rule-cron',
      // cron 触发没有入口键（追溯靠 task.created 的 ruleId）
      externalRef: null,
    })
    expect(fire.taskId).toBe(task.id)

    expect(
      db
        .prepare('SELECT id, rule_id, version, scheduled_for, fired_at, task_id FROM rule_fires')
        .get(),
    ).toEqual({
      id: fire.id,
      rule_id: 'rule-cron',
      version: 1,
      scheduled_for: CRON_SCHEDULED,
      fired_at: CRON_AT,
      task_id: task.id,
    })
    // 版本不因触发变化
    expect(store.query('rules.all')).toEqual({ version: 1, rules })

    // 同一到点时刻再 tick：基线已前进到 scheduledFor，不重复触发
    expect(store.dispatch({ type: 'clock.tick' }).facts).toEqual([])
  })

  it('rebuild：规则事实的增量投影与重建逐表全等（含 rule_sets / rule_fires / tasks 新列）', () => {
    const { db, store, setNow } = world()
    const { workflowId } = seedWorkflow(store)
    store.dispatch({
      type: 'rules.replace',
      commandId: 'rules-1',
      rules: [cronRule(workflowId), githubRule(workflowId)],
    })
    store.dispatch(eventInput('issue-1'))
    store.dispatch(eventInput('issue-1')) // 同入口键：只入账
    store.dispatch(eventInput('issue-2'))
    setNow(CRON_AT)
    store.dispatch({ type: 'clock.tick' })

    const before = dumpProjection(db)
    // 先确认三类规则投影都有行，避免「空集对空集」式的假全等
    expect(before.rule_sets).toHaveLength(1)
    expect(before.rule_fires).toHaveLength(1)
    expect(before.tasks).toHaveLength(3) // issue-1 / issue-2 / 每日早报
    // dumpProjection 按 id（随机 UUID）排序，这里按来源集合比较，不依赖行顺序
    expect(
      (before.tasks as Array<{ origin: string; rule_id: string | null }>)
        .map((row) => `${row.origin}:${row.rule_id}`)
        .sort(),
    ).toEqual(['rule:rule-cron', 'rule:rule-github', 'rule:rule-github'])

    store.rebuild()
    expect(dumpProjection(db)).toEqual(before)

    // 重建后再显式核对一次关键行（不依赖 dumpProjection 的列清单）
    expect(db.prepare('SELECT version, replaced_at FROM rule_sets').get()).toEqual({
      version: 1,
      replaced_at: AT,
    })
    expect(
      db.prepare('SELECT rule_id, scheduled_for, task_id FROM rule_fires').get(),
    ).toMatchObject({ rule_id: 'rule-cron', scheduled_for: CRON_SCHEDULED })
  })
})
