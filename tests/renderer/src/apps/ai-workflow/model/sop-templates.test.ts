// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { validateStageSet } from '../../../../../../src/kernel/workflow/stage-validation'
import type { StageInput } from '../../../../../../src/protocol/entities'
import {
  SOP_TEMPLATES,
  draftFromTemplate,
  type SopTemplate,
} from '../../../../../../src/renderer/src/apps/ai-workflow/model/sop-templates'

/**
 * 开箱 SOP 模板（纯数据 + 纯函数）。
 *
 * 两件事守住：① `draftFromTemplate` 把阶段名换成合法下标；② 内置模板本身是
 * 「能保存的工作流」——用内核的 `validateStageSet` 复核一遍，避免模板与阶段校验漂移。
 */

const fixture = (): SopTemplate => ({
  id: 'fixture',
  name: '示例流',
  description: '示例',
  basis: '示例依据',
  stages: [
    { name: '甲', entryMode: 'agent', instructions: '做甲', agentRole: '编码型' },
    { name: '乙', entryMode: 'user', instructions: '看乙', onReject: '甲', agentRole: '人' },
    { name: '丙', entryMode: 'none', instructions: '等丙', onComplete: null, agentRole: '人' },
  ],
})

describe('draftFromTemplate', () => {
  it('阶段名换成下标，未给的流转目标为 null，交接/子任务字段留空', () => {
    const draft = draftFromTemplate(fixture())

    expect(draft.name).toBe('示例流')
    expect(draft.description).toBe('示例')
    // 模板只描述自己添加的阶段：四个内置阶段由草稿补齐
    expect(draft.stages.map((stage) => stage.name)).toEqual([
      '待办',
      '甲',
      '乙',
      '丙',
      '已阻塞',
      '已完成',
      '已取消',
    ])
    expect(draft.stages.filter((stage) => stage.builtin == null)).toEqual([
      {
        name: '甲',
        entryMode: 'agent',
        onCompleteIndex: null,
        onRejectIndex: null,
        handoffWorkflowId: null,
        handoffStageId: null,
        subtaskStageId: null,
        onChildrenSettled: null,
        spawnPolicy: null,
        instructions: '做甲',
        gate: null,
      },
      {
        name: '乙',
        entryMode: 'user',
        onCompleteIndex: null,
        // 「打回退回到甲」：甲排在待办之后，下标 1
        onRejectIndex: 1,
        handoffWorkflowId: null,
        handoffStageId: null,
        subtaskStageId: null,
        onChildrenSettled: null,
        spawnPolicy: null,
        instructions: '看乙',
        gate: null,
      },
      {
        name: '丙',
        entryMode: 'none',
        onCompleteIndex: null,
        onRejectIndex: null,
        handoffWorkflowId: null,
        handoffStageId: null,
        subtaskStageId: null,
        onChildrenSettled: null,
        spawnPolicy: null,
        instructions: '等丙',
        gate: null,
      },
    ])
  })

  it('草稿里的内置阶段按规范顺序补齐，且不带 id（保存时由内核分配）', () => {
    const draft = draftFromTemplate(fixture())
    expect(draft.stages.map((stage) => stage.builtin ?? null)).toEqual([
      'todo',
      null,
      null,
      null,
      'blocked',
      'done',
      'cancelled',
    ])
    for (const stage of draft.stages) {
      expect(stage.id, `${stage.name} 不该带 id`).toBeUndefined()
    }
  })

  it('引用不存在的阶段名按默认处理（null），不产出越界下标', () => {
    const template: SopTemplate = {
      ...fixture(),
      stages: [
        {
          name: '甲',
          entryMode: 'none',
          instructions: 'x',
          onComplete: '不存在的阶段',
          agentRole: '',
        },
        { name: '乙', entryMode: 'none', instructions: 'y', onReject: '也不存在', agentRole: '' },
      ],
    }

    const draft = draftFromTemplate(template)
    const user = draft.stages.filter((stage) => stage.builtin == null)

    expect(user.map((stage) => stage.onCompleteIndex)).toEqual([null, null])
    expect(user.map((stage) => stage.onRejectIndex)).toEqual([null, null])
  })

  it('模板阶段带 id 时不复制 id（模板永远是新工作流）', () => {
    const draft = draftFromTemplate(fixture())
    expect(draft.stages.every((stage) => stage.id === undefined)).toBe(true)
  })
})

describe('SOP_TEMPLATES', () => {
  it('至少四条且覆盖产品/研发/测试/发版四个域', () => {
    expect(SOP_TEMPLATES.length).toBeGreaterThanOrEqual(4)
    const ids = SOP_TEMPLATES.map((template) => template.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(
      expect.arrayContaining([
        'product-discovery',
        'dev-delivery',
        'testing-qa',
        'release-ops',
        'incident-postmortem',
        'sprint-retro',
      ]),
    )
  })

  it('每条模板结构完整：4–7 个阶段、阶段名唯一、说明与依据非空', () => {
    for (const template of SOP_TEMPLATES) {
      expect(template.name, `${template.id} 缺名称`).not.toBe('')
      expect(template.description, `${template.id} 缺适用场景`).not.toBe('')
      expect(template.basis, `${template.id} 缺方法论依据`).not.toBe('')
      expect(template.stages.length, `${template.id} 阶段数超界`).toBeGreaterThanOrEqual(4)
      expect(template.stages.length, `${template.id} 阶段数超界`).toBeLessThanOrEqual(7)

      const names = template.stages.map((stage) => stage.name)
      expect(new Set(names).size, `${template.id} 阶段名重复`).toBe(names.length)
      for (const stage of template.stages) {
        expect(stage.name, `${template.id} 有空阶段名`).not.toBe('')
        expect(stage.instructions, `${template.id}/${stage.name} 没有「要干什么」`).not.toBe('')
        expect(stage.agentRole, `${template.id}/${stage.name} 没给智能体建议`).not.toBe('')
      }
    }
  })

  it('流向只引用本模板内的阶段，且不指向自己', () => {
    for (const template of SOP_TEMPLATES) {
      const names = new Set(template.stages.map((stage) => stage.name))
      for (const stage of template.stages) {
        for (const target of [stage.onComplete, stage.onReject]) {
          if (target == null) continue
          expect(names, `${template.id}/${stage.name} 指向不存在的阶段 ${target}`).toContain(target)
          expect(target, `${template.id}/${stage.name} 流转指向自己`).not.toBe(stage.name)
        }
      }
    }
  })

  it('每条模板都含「需要人拍板」的阶段，且至少两个阶段交给智能体', () => {
    for (const template of SOP_TEMPLATES) {
      const modes = template.stages.map((stage) => stage.entryMode)
      expect(modes, `${template.id} 没有等人拍板的阶段`).toContain('user')
      expect(
        modes.filter((mode) => mode === 'agent').length,
        `${template.id} 交给智能体的阶段太少`,
      ).toBeGreaterThanOrEqual(2)
    }
  })

  it('生成的草稿能通过内核的阶段校验（绑定智能体后）', () => {
    for (const template of SOP_TEMPLATES) {
      const draft = draftFromTemplate(template)
      // 模板不替用户绑定智能体；校验前补一个占位 agentId，验证的是结构与流向
      const bound: StageInput[] = draft.stages.map((stage) =>
        stage.entryMode === 'agent' ? { ...stage, agentId: 'agent-1' } : stage,
      )
      expect(validateStageSet(bound), `${template.id} 生成的草稿不合法`).toBeNull()
    }
  })
})
