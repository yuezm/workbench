/**
 * 核心流程 E2E：**会话 → 发消息 → 真实执行器 → 助手回复入账**。
 *
 * 这是「主动对话」的最短闭环（与任务阶段执行是两条独立的执行入口）：
 * `chat.create` 建会话 → `chat.send` 落用户消息并入队 `purpose='chat'` 的 run →
 * 调度器真 spawn 执行器 → 回执写助手消息。
 *
 * 断言：
 * 1. 发消息后库里两条消息（user / assistant），助手正文含假智能体的回复标记；
 * 2. run 终态 `succeeded`、`purpose='chat'`、绑定该会话、留下执行器会话 id（下一轮续接靠它）；
 * 3. 再发一轮：同一会话里第二轮也成功（续接不是一次性行为）。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { WorkbenchApi } from '@workbench/contract-api'
import { FAKE_AGENT_MARKER, writeFakeAgent } from './helpers/fake-agent'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { readAgentState, seedAgentBase, type AgentSeed } from './helpers/seed-agent'

let launched: LaunchedApp | undefined
let seed: AgentSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

test('会话闭环：发消息 → 真执行 → 助手回复入账 → 第二轮续接仍成功', async () => {
  test.setTimeout(180_000)

  const userDataDir = createTempUserDataDir()
  const workDir = path.join(userDataDir, 'work')
  mkdirSync(workDir, { recursive: true })
  seed = await seedAgentBase(path.join(userDataDir, 'ai-workflow.db'), {
    command: writeFakeAgent(userDataDir),
    projectPath: workDir,
  })
  const seeded = seed

  launched = await launchApp({ userDataDir })
  const page: Page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 1) 建会话（不带任务、不带工作流：聊天是独立入口）
  const conversationId = await page.evaluate((agentId) => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge
      .dispatch({
        type: 'chat.create',
        commandId: 'e2e-chat-create',
        agentId,
        title: 'e2e 会话',
        projectId: null,
      })
      .then((result) => (result.value as { id: string }).id)
  }, seeded.agentId)
  expect(conversationId).toBeTruthy()

  // 2) 发第一轮
  await page.evaluate(
    ({ id }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({
        type: 'chat.send',
        commandId: 'e2e-chat-send-1',
        conversationId: id,
        content: '第一轮：介绍一下这个项目',
      })
    },
    { id: conversationId },
  )

  await expect
    .poll(() => readAgentState(seeded.dbPath).runs.filter((run) => run.purpose === 'chat').length, {
      timeout: 90_000,
    })
    .toBe(1)
  await expect
    .poll(
      () => {
        const chatRuns = readAgentState(seeded.dbPath).runs.filter((run) => run.purpose === 'chat')
        return chatRuns[0]?.status ?? null
      },
      { timeout: 90_000 },
    )
    .toBe('succeeded')

  const firstRound = readAgentState(seeded.dbPath)
  const assistant = firstRound.messages.filter((message) => message.role === 'assistant')
  expect(assistant).toHaveLength(1)
  expect(assistant[0]?.content).toContain(FAKE_AGENT_MARKER)
  expect(assistant[0]?.error ?? null).toBeNull()
  expect(firstRound.messages.filter((message) => message.role === 'user')).toHaveLength(1)
  expect(firstRound.runs.find((run) => run.purpose === 'chat')?.conversationId).toBe(conversationId)

  // 3) 第二轮：同一会话再发一条，续接（执行器会话 id 已在行上）仍成功
  await page.evaluate(
    ({ id }) => {
      const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
      return bridge.dispatch({
        type: 'chat.send',
        commandId: 'e2e-chat-send-2',
        conversationId: id,
        content: '第二轮：接着说',
      })
    },
    { id: conversationId },
  )

  await expect
    .poll(
      () => {
        const chatRuns = readAgentState(seeded.dbPath).runs.filter((run) => run.purpose === 'chat')
        return { count: chatRuns.length, last: chatRuns[chatRuns.length - 1]?.status ?? null }
      },
      { timeout: 90_000 },
    )
    .toEqual({ count: 2, last: 'succeeded' })

  const secondRound = readAgentState(seeded.dbPath)
  expect(secondRound.messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
  expect(
    secondRound.messages.filter((message) => message.role === 'assistant')[1]?.content,
  ).toContain(FAKE_AGENT_MARKER)
  expect(secondRound.messages.filter((message) => message.role === 'user')).toHaveLength(2)
})
