// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { validateStageSet } from '../../../../../../src/kernel/scopes/workflow/stage-validation'
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
        exits: [],
        handoffs: [],
        subtaskStageId: null,
        onChildrenSettled: null,
        spawnPolicy: null,
        acceptance: [],
        instructions: '做甲',
        judge: null,
      },
      {
        name: '乙',
        entryMode: 'user',
        // 「打回退回到甲」：甲排在待办之后，下标 1
        exits: [{ on: 'errored', do: 'goto', stageIndex: 1 }],
        handoffs: [],
        subtaskStageId: null,
        onChildrenSettled: null,
        spawnPolicy: null,
        acceptance: [],
        instructions: '看乙',
        judge: null,
      },
      {
        name: '丙',
        entryMode: 'none',
        exits: [],
        handoffs: [],
        subtaskStageId: null,
        onChildrenSettled: null,
        spawnPolicy: null,
        acceptance: [],
        instructions: '等丙',
        judge: null,
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

    // 引用不到的名字落成「未指定」（stageIndex null），不产出越界下标
    const exitsOf = (on: 'done' | 'errored'): unknown[] =>
      user.flatMap((stage) => (stage.exits ?? []).filter((exit) => exit.on === on))
    expect(exitsOf('done')).toEqual([{ on: 'done', do: 'goto', stageIndex: null }])
    expect(exitsOf('errored')).toEqual([{ on: 'errored', do: 'goto', stageIndex: null }])
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
        'testing-issue',
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
      // 模板不替用户绑定智能体；校验前给每个阶段补一个不同的占位 agentId：
      // M34 要求闸门的判定者 ≠ 被验阶段的执行者，模板自己不绑人，这里只要结构合法
      const bound: StageInput[] = draft.stages.map((stage, index) =>
        stage.entryMode === 'agent' ? { ...stage, agentId: `agent-${index}` } : stage,
      )
      expect(validateStageSet(bound), `${template.id} 生成的草稿不合法`).toBeNull()
    }
  })

  it('「要干什么」按目标 / 产出 / 边界三段写，不再是一份操作清单（M19）', () => {
    for (const template of SOP_TEMPLATES) {
      for (const stage of template.stages) {
        const text = stage.instructions
        expect(text, `${template.id}/${stage.name} 缺「### 目标」`).toContain('### 目标')
        expect(text, `${template.id}/${stage.name} 缺「### 产出」`).toContain('### 产出')
        expect(text, `${template.id}/${stage.name} 缺「### 边界」`).toContain('### 边界')
        // 验收是结构化字段，不塞进说明里（否则会与提示词里的验收段重复）
        expect(text, `${template.id}/${stage.name} 说明里不该再写验收段`).not.toContain('### 验收')
      }
    }
  })

  it('验收条目只挂在闸门阶段（M34）：执行阶段与人工阶段一律不带', () => {
    for (const template of SOP_TEMPLATES) {
      for (const stage of template.stages) {
        const items = stage.acceptance ?? []
        if (stage.gate) {
          expect(
            items.length,
            `${template.id}/${stage.name} 闸门没有验收条目`,
          ).toBeGreaterThanOrEqual(2)
          for (const item of items) {
            expect(item.trim(), `${template.id}/${stage.name} 有空验收条目`).not.toBe('')
          }
          const trimmed = items.map((item) => item.trim())
          expect(new Set(trimmed).size, `${template.id}/${stage.name} 验收条目重复`).toBe(
            trimmed.length,
          )
          continue
        }
        expect(items.length, `${template.id}/${stage.name} 非闸门阶段不该带验收条目`).toBe(0)
      }
    }
    // 至少有一条模板的闸门真的声明了判据，否则这套字段就成了摆设
    const withAcceptance = SOP_TEMPLATES.flatMap((template) => template.stages).filter(
      (stage) => stage.gate && (stage.acceptance ?? []).length > 0,
    )
    expect(withAcceptance.length).toBeGreaterThan(0)
  })

  it('研发交付按「澄清 → 实现 → 评审(闸门) → 人工验收 → 收尾」排，拆解交给 spawn（M19）', () => {
    const dev = SOP_TEMPLATES.find((template) => template.id === 'dev-delivery')
    expect(dev).toBeDefined()
    expect(dev!.stages.map((stage) => stage.name)).toEqual([
      '需求澄清',
      '编码实现',
      '代码评审',
      '人工验收',
      '合并归档',
    ])
    // 评审是闸门：未通过退回编码实现，不再单开一个人工阶段
    const review = dev!.stages.find((stage) => stage.name === '代码评审')
    expect(review?.entryMode).toBe('agent')
    expect(review?.gate).toEqual({ maxFails: 3, onFail: '编码实现' })
    // M34：编码实现的判据搬进紧接着的评审闸门；执行阶段自己不带验收
    const impl = dev!.stages.find((stage) => stage.name === '编码实现')
    expect(impl?.acceptance ?? []).toEqual([])
    expect(review?.acceptance ?? []).toContain('`pnpm check` 退出码 0')
    // 模板里没有「任务拆解」阶段：拆分归 Agent（SPEC-task-fanout D10）
    expect(dev!.stages.some((stage) => stage.name.includes('拆解'))).toBe(false)
  })

  it('模板里的闸门在草稿里落成判定者 + 出口表，两侧都能指到本模板的阶段', () => {
    for (const template of SOP_TEMPLATES) {
      const draft = draftFromTemplate(template)
      const names = draft.stages.map((stage) => stage.name)
      for (const stage of draft.stages) {
        const judge = stage.judge
        if (!judge) continue
        expect(
          judge.maxFails ?? 0,
          `${template.id}/${stage.name} 闸门次数不合法`,
        ).toBeGreaterThanOrEqual(1)
        for (const exit of stage.exits ?? []) {
          if (exit.do !== 'goto' || exit.stageIndex == null) continue
          expect(names[exit.stageIndex], `${template.id}/${stage.name} 闸门目标越界`).toBeDefined()
        }
      }
    }
  })

  it('测试质量压成五阶段：设计与执行合并，缺陷修复不进这条流水线', () => {
    const qa = SOP_TEMPLATES.find((template) => template.id === 'testing-qa')
    expect(qa).toBeDefined()
    expect(qa!.stages.map((stage) => stage.name)).toEqual([
      '测试设计',
      '执行测试',
      '缺陷定级',
      '回归验证',
      '验收确认',
    ])
    // 四个 agent 阶段 + 一处人工验收：人只在最后出现
    expect(qa!.stages.map((stage) => stage.entryMode)).toEqual([
      'agent',
      'agent',
      'agent',
      'agent',
      'user',
    ])
  })

  it('执行测试允许 Agent 自己拆并行子任务，出错退回测试设计', () => {
    const run = SOP_TEMPLATES.find((template) => template.id === 'testing-qa')!.stages.find(
      (stage) => stage.name === '执行测试',
    )
    expect(run?.spawnPolicy).toBe('agent')
    expect(run?.onReject).toBe('测试设计')
    // M34：执行阶段不带验收（判据在后面的闸门上），也不再设阶段内轮次
    expect(run?.acceptance ?? []).toEqual([])
  })

  it('缺陷定级在修复任务全部结终态后唤醒自己，再进回归验证', () => {
    const triage = SOP_TEMPLATES.find((template) => template.id === 'testing-qa')!.stages.find(
      (stage) => stage.name === '缺陷定级',
    )
    expect(triage?.onChildrenSettled).toBe('wake')
    expect(triage?.onComplete).toBe('回归验证')
  })

  it('回归验证是闸门：两轮没过回缺陷定级，到上限由内核放行并留痕', () => {
    const template = SOP_TEMPLATES.find((item) => item.id === 'testing-qa')!
    const regression = template.stages.find((stage) => stage.name === '回归验证')
    expect(regression?.gate).toEqual({ maxFails: 2, onFail: '缺陷定级' })
    // M34：缺陷定级的判据搬进紧随其后的闸门，逐条核对
    const triage = template.stages.find((stage) => stage.name === '缺陷定级')
    expect(triage?.acceptance ?? []).toEqual([])
    expect(regression?.acceptance ?? []).toContain('每条缺陷都有可复现的步骤与期望 / 实测对照')
    expect(regression?.acceptance ?? []).toContain('需修的缺陷都已派出，且每条能反查到对应修复任务')
    expect(regression?.acceptance ?? []).toContain('遗留风险写明接受或不接受及依据')
  })

  it('缺陷修复是独立模板：四阶段，关单权留在人工确认', () => {
    const issue = SOP_TEMPLATES.find((template) => template.id === 'testing-issue')
    expect(issue).toBeDefined()
    expect(issue!.stages.map((stage) => stage.name)).toEqual([
      '定位复现',
      '修复',
      '修复评审',
      '回归确认',
    ])
    expect(issue!.stages.at(-1)?.entryMode).toBe('user')
    // 修复方不能自己关单：判据在修复评审闸门上，且不出现「已验证」
    const fix = issue!.stages.find((stage) => stage.name === '修复')
    expect(fix?.acceptance ?? []).toEqual([])
    const review = issue!.stages.find((stage) => stage.name === '修复评审')
    expect((review?.acceptance ?? []).join('')).not.toContain('已验证')
    // 修复阶段的判据搬进评审闸门，逐条核对
    expect(review?.acceptance ?? []).toContain('新增用例在修复前失败、修复后通过')
    expect(issue!.stages.find((stage) => stage.name === '修复评审')?.gate).toEqual({
      maxFails: 2,
      onFail: '修复',
    })
  })

  it('模板字段落进草稿：spawnPolicy / onChildrenSettled 透传，验收只落在闸门', () => {
    const qa = SOP_TEMPLATES.find((template) => template.id === 'testing-qa')
    const byName = new Map(draftFromTemplate(qa!).stages.map((stage) => [stage.name, stage]))

    expect(byName.get('执行测试')).toMatchObject({ spawnPolicy: 'agent', acceptance: [] })
    expect(byName.get('缺陷定级')).toMatchObject({ onChildrenSettled: 'wake', acceptance: [] })
    expect(byName.get('回归验证')).toMatchObject({
      onChildrenSettled: null,
      spawnPolicy: null,
      judge: { maxFails: 2 },
    })
    // 闸门带着自己的判据 + 搬过来的缺陷定级判据
    expect((byName.get('回归验证')!.acceptance ?? []).length).toBeGreaterThan(4)
    expect(byName.get('测试设计')!.spawnPolicy).toBeNull()
    expect(byName.get('测试设计')!.acceptance).toEqual([])
  })
})
