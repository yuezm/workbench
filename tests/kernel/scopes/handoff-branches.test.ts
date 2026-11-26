// @vitest-environment node
/**
 * 派单目标语义校验（`scopes/handoff.ts#validateStageHandoffs`）：不给阶段 = 派到目标工作流的默认落点。
 *
 * 这一支必须放行——「只给工作流、由目标决定落在哪个阶段」是最常见的配置形态。
 */
import { describe, expect, it } from 'vitest'
import type { StageInput, Workflow } from '@workbench/protocol/entities'
import { validateStageHandoffs } from '@workbench/kernel/scopes/handoff'
import { emptyView } from '../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'

const workflow = (id: string): Workflow => ({
  id,
  name: id,
  description: '',
  createdAt: CREATED,
})

const stageInput = (over: Record<string, unknown> = {}): StageInput =>
  ({ name: '实现', entryMode: 'agent', agentId: 'ag-1', ...over }) as unknown as StageInput

describe('validateStageHandoffs：派单不指定阶段', () => {
  it('只给目标工作流：合法（落点由目标工作流的默认阶段决定）', () => {
    expect(
      validateStageHandoffs(
        emptyView({ workflows: new Map([['wf-2', workflow('wf-2')]]) }),
        'wf-1',
        [stageInput({ handoffs: [{ on: 'done', workflowId: 'wf-2', stageId: null }] })],
      ),
    ).toBeNull()
  })

  it('目标工作流不存在：说清楚是哪个', () => {
    expect(
      validateStageHandoffs(emptyView(), 'wf-1', [
        stageInput({ handoffs: [{ on: 'done', workflowId: 'wf-9', stageId: null }] }),
      ]),
    ).toBe('阶段「实现」的派单目标工作流不存在: wf-9')
  })
})
