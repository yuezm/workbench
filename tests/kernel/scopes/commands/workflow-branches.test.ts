// @vitest-environment node
/**
 * 工作流保存（`scopes/commands/workflow.ts`）：出口表深比较、内置阶段原样还原、
 * 脚本配置比较。
 *
 * 深比较决定「要不要落 `stage.updated`」——比漏了会让改动被静默吞掉，比多了会每天抖一条事实，
 * 所以两个方向都要钉：缺一列视为同值、真改了必须不同值。
 */
import { describe, expect, it } from 'vitest'
import type { StageInput, Workflow, WorkflowStage } from '@workbench/protocol/entities'
import { sameExits, stageRow, updateWorkflow } from '@workbench/kernel/scopes/commands/workflow'
import { validateStageSet } from '@workbench/kernel/scopes/workflow/stage-validation'
import { TEST_AT, emptyView, testEnv } from '../../../support/kernel-view'

const CREATED = '2026-11-20T09:00:00.000Z'

const workflow = (): Workflow => ({
  id: 'wf-1',
  name: '研发',
  description: '',
  createdAt: CREATED,
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  id: 'st-todo',
  workflowId: 'wf-1',
  name: '待办',
  position: 0,
  entryMode: 'none',
  agentId: null,
  script: null,
  exits: {},
  handoffs: [],
  subtaskStageId: null,
  onChildrenSettled: null,
  spawnPolicy: null,
  instructions: '',
  acceptance: [],
  runTimeoutMs: null,
  judge: null,
  builtin: 'todo',
  ...over,
})

describe('sameExits：缺省一侧按空表', () => {
  it('一侧没有出口表：与空表比较（有内容就不同值）', () => {
    expect(sameExits(undefined, { done: { do: 'await' } })).toBe(false)
    expect(sameExits({ done: { do: 'await' } }, undefined)).toBe(false)
    expect(sameExits(undefined, undefined)).toBe(true)
  })

  it('两侧都有：动作相同才算同值（goto 还要比目标）', () => {
    expect(sameExits({ done: { do: 'await' } }, { done: { do: 'await' } })).toBe(true)
    expect(sameExits({ done: { do: 'await' } }, { done: { do: 'close' } })).toBe(false)
    expect(
      sameExits(
        { done: { do: 'goto', stageId: 'st-1' } },
        { done: { do: 'goto', stageId: 'st-2' } },
      ),
    ).toBe(false)
  })

  it('只有一侧有这一组：不同值；两侧都显式 undefined 视为同值', () => {
    expect(sameExits({ done: { do: 'await' } }, {})).toBe(false)
    expect(sameExits({}, { done: undefined })).toBe(true)
  })
})

