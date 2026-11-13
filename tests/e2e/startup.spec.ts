/**
 * 启动健康 E2E：人工验收的第一关「打开不报错」。
 *
 * 覆盖三条真实启动路径（每条都必须零未捕获异常、零控制台 error、零兜底页）：
 *
 * 1. **冷启动**：全新 userData → 建库、建投影、渲染首屏；
 * 2. **重载**：`page.reload()` 重跑整条渲染启动链（preload 已注入，shell 重新装配、重新订阅）；
 * 3. **二次冷启动**：同一份 userData 再启动一次——这是最容易坏的一条（老库补列、
 *    `KERNEL_VERSION` 指纹变化触发投影重建、单实例锁、残留 pid 对账），
 *    单测与打包冒烟都不覆盖「第二次打开已有数据的工作台」。
 *
 * 兜底页（`StartupFailure` / `ErrorBoundary`）与页面级错误条（`FormError`）都带
 * `role="alert"`，因此「没有任何 alert」同时等价于：桥接注入成功、渲染没炸、
 * 视图读没有失败——一屏空态出现读错误，验收时最容易被当成「就是空的」。
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { writeFakeAgent } from './helpers/fake-agent'
import { createTempUserDataDir, launchApp, type LaunchedApp } from './helpers/launch'
import { seedProjectDimension } from './helpers/seed-agent'

interface StartupErrors {
  console: string[]
  page: string[]
}

let launched: LaunchedApp | undefined

test.afterEach(async () => {
  await launched?.close()
  launched = undefined
})

/** 从这一刻起收集渲染进程的异常与控制台 error（`page.on` 只报之后发生的事） */
function collectErrors(page: Page): StartupErrors {
  const errors: StartupErrors = { console: [], page: [] }
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text())
  })
  page.on('pageerror', (error) => errors.page.push(error.message))
  return errors
}

function expectNoErrors(errors: StartupErrors, label: string): void {
  expect(errors.page, `${label}：渲染进程未捕获异常`).toEqual([])
  expect(errors.console, `${label}：控制台 error`).toEqual([])
}

/** 首屏必须是真界面：app 导航在、没有兜底页、没有错误条 */
async function expectHealthyShell(page: Page, label: string): Promise<void> {
  await expect(
    page.getByRole('navigation', { name: '应用导航' }),
    `${label}：顶部 app 导航`,
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'AI 工作流' }),
    `${label}：默认 app 首屏`,
  ).toBeVisible()
  await expect(page.getByText('界面没有加载成功'), `${label}：启动了兜底页`).toHaveCount(0)
  await expect(page.getByText('界面出错了'), `${label}：渲染被错误边界接住`).toHaveCount(0)
  // FormError（页面级错误条）、StartupFailure、ErrorBoundary 都带 role=alert
  await expect(page.getByRole('alert'), `${label}：页面上有错误条 / 兜底页`).toHaveCount(0)
}

test('启动健康：冷启动 / 重载 / 二次冷启动都零异常、零兜底页', async () => {
  test.setTimeout(180_000)

  const userDataDir = createTempUserDataDir()
  const projectDir = path.join(userDataDir, 'project')
  const projectDirB = path.join(userDataDir, 'project-b')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(projectDirB, { recursive: true })
  const command = writeFakeAgent(userDataDir)
  // 预置真实数据：第二次冷启动才有老库可迁移、有任务要投影
  await seedProjectDimension(path.join(userDataDir, 'ai-workflow.db'), {
    command,
    dirA: projectDir,
    dirB: projectDirB,
  })

  // ---- 1) 冷启动（带已有数据） ----
  const started = Date.now()
  launched = await launchApp({ userDataDir })
  const firstErrors = collectErrors(launched.page)
  await expect(launched.page).toHaveTitle('Workbench')
  await expectHealthyShell(launched.page, '冷启动')
  test.info().annotations.push({
    type: 'first-paint',
    description: `首屏就绪 ${Date.now() - started}ms`,
  })

  // ---- 2) 重载：整条渲染启动链重跑（收集器已就位，能完整捕获） ----
  await launched.page.reload()
  await expect(launched.page).toHaveTitle('Workbench')
  await expectHealthyShell(launched.page, '重载')
  expectNoErrors(firstErrors, '冷启动 + 重载')

  // 主进程还活着（未捕获异常会把 Electron 拉走，后续操作才暴雷）
  expect(launched.app.process().exitCode, '主进程提前退出').toBeNull()
  await launched.close({ removeUserData: false })
  launched = undefined

  // ---- 3) 二次冷启动：同一份 userData（老库补列 / 投影重建 / 单实例锁） ----
  const relaunched = await launchApp({ userDataDir })
  launched = relaunched
  const secondErrors = collectErrors(relaunched.page)
  await expect(relaunched.page).toHaveTitle('Workbench')
  await expectHealthyShell(relaunched.page, '二次冷启动')
  // 数据还在：预置的任务能读到（不是「空库重建成功」）
  await expect(relaunched.page.getByRole('button', { name: '任务：甲任务' })).toBeVisible()
  expectNoErrors(secondErrors, '二次冷启动')

  await launched.close()
  launched = undefined
})
