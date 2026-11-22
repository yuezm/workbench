#!/usr/bin/env node
/**
 * 提交前的闸门：工作区还有没有遗留物。`npm run git:clean`
 *
 * 退出码就是结论（工作台的脚本闸门只认退出码）：
 *   0 = 干净，可以进推送阶段
 *   1 = 有遗留物（未提交、未跟踪、在途操作），停下来等人清
 *   2 = 环境问题（不在 git 仓库 / git 不可用），同样不放行
 *
 * 为什么用退出码而不是让人读输出：闸门结论必须是进程事实，不能是「谁自报通过」。
 *
 * 参数：
 *   --allow-untracked  只忽略未跟踪文件（已跟踪文件的改动仍然拦）
 *   --json             失败时补一段回执块，留痕在任务详情里
 */
import { inspectWorkspace, listSection, problemsOf } from './lib.mjs'

const argv = process.argv.slice(2)
let allowUntracked = false
let wantJson = false
for (const arg of argv) {
  if (arg === '--allow-untracked') allowUntracked = true
  else if (arg === '--json') wantJson = true
  else if (arg === '-h' || arg === '--help') {
    console.log('用法：npm run git:clean [-- --allow-untracked] [-- --json]')
    process.exit(0)
  } else {
    console.error(`未知参数：${arg}`)
    process.exit(2)
  }
}

let state
try {
  state = inspectWorkspace(process.cwd())
} catch (error) {
  console.error(`[git:clean] 环境不满足：${error.message}`)
  process.exit(2)
}

const problems = problemsOf(state, { allowUntracked })

if (problems.length === 0) {
  // 通过不发通知：闸门放行不改变任何判断，弹一条「干净」只是噪音
  console.log(`[git:clean] 通过：${state.branch} @ ${state.head}`)
  console.log(
    state.upstream === null
      ? '[git:clean] 该分支还没有 upstream（推送阶段会建）'
      : `[git:clean] upstream ${state.upstream}：待推 ${state.ahead} 个提交，落后 ${state.behind} 个`,
  )
  if (state.untracked.length > 0) {
    console.log(`[git:clean] 忽略 ${state.untracked.length} 个未跟踪文件（--allow-untracked）`)
  }
  process.exit(0)
}

console.log(`[git:clean] 未通过：${state.branch} @ ${state.head}`)
for (const problem of problems) console.log(`  · ${problem}`)
const sections = [
  listSection('已暂存未提交', state.staged),
  listSection('已改动未暂存', state.unstaged),
  listSection('未跟踪文件', state.untracked),
].filter((section) => section !== '')
if (sections.length > 0) console.log(`\n${sections.join('\n\n')}`)
console.log(
  '\n[git:clean] 处理方式：提交它们、删掉不该留的文件，或确认后加 --allow-untracked 只忽略未跟踪文件，然后重跑。',
)

if (wantJson) {
  console.log('\n```json')
  console.log(JSON.stringify({ notices: [`git:clean 未通过：${problems.join('；')}`] }, null, 2))
  console.log('```')
}
process.exit(1)
