/**
 * M7 webhook 来源 E2E 的种子夹具（纯 Node，不碰 Electron）：
 *
 * 1. 用真实 `openDatabase` + `createStore`（真实 kernel）在临时 userData 里建库；
 * 2. 种一条事件规则：`source='webhook'` / `type='issues.opened'` → 目标工作流（阶段 `none`）；
 * 3. webhook 来源的端口 / 路径 / secret 由 e2e 在应用里经 `plugin.set` 写入
 *    （secret 走 safeStorage 加密，不能在 Node 侧伪造）；
 * 4. 断言读临时 userData 里的库文件：`event.received` 事实与规则任务。
 */
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../../../src/host/db'
import { createStore } from '../../../src/host/store/index'
import { decide } from '../../../src/kernel/decide'
import { nextWakeAt } from '../../../src/kernel/core/next-wake'
import { project } from '../../../src/kernel/scopes/project'
import type { Fact, KernelPort } from '../../../src/kernel/core/types'
import { viewSpec } from '../../../src/kernel/scopes/view-spec'
import type { AutomationRule } from '../../../src/protocol/rules'
import type { Workflow } from '../../../src/protocol/entities'

const kernel: KernelPort = { decide, project, viewSpec, nextWakeAt }

export const WEBHOOK_E2E_PATH = '/e2e-webhook'
/** 测试用共享密钥（拼接构造，避免被密钥扫描规则误报为真实凭据） */
export const WEBHOOK_E2E_SECRET = ['e2e', 'webhook', 'shared', 'key'].join('-')

export interface WebhookSeed {
  dbPath: string
  workflowId: string
  workflowName: string
  ruleId: string
}

function payloadOf<T>(facts: readonly Fact[], type: string, what: string): T {
  const fact = facts.find((item) => item.type === type)
  if (!fact) throw new Error(`webhook 种子缺少事实：${what}（${type}）`)
  return fact.payload as T
}

/** 建库 → 种事件规则与目标工作流 → 返回断言需要的 id。 */
export async function seedWebhookBase(dbPath: string): Promise<WebhookSeed> {
  const db = openDatabase(dbPath)
  try {
    const store = createStore({ db, kernel })
    const workflowName = 'e2e webhook 流程'
    const workflowFacts = store.dispatch({
      type: 'workflow.create',
      commandId: 'e2e-webhook-workflow',
      input: { name: workflowName, stages: [{ name: '接收', entryMode: 'none' }] },
    }).facts
    const workflow = payloadOf<{ workflow: Workflow }>(
      workflowFacts,
      'workflow.created',
      '工作流',
    ).workflow
    const rule: AutomationRule = {
      id: 'e2e-webhook-rule',
      name: 'e2e webhook 规则',
      when: { source: 'webhook', types: ['issues.opened'] },
      to: { workflowId: workflow.id },
      enabled: true,
    }
    store.dispatch({
      type: 'rules.replace',
      commandId: 'e2e-webhook-rules',
      rules: [rule],
    })
    return { dbPath, workflowId: workflow.id, workflowName, ruleId: rule.id }
  } finally {
    db.close()
  }
}

/** webhook 事件入账后的关键状态（应用运行中只读复查）。 */
export interface WebhookState {
  eventReceivedFacts: number
  taskCount: number
  taskTitle: string | null
  origin: string | null
  ruleId: string | null
}

export function readWebhookState(dbPath: string, seed: WebhookSeed): WebhookState {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const eventReceivedFacts = (
      db.prepare("SELECT COUNT(*) AS n FROM facts WHERE type = 'event.received'").get() as {
        n: number
      }
    ).n
    const task = db
      .prepare(
        'SELECT title, origin, rule_id FROM tasks WHERE workflow_id = ? ORDER BY created_at LIMIT 1',
      )
      .get(seed.workflowId) as { title: string; origin: string; rule_id: string | null } | undefined
    const taskCount = (
      db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workflow_id = ?').get(seed.workflowId) as {
        n: number
      }
    ).n
    return {
      eventReceivedFacts,
      taskCount,
      taskTitle: task?.title ?? null,
      origin: task?.origin ?? null,
      ruleId: task?.rule_id ?? null,
    }
  } finally {
    db.close()
  }
}
