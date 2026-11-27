/**
 * 示例驱动脚本（也是这个 skill 自检用的那条 journey）：看板 → 新建任务 → 落库复查。
 *
 * 用法：
 *   node .agents/skills/verify/scripts/verify.mjs drive .agents/skills/verify/scripts/example-drive.mjs
 *
 * 脚本从 `export default` 拿到 ctx：`page / browser / url / artifacts / shot / api / sql / state`。
 * 只做一件事：用界面新建一张卡，再从库里复查它落在哪条工作流的哪一列。
 */
export default async function exampleDrive({ page, shot, sql }) {
  await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: 'AI 工作流' }).click()
  await page.getByRole('heading', { name: /工作流「/ }).waitFor()

  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('任务标题').fill('验收：新建任务')
  await dialog.getByLabel('任务描述').fill('由 verify harness 从弹窗新建')
  const dialogShot = await shot('new-task-dialog')

  await dialog.getByRole('button', { name: '创建' }).click()
  await page.getByRole('button', { name: '任务：验收：新建任务' }).waitFor()
  const boardShot = await shot('new-task-board')

  const rows = sql(
    `SELECT t.title AS title, w.name AS workflow, s.name AS stage, t.description AS description
     FROM tasks t
     JOIN workflows w ON w.id = t.workflow_id
     JOIN workflow_stages s ON s.id = t.current_stage_id
     WHERE t.title = ?`,
    ['验收：新建任务'],
  )

  return { dialogShot, boardShot, db: rows }
}
