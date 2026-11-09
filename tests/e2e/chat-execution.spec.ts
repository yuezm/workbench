/**
 * 聊天闭环 E2E：**真实子进程执行**。
 *
 * 与既有 e2e（只读库、不起进程）不同，这里让应用真的 spawn 一个子进程：
 * 运行时走 `command` 执行器插件 → 命令是假智能体脚本 → 提示词只经 stdin 传给子进程。
 * 覆盖的是「界面发消息 → 命令 → 内核 → 调度器 → spawn → 帧 → 回执 → 消息落库 → 界面回显」
 * 这条最核心的链路，中间没有任何一环被绕过。
 *
 * 断言口径：
 * - 助手消息确实落库，且正文带假智能体标记（证明子进程真的回话了）；
 * - 正文里的提示词字数 > 0（证明提示词真的送进了子进程，不只是「进程跑起来了」）；
 * - 聊天 run 终态 succeeded，输出与助手消息一致；
 * - 界面上能看到这条回复。
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { WorkbenchApi } from '../../src/shared/workbench-api'
import { FAKE_AGENT_MARKER, writeFakeAgent } from './helpers/fake-agent'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { readAgentState, seedAgentBase, type AgentSeed } from './helpers/seed-agent'

let launched: LaunchedApp | undefined
let page: Page
let seed: AgentSeed | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
  seed = undefined
})

test('聊天闭环：发消息 → 真实子进程执行 → 助手回复落库并回显到会话流', async () => {
  test.setTimeout(180_000)

  const userDataDir = createTempUserDataDir()
  // 项目目录同时是这一轮的执行工作目录（必须真实存在）
  const workDir = path.join(userDataDir, 'work')
  mkdirSync(workDir, { recursive: true })
  const command = writeFakeAgent(userDataDir)

  seed = await seedAgentBase(path.join(userDataDir, 'ai-workflow.db'), {
    command,
    projectPath: workDir,
  })
  const seeded = seed

  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  // 进 AI 工作流（默认停在番茄钟）
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await expect(page.getByRole('heading', { name: 'AI 工作流' })).toBeVisible()

  // 新建对话 → 输入 → 发送（走真实界面，不经桥）
  await page.getByRole('button', { name: '新对话' }).click()
  const input = page.getByLabel('消息输入')
  await expect(input).toBeVisible()
  await input.fill('请把这段需求拆成三步')
  await page.getByRole('button', { name: '发送' }).click()

  // 用户消息立即落库；助手消息要等子进程回话
  await expect
    .poll(() => readAgentState(seeded.dbPath).messages.length, { timeout: 90_000 })
    .toBeGreaterThanOrEqual(2)

  const state = readAgentState(seeded.dbPath)
  const userMessage = state.messages.find((message) => message.role === 'user')
  const assistantMessage = state.messages.find((message) => message.role === 'assistant')
  expect(userMessage?.content).toContain('请把这段需求拆成三步')
  expect(assistantMessage?.content).toContain(FAKE_AGENT_MARKER)
  expect(assistantMessage?.error ?? null).toBeNull()

  // 提示词确实送进了子进程：正文里的字数 > 0
  const chars = /已收到 (\d+) 字提示词/.exec(assistantMessage?.content ?? '')
  expect(chars).not.toBeNull()
  expect(Number(chars?.[1] ?? '0')).toBeGreaterThan(0)

  // 聊天 run 终态成功，输出与助手消息一致
  const chatRun = state.runs.find((run) => run.purpose === 'chat')
  expect(chatRun?.status).toBe('succeeded')
  expect(chatRun?.error ?? null).toBeNull()
  expect(chatRun?.output).toContain(FAKE_AGENT_MARKER)
  expect(chatRun?.conversationId).not.toBeNull()

  // 界面回显：助手消息出现在会话流里
  await expect(page.getByText(FAKE_AGENT_MARKER)).toBeVisible()

  // 经桥复查：会话与消息视图口径一致（不是只在库里落库、界面没跟上）
  // 会话落在当前选中的项目下（应用启动时选中第一个项目），不是默认目录
  const conversations = await page.evaluate((projectId) => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge.query('conversations.byProject', { projectId })
  }, seeded.projectId)
  expect(conversations.length).toBeGreaterThan(0)
  const conversationId = chatRun?.conversationId ?? ''
  const messages = await page.evaluate((id) => {
    const bridge = (globalThis as unknown as { workbench: WorkbenchApi }).workbench
    return bridge.query('messages.byConversation', { conversationId: id })
  }, conversationId)
  expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  expect(messages[1].content).toContain(FAKE_AGENT_MARKER)
})