describe('updateWorkflow：老阶段行缺列', () => {
  /** 三阶段工作流：待办（内置）/ 跑脚本 / 已阻塞（内置，老行缺 notifyOnPark 与 steps）。 */
  const baseView = (scriptSteps: WorkflowStage['script']) =>
    emptyView({
      workflows: new Map([['wf-1', workflow()]]),
      runtimes: new Map([
        [
          'rt-1',
          {
            id: 'rt-1',
            name: '本机命令',
            executorKey: 'command',
            argsTemplate: '',
            command: 'echo',
            profile: 'default',
            enabled: true,
            createdAt: CREATED,
            lastProbe: null,
          },
        ],
      ]),
      stages: new Map([
        ['st-todo', stage()],
        [
          'st-script',
          stage({
            id: 'st-script',
            name: '跑门禁',
            position: 1,
            entryMode: 'script',
            builtin: null,
            script: scriptSteps,
          }),
        ],
        [
          'st-blocked',
          stage({
            id: 'st-blocked',
            name: '已阻塞',
            position: 2,
            entryMode: 'user',
            builtin: 'blocked',
            exits: { errored: { do: 'await' } },
            // 老行：M55 之前没有这一列
            notifyOnPark: undefined,
          }),
        ],
      ]),
    })

  const submit = (view: ReturnType<typeof baseView>, script: Record<string, unknown>) =>
    updateWorkflow(
      view,
      {
        type: 'workflow.update',
        commandId: 'c-1',
        id: 'wf-1',
        input: {
          name: '研发',
          stages: [
            { id: 'st-todo', name: '待办', entryMode: 'none' } as unknown as StageInput,
            {
              id: 'st-script',
              name: '跑门禁',
              entryMode: 'script',
              script,
            } as unknown as StageInput,
          ],
        },
      } as unknown as Parameters<typeof updateWorkflow>[1],
      TEST_AT,
      testEnv(),
    )

  it('脚本步骤两边都缺列：按空步骤比较（同值，不抖动落事实）', () => {
    const view = baseView({
      runtimeId: 'rt-1',
      steps: undefined as unknown as [],
      cwd: null,
      env: {},
      timeoutMs: null,
    })
    const decision = submit(view, { runtimeId: 'rt-1', cwd: null, env: {}, timeoutMs: null })
    expect(decision.facts.some((fact) => fact.type === 'stage.updated')).toBe(false)
  })

  it('脚本步骤数不同：判为不同值，落 stage.updated', () => {
    const view = baseView({
      runtimeId: 'rt-1',
      steps: undefined as unknown as [],
      cwd: null,
      env: {},
      timeoutMs: null,
    })
    const decision = submit(view, {
      runtimeId: 'rt-1',
      cwd: null,
      env: {},
      timeoutMs: null,
      steps: [{ label: '测试', args: ['pnpm', 'test'] }],
    })
    const updated = decision.facts
      .filter((fact) => fact.type === 'stage.updated')
      .map((fact) => (fact.payload as { stage: WorkflowStage }).stage.id)
    expect(updated).toEqual(['st-script'])
  })
})

/**
 * `stageRow` 的两条兜底归一：保存前 `validateStageSet` 会挡掉这两种输入（脚本阶段没配脚本、
 * `goto` 下标越界），所以它们在产品路径上不可达。
 *
 * 两条一起钉，才算把「拒绝」与「容忍」都钉住：上游（`validateStageSet`）必须有测试证明它
 * 真的挡住，否则这组用例只证明了归一器容忍畸形输入——校验器哪天被放松，谁都发现不了。
 */
describe('stageRow：畸形入参归一', () => {
  it('这两种输入本来就过不了校验（产品路径上到不了归一器）', () => {
    expect(validateStageSet([{ name: ' 跑门禁 ', entryMode: 'script' }])).toContain('脚本')
    expect(
      validateStageSet([
        {
          name: '实现',
          entryMode: 'none',
          exits: [{ on: 'done', do: 'goto', stageIndex: 9 }],
        },
      ]),
    ).toContain('目标越界')
  })

  it('脚本阶段没配脚本：script 归成 null（不落半截形状）', () => {
    const input: StageInput = { name: ' 跑门禁 ', entryMode: 'script' }
    const row = stageRow('wf-1', 'st-1', ['st-a'], input, 0, null)
    expect(row.script).toBeNull()
    expect(row.name).toBe('跑门禁')
    expect(row.agentId).toBeNull()
  })

  it('goto 下标越界：这一组去向直接跳过，出口表只剩配得上的那些', () => {
    const input: StageInput = {
      name: '实现',
      entryMode: 'none',
      exits: [
        { on: 'done', do: 'goto', stageIndex: 9 },
        { on: 'errored', do: 'goto', stageIndex: 1 },
        { on: 'failed', do: 'await' },
      ],
    }
    const row = stageRow('wf-1', 'st-1', ['st-a', 'st-b'], input, 0, null)
    expect(row.exits).toEqual({
      errored: { do: 'goto', stageId: 'st-b' },
      failed: { do: 'await' },
    })
  })
})
