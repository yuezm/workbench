/**
 * M7 webhook 来源 E2E：应用内配置插件（`plugin.set`，secret 走 safeStorage）→ 重启生效 →
 * 带 HMAC 的 POST 变成 `event.received` → 规则建任务。
 *
 * 步骤：
 * 1. 种子库种好目标工作流与事件规则（source=webhook / issues.opened）；
 * 2. 首次启动经桥 `plugin.set` 写 enabled/授权/端口/路径/secret（secret 只能由主进程加密）；
 * 3. 关闭应用后用同一 userData 重启：来源 hub 按设置启动回环监听；
 * 4. 带 `sha256=<hex(HMAC-SHA256(secret, `${timestamp}.${body}`))>` 的 POST → 200；
 *    坏签名 → 401 且不产事件；
 * 5. 断言库里 `event.received` 事实与规则任务（origin='rule'）。
 */
import { createHmac } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import type { PluginView } from '../../src/protocol/plugins'
import type { WorkbenchApi } from '../../src/shared/workbench-api'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import {
  readWebhookState,
  seedWebhookBase,
  WEBHOOK_E2E_PATH,
  WEBHOOK_E2E_PORT,
  WEBHOOK_E2E_SECRET,
  type WebhookSeed,
} from './helpers/seed-webhook'

let launched: LaunchedApp | undefined
let page: Page
let seed: WebhookSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

const endpoint = `http://127.0.0.1:${WEBHOOK_E2E_PORT}${WEBHOOK_E2E_PATH}`

/** 按 webhook 来源的签名口径构造请求头（时间戳 epoch 秒 + `${timestamp}.${body}`）。 */
function signedHeaders(body: string, secret = WEBHOOK_E2E_SECRET): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1_000))
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return {
    'content-type': 'application/json',
    'x-webhook-timestamp': timestamp,
    'x-webhook-signature': `sha256=${signature}`,
  }
}

test('webhook 来源：应用内配置 + 重启生效 → 合法 POST 产事件建任务，坏签名零事件', async () => {
  test.setTimeout(180_000)

  const userDataDir = createTempUserDataDir()
  seed = await seedWebhookBase(path.join(userDataDir, 'ai-workflow.db'))
  const seeded = seed

  // 1) 首次启动：经桥写插件设置（启用 + 授权 net + 端口/路径 + secret）
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')
  const saved = (await page.evaluate(async () => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    const result = await bridge.dispatch({
      type: 'plugin.set',
      commandId: 'e2e-webhook-configure',
      pluginId: 'webhook',
      enabled: true,
      granted: ['net'],
      config: { port: 47_699, path: '/e2e-webhook', toleranceSeconds: 300 },
      secrets: { secret: 'e2e-webhook-secret' },
    })
    return result.value as PluginView | null
  })) as PluginView | null
  expect(saved).toMatchObject({
    id: 'webhook',
    enabled: true,
    secretKeys: ['secret'],
  })
  // 视图不泄漏 secret 值
  expect(JSON.stringify(saved)).not.toContain(WEBHOOK_E2E_SECRET)

  // 2) 用同一 userData 重启：来源 hub 按设置启动回环监听
  await launched.close({ removeUserData: false })
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 监听就绪前不保证端口已 bind：轮询到成功为止
  const body = JSON.stringify({
    type: 'issues.opened',
    subject: 'e2e-webhook-1',
    summary: '来自 e2e',
  })
  await expect
    .poll(
      async () => {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: signedHeaders(body),
            body,
          })
          return response.status
        } catch {
          return 0
        }
      },
      { timeout: 20_000 },
    )
    .toBe(200)

  await expect
    .poll(() => readWebhookState(seeded.dbPath, seeded), { timeout: 15_000 })
    .toMatchObject({
      eventReceivedFacts: 1,
      taskCount: 1,
      taskTitle: 'e2e-webhook-1',
      origin: 'rule',
      ruleId: seeded.ruleId,
    })

  // 3) 坏签名：401 且不产事件、不建任务
  const badBody = JSON.stringify({ type: 'issues.opened', subject: 'e2e-webhook-bad' })
  const bad = await fetch(endpoint, {
    method: 'POST',
    headers: signedHeaders(badBody, 'wrong-secret'),
    body: badBody,
  })
  expect(bad.status).toBe(401)
  expect(readWebhookState(seeded.dbPath, seeded)).toMatchObject({
    eventReceivedFacts: 1,
    taskCount: 1,
  })
})
