/**
 * 设置 → 智能体编辑弹窗的尺寸回归（BUG：提示词太长时页面高度异常、保存按钮点不到）。
 *
 * 缺陷现场：`Textarea` 基座带 `field-sizing-content`，弹窗高度跟着提示词长度走；
 * `DialogContent` 是 `fixed` + `translate` 居中且没有高度上限，几千字的提示词会把它撑到
 * 比视口还高，上下两端被裁到屏幕外（body 又被 Radix 锁住滚动），于是「编辑」等于打不开。
 *
 * 断言三件事：弹窗整体落在视口内、提示词框自己出滚动条、改名保存能走通。
 * 这三条在修复前都过不了（弹窗溢出 → 保存按钮不可见）。
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { writeFakeAgent } from './helpers/fake-agent'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { seedAgentBase } from './helpers/seed-agent'

let launched: LaunchedApp | undefined
let page: Page

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
})

/** 200 行提示词：旧实现会把弹窗撑到两屏以上 */
const LONG_PROMPT = Array.from(
  { length: 200 },
  (_, index) =>
    `第 ${String(index + 1).padStart(3, '0')} 条要求：先读代码再动手，改完跑 pnpm check。`,
).join('\n')

test('智能体编辑：超长提示词下弹窗不超视口，字段区自己滚，保存可点', async () => {
  test.setTimeout(120_000)

  const userDataDir = createTempUserDataDir()
  const workDir = path.join(userDataDir, 'work')
  mkdirSync(workDir, { recursive: true })

  await seedAgentBase(path.join(userDataDir, 'ai-workflow.db'), {
    command: writeFakeAgent(userDataDir),
    projectPath: workDir,
    agentName: 'test-engineer',
    systemPrompt: LONG_PROMPT,
  })

  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '智能体', exact: true }).click()
  await page.getByRole('button', { name: '编辑智能体 test-engineer' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // 提示词原样带进弹窗（编辑态不是空表单）
  await expect(page.getByLabel('智能体能力')).toHaveValue(LONG_PROMPT)

  // ① 弹窗整体在视口内：没有 `max-h` 时 y 会是负数、底边也会超出 innerHeight
  //    e2e 的 tsconfig 不带 DOM lib，页面内取值统一走字符串表达式
  const viewportHeight = (await page.evaluate('window.innerHeight')) as unknown as number
  const box = await dialog.boundingBox()
  expect(box).not.toBeNull()
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(viewportHeight + 0.5)

  // ② 提示词框自己滚：长文本不再参与弹窗整体高度
  const promptBox = (await page.evaluate(`(() => {
    const el = document.querySelector('textarea[aria-label="智能体能力"]')
    if (el === null) return null
    return { clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }
  })()`)) as unknown as { clientHeight: number; scrollHeight: number } | null
  expect(promptBox).not.toBeNull()
  expect(promptBox?.scrollHeight ?? 0).toBeGreaterThan(promptBox?.clientHeight ?? 0)

  // ③ 保存按钮在视口内且真能点：改名保存后弹窗关闭、清单换成新名字
  const saveButton = page.getByRole('button', { name: '保存' })
  await expect(saveButton).toBeInViewport()
  await page.getByLabel('智能体名称').fill('test-engineer-2')
  await saveButton.click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('test-engineer-2')).toBeVisible()
})
