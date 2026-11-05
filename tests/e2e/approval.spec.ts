/**
 * M4 审批 E2E（T10）：等待期零进程 / 回答续接 / 重复回答拒绝 / 卡片投递状态。
 *
 * 种子用真实 `openDatabase` + `createStore` 写「waiting run + open card + process_registry 空」，
 * 应用启动后走与生产完全相同的对账 / 通道补投路径；断言一律读临时 userData 里的库文件，
 * 不依赖真 CLI、不依赖外网、不动真实 %APPDATA%。
 *
 * 等待期断言：`lease_id` / `lease_until` / `deadline_at` / `usage_json` 为空、`process_registry`
 * 无行、`run_events` 不增——即「挂起期间没有子进程、没有 Token 消耗」。
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import type { AiWorkflowApi } from '../../src/shared/ai-workflow-api'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import {
  APPROVAL_SESSION_ID,
  readApprovalState,
  seedApprovalState,
  type ApprovalSeed,
} from './helpers/seed-approval'

let launched: LaunchedApp | undefined
let page: Page
let seed: ApprovalSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

test('审批等待期：租约已释放、无子进程、无 Token、回答续接与重复拒绝', async () => {
  // Windows 首次启动 + 通道补投，留足余量
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  seed = await seedApprovalState(path.join(userDataDir, 'ai-workflow.db'))
  const seeded = seed
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 1) 等待期：run 挂起、租约/超时/用量为空、无子进程、无帧
  await expect
    .poll(() => readApprovalState(seeded.dbPath, seeded.runId, seeded.cardId), { timeout: 15_000 })
    .toMatchObject({
      runStatus: 'waiting',
      leaseId: null,
      leaseUntil: null,
      deadlineAt: null,
      usageJson: null,
      turn: 1,
      sessionId: APPROVAL_SESSION_ID,
      resumeSessionId: null,
      processRegistryRows: 0,
      runEvents: seeded.runEvents,
    })
  expect(seeded.runEvents, '种子里等待期不应有帧').toBe(0)

  // 2) 经桥读 open 卡与 run（IPC 形状与种子一致）
  const openCards = await page.evaluate(() => {
    const bridge = (globalThis as unknown as { aiWorkflow: AiWorkflowApi }).aiWorkflow
    return bridge.cards.open()
  })
  expect(openCards.map((card) => card.id)).toContain(seeded.cardId)
  expect(openCards.find((card) => card.id === seeded.cardId)).toMatchObject({
    status: 'open',
    runId: seeded.runId,
    options: ['继续', '停止'],
  })

  const runs = await page.evaluate((taskId) => {
    const bridge = (globalThis as unknown as { aiWorkflow: AiWorkflowApi }).aiWorkflow
    return bridge.runs.listByTask(taskId)
  }, seeded.taskId)
  expect(runs).toHaveLength(1)
  expect(runs[0]).toMatchObject({
    id: seeded.runId,
    status: 'waiting',
    sessionId: APPROVAL_SESSION_ID,
    usage: null,
  })

  // 3) 经桥回答：卡变 answered，run 回到 queued 且续接同一会话、turn+1
  const answered = await page.evaluate((cardId) => {
    const bridge = (globalThis as unknown as { aiWorkflow: AiWorkflowApi }).aiWorkflow
    return bridge.cards.answer(cardId, 0)
  }, seeded.cardId)
  expect(answered).toMatchObject({ status: 'answered', optionIndex: 0, answeredBy: 'ui' })

  await expect
    .poll(() => readApprovalState(seeded.dbPath, seeded.runId, seeded.cardId), { timeout: 15_000 })
    .toMatchObject({
      runStatus: 'queued',
      turn: 2,
      resumeSessionId: APPROVAL_SESSION_ID,
      leaseId: null,
      leaseUntil: null,
      deadlineAt: null,
      usageJson: null,
      cardStatus: 'answered',
      cardOptionIndex: 0,
      cardAnsweredBy: 'ui',
    })
  // 续接后仍未执行：没有子进程、没有新帧（运行时在种子里已停用）
  expect(readApprovalState(seeded.dbPath, seeded.runId, seeded.cardId)).toMatchObject({
    processRegistryRows: 0,
    runEvents: seeded.runEvents,
  })

  const resumed = await page.evaluate((taskId) => {
    const bridge = (globalThis as unknown as { aiWorkflow: AiWorkflowApi }).aiWorkflow
    return bridge.runs.listByTask(taskId)
  }, seeded.taskId)
  expect(resumed[0]).toMatchObject({ status: 'queued', sessionId: APPROVAL_SESSION_ID })

  // 4) 重复回答：拒绝且不产生新 fact（card.answered / run.queued 计数不变）
  const before = readApprovalState(seeded.dbPath, seeded.runId, seeded.cardId)
  const second = await page.evaluate(async (cardId) => {
    const bridge = (globalThis as unknown as { aiWorkflow: AiWorkflowApi }).aiWorkflow
    try {
      await bridge.cards.answer(cardId, 0)
      return { rejected: false, message: '' }
    } catch (error) {
      return { rejected: true, message: error instanceof Error ? error.message : String(error) }
    }
  }, seeded.cardId)
  expect(second.rejected).toBe(true)
  expect(second.message).toContain('卡片已回答或已关闭')

  const after = readApprovalState(seeded.dbPath, seeded.runId, seeded.cardId)
  expect(after.answeredFacts).toBe(before.answeredFacts)
  expect(after.queuedFacts).toBe(before.queuedFacts)
  expect(after).toMatchObject({
    runStatus: 'queued',
    turn: 2,
    cardStatus: 'answered',
    cardOptionIndex: 0,
  })
})

test('卡片投递：pending 到 delivered，in-app 通道优先（不触发桌面通知）', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  seed = await seedApprovalState(path.join(userDataDir, 'ai-workflow.db'))
  const seeded = seed
  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 启动补投只投 `delivery='pending'` 的 open 卡；in-app 在注册表里排第一，收到即 ack，
  // 投递在首个成功通道处停止——因此不会走到 desktop 的 sdk.notify（不会真弹系统通知）。
  await expect
    .poll(() => readApprovalState(seeded.dbPath, seeded.runId, seeded.cardId).cardDelivery, {
      timeout: 20_000,
    })
    .toBe('delivered')

  const state = readApprovalState(seeded.dbPath, seeded.runId, seeded.cardId)
  expect(state.cardDeliveryRef).toBe('in-app')
  expect(state.cardStatus).toBe('open')
  // 投递不改变等待态：仍无子进程、无租约、无用量
  expect(state).toMatchObject({
    runStatus: 'waiting',
    leaseId: null,
    deadlineAt: null,
    usageJson: null,
    processRegistryRows: 0,
  })
})
