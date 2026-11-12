import { expect, test, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp } from './helpers/launch'

let launched: LaunchedApp
let page: Page

test.beforeEach(async () => {
  launched = await launchApp()
  page = launched.page
})

test.afterEach(async () => {
  await launched.close()
})

/** 进设置 → 工作流，建一条只有四个内置阶段的工作流（顺序偏好才有东西可拖） */
async function createWorkflow(name: string): Promise<void> {
  await page.getByRole('button', { name: '新建工作流' }).click()
  await page.getByRole('menuitem', { name: '从空白创建工作流' }).click()
  await page.getByLabel('工作流名称').fill(name)
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
}

/** 清单当前次序（按行内「选择工作流」按钮的无障碍名读，跟视觉顺序一致） */
async function listOrder(): Promise<string[]> {
  return page
    .getByRole('button', { name: /^选择工作流 / })
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')?.replace('选择工作流 ', '') ?? ''),
    )
}

/**
 * 真实浏览器里的拖拽排序（渲染层排序走原生 HTML5 拖拽，jsdom 用例只能证明事件接线，
 * 这里用真鼠标证明「拖得动、落得下」）：整行可拖、松手占位、顺序进本地偏好并跨刷新保留。
 */
test('设置 → 工作流：整行拖拽调顺序，松手后占位并跨刷新保留', async () => {
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '工作流', exact: true }).click()

  await createWorkflow('甲流')
  await createWorkflow('乙流')
  await expect.poll(listOrder).toEqual(['甲流', '乙流'])

  // 从抓手拖到另一行：抓手在行内，拖拽由整行的 draggable 接管
  await page
    .getByRole('button', { name: '拖动排序：工作流 甲流' })
    .dragTo(page.getByRole('button', { name: '拖动排序：工作流 乙流' }))
  await expect.poll(listOrder).toEqual(['乙流', '甲流'])

  // 顺序是渲染层偏好（localStorage）：刷新后仍在
  await page.reload()
  await page.getByRole('button', { name: 'AI 工作流' }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await expect.poll(listOrder).toEqual(['乙流', '甲流'])
})
