import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'

let electronApp: ElectronApplication
let page: Page

test.beforeEach(async () => {
  electronApp = await electron.launch({ args: ['.'] })
  page = await electronApp.firstWindow()
})

test.afterEach(async () => {
  await electronApp.close()
})

/** 倒计时大数字（唯一匹配 mm:ss / mmm:ss 格式的文本） */
function timerText(): ReturnType<Page['getByText']> {
  return page.getByText(/^\d{2,3}:\d{2}$/)
}

async function readRemainingSeconds(): Promise<number> {
  const text = (await timerText().textContent()) ?? '0:00'
  const [minutes, seconds] = text.split(':').map(Number)
  return minutes * 60 + seconds
}

test('关键路径：开始 → 递减 → 暂停冻结 → 重置回 25:00', async () => {
  await expect(timerText()).toHaveText('25:00')
  await page.getByRole('button', { name: '开始' }).click()

  // 运行中：1.2s 后应已递减，再等 1.2s 继续递减
  await page.waitForTimeout(1_200)
  const first = await readRemainingSeconds()
  expect(first).toBeLessThan(25 * 60)
  await page.waitForTimeout(1_200)
  expect(await readRemainingSeconds()).toBeLessThan(first)

  // 暂停：读数冻结
  await page.getByRole('button', { name: '暂停' }).click()
  const frozen = await readRemainingSeconds()
  await page.waitForTimeout(1_200)
  expect(await readRemainingSeconds()).toBe(frozen)

  // 重置：回到初始 25:00，控制区回到「开始」
  await page.getByRole('button', { name: '重置' }).click()
  await expect(timerText()).toHaveText('25:00')
  await expect(page.getByRole('button', { name: '开始' })).toBeVisible()
})

test('设置面板：非法专注时长被状态机钳制（999 → 120）', async () => {
  await page.getByText('设置', { exact: true }).click()
  const focusInput = page.getByLabel('专注（分钟）')
  await expect(focusInput).toBeVisible()
  await expect(focusInput).toHaveValue('25')

  await focusInput.fill('999')
  await expect(focusInput).toHaveValue('120')
  await expect(timerText()).toHaveText('120:00')
})
