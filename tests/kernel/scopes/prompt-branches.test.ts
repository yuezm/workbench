// @vitest-environment node
/**
 * 补回执提示词（`scopes/prompt.ts#receiptRepairText`）：阶段没有验收条目时不写「## 验收」段。
 *
 * 两种来源都要成立：老阶段行没这一列（`undefined`），以及新阶段行给了空数组。
 */
import { describe, expect, it } from 'vitest'
import type { WorkflowStage } from '@workbench/protocol/entities'
import { receiptRepairText } from '@workbench/kernel/scopes/prompt'

type StageSlice = Pick<WorkflowStage, 'name' | 'acceptance'>

describe('receiptRepairText：验收段只在真有条目时出现', () => {
  it('验收列缺失（老阶段行）：不写验收段', () => {
    const text = receiptRepairText({ name: '评审', acceptance: undefined } as unknown as StageSlice)
    expect(text).toContain('阶段「评审」上一轮没有给出闸门结论')
    expect(text).not.toContain('## 验收')
  })

  it('验收是空数组：同样不写验收段', () => {
    const text = receiptRepairText({ name: '评审', acceptance: [] })
    expect(text).not.toContain('## 验收')
  })

  it('有验收条目：按 1 基序号逐条列出来', () => {
    const text = receiptRepairText({ name: '评审', acceptance: ['跑通 pnpm test', '无 lint 报错'] })
    expect(text).toContain('## 验收')
    expect(text).toContain('1. 跑通 pnpm test')
    expect(text).toContain('2. 无 lint 报错')
  })
})
