/**
 * 界面几何审计 E2E：人工验收前的「对齐 / 溢出 / 遮挡」自动关。
 *
 * 为什么单独一条：`check:ui` 只看类名（圆角、色值、字阶、对比度），看不到渲染结果；
 * 「图标和文字差 2px 没对齐」「弹窗超出视口」「窄窗下横向滚动」只有人眼能发现，
 * 于是反复漏到人工验收。这里把可判定的几何缺陷变成断言，并输出逐屏报告
 * （`.scratch/acceptance/ui-geometry.md`），验收时照着报告看哪一屏有问题。
 *
 * 判据与排除理由见 `helpers/geometry.ts` 顶部注释。**不追求覆盖所有视觉问题**：
 * 只拦「明确是缺陷」的七类，宁少勿误报——误报会让人关掉这条用例。
 *
 * 场景用真实种子（`seedProjectDimension`：两个项目 / 两个任务 / 一个会话），
 * 因此看板卡片、聊天消息流、任务详情这些「有数据才撑得开」的布局也会被量到。
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { writeFakeAgent } from './helpers/fake-agent'
import {
  auditGeometry,
  formatFindings,
  GEOMETRY_PROBE_SCRIPT,
  GEOMETRY_REPORT_PATH,
  writeGeometryReport,
  type GeometryScene,
} from './helpers/geometry'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { seedProjectDimension } from './helpers/seed-agent'

let launched: LaunchedApp | undefined
let page: Page

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
})

/** 窄窗：验证「窗口不最大化时」布局是否还站得住（默认 1100x720） */
const NARROW = { width: 900, height: 640 }

test('界面几何审计：看板 / 聊天 / 任务详情 / 设置 / 弹窗 / 番茄钟 / 窄窗', async () => {
  test.setTimeout(240_000)

  const userDataDir = createTempUserDataDir()
  const dirA = path.join(userDataDir, 'a')
  const dirB = path.join(userDataDir, 'b')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  const command = writeFakeAgent(userDataDir)

  await seedProjectDimension(path.join(userDataDir, 'ai-workflow.db'), {
    command,
    dirA,
    dirB,
  })

  launched = await launchApp({ userDataDir })
  page = launched.page
  await expect(page).toHaveTitle('Workbench')

  const scenes: GeometryScene[] = []
  const audit = async (label: string): Promise<void> => {
    scenes.push({ label, findings: await auditGeometry(page) })
  }

  // 0) 审计器自检（防假绿）：注入四个**已知缺陷**的探针，审计器必须都能报出来。
  //    没有这一步，`findings = []` 既可能是界面干净，也可能是检测逻辑失效。
  await page.evaluate(GEOMETRY_PROBE_SCRIPT)
  const probeKinds = new Set((await auditGeometry(page)).map((item) => item.kind))
  await page.evaluate(`document.getElementById('__audit_probe')?.remove()`)
  expect(
    [...probeKinds].sort(),
    `审计器自检失败：注入的已知缺陷没被全部识别（识别到 ${[...probeKinds].join(',') || '无'}）`,
  ).toEqual(expect.arrayContaining(['clipped', 'overlap', 'row-misaligned', 'tiny-target']))

  // 1) 首屏：默认 app 是 AI 工作流，落在任务看板
  await expect(page.getByRole('heading', { name: 'AI 工作流' })).toBeVisible()
  await audit('首屏：任务看板')

  // 2) 新建任务弹窗（表单布局最容易错位：label 与输入框宽度、底部按钮行）
  await page.getByRole('button', { name: '新建任务' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await audit('弹窗：新建任务')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()

  // 3) 聊天栏目：会话清单 + 消息流 + 输入区
  await page.getByRole('button', { name: '聊天', exact: true }).click()
  await audit('聊天栏目（有会话）')

  // 4) 任务详情页：信息区 / 说明卡 / 活动流 / 底部动作区
  await page.getByRole('button', { name: '任务', exact: true }).click()
  await page.getByRole('button', { name: '任务：甲任务' }).click()
  await expect(page.getByRole('button', { name: '返回' })).toBeVisible()
  await audit('任务详情页')
  await page.getByRole('button', { name: '返回' }).click()

  // 5) 设置：五个栏目逐个量
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '设置栏目' })).toBeVisible()
  await audit('设置 / 运行时')

  // 运行时弹窗（字段最多的表单之一）
  await page.getByRole('button', { name: '新建运行时' }).click()
  await expect(page.getByLabel('运行时名称')).toBeVisible()
  await audit('弹窗：新建运行时')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('运行时名称')).toBeHidden()

  for (const section of ['智能体', '工作流', '规则', '插件'] as const) {
    await page.getByRole('button', { name: section, exact: true }).click()
    await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible()
    await audit(`设置 / ${section}`)
  }

  // 6) 番茄钟：大号数字与控件行
  await page.getByRole('button', { name: '返回工作台' }).click()
  await page.getByRole('button', { name: '番茄时钟' }).click()
  await expect(page.getByText('25:00', { exact: true })).toBeVisible()
  await audit('番茄钟')

  // 7) 窄窗：900x640 下看板与设置页不出现横向滚动 / 元素出界
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setSize(size.width, size.height)
  }, NARROW)
  await page.waitForFunction(`window.innerWidth <= ${NARROW.width}`, undefined, { timeout: 10_000 })
  await audit(`窄窗 ${NARROW.width}x${NARROW.height}：任务看板`)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await audit(`窄窗 ${NARROW.width}x${NARROW.height}：设置 / 运行时`)

  // 报告先落盘：断言失败时也能直接打开看是哪一屏哪一行
  writeGeometryReport(scenes, GEOMETRY_REPORT_PATH)

  const failed = scenes.filter((scene) => scene.findings.length > 0)
  const message = failed
    .map((scene) => `### ${scene.label}\n${formatFindings(scene.findings)}`)
    .join('\n\n')
  expect(failed, `界面几何问题（报告：${GEOMETRY_REPORT_PATH}）\n\n${message}`).toEqual([])
})
