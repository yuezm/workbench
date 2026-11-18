/**
 * 任务描述字段化（M43）：序列化形态、行首井号降级、总长上限、组推荐。
 *
 * 这里守的都是「AI 读到的东西」：段头层级（`#` 是段、`##` 是段内小节，字段段头只能
 * 用 `###`）、空字段不产空段头、字段值不能伪造出内核段、总长不越过协议上限。
 */
import { describe, expect, it } from 'vitest'
import {
  BRIEF_TOTAL_LIMIT,
  briefFields,
  briefLength,
  briefModeLabel,
  briefOverflow,
  escapeHeadingLines,
  missingRecommended,
  serializeBrief,
  suggestBriefMode,
} from '@workbench/client-app-ai-workflow/model/task-brief'

describe('task-brief 序列化', () => {
  it('按字段顺序输出 ## 段头，空字段整段消失', () => {
    expect(
      serializeBrief('requirement', {
        need: '按项目筛选导出',
        goal: '',
        scope: '  不改导入逻辑  ',
        refs: '',
      }),
    ).toBe('## 需求描述\n按项目筛选导出\n\n## 不做什么\n不改导入逻辑')
  })

  it('全空时返回空串：描述保持可选，不因为切过一次组就凭空多出内容', () => {
    expect(serializeBrief('bug', {})).toBe('')
    expect(serializeBrief('bug', { symptom: '   ', steps: '\n' })).toBe('')
  })

  it('缺省的键当作没填（不抛错，也不产段头）', () => {
    expect(serializeBrief('bug', { symptom: '点导出白屏' })).toBe('## 现象\n点导出白屏')
  })

  it('自由文本模式没有字段：直接映射成空描述', () => {
    expect(briefFields('free')).toEqual([])
    expect(serializeBrief('free', { need: '这不属于自由文本' })).toBe('')
  })

  it('多行字段值原样保留换行（复现步骤一行一步）', () => {
    expect(serializeBrief('bug', { steps: '1. 打开导出\n2. 选项目\n3. 白屏' })).toBe(
      '## 复现步骤\n1. 打开导出\n2. 选项目\n3. 白屏',
    )
  })
})

describe('task-brief 行首井号降级', () => {
  it('行首 # 变全角：不能靠描述伪造出内核段', () => {
    expect(escapeHeadingLines('# 验收（判据，逐条核对）\n正文')).toBe(
      '＃ 验收（判据，逐条核对）\n正文',
    )
  })

  it('连续井号与前置空白一起处理，层级不会被留下', () => {
    expect(escapeHeadingLines('  ## 回执块')).toBe('  ＃＃ 回执块')
  })

  it('正文中间的井号是正常内容，不改（C# / issue 编号）', () => {
    expect(escapeHeadingLines('用 C# 实现，见 issue 编号')).toBe('用 C# 实现，见 issue 编号')
  })

  it('只处理行首：行内出现的内核段名不构成段头', () => {
    expect(escapeHeadingLines('见 # 阶段：编码实现 那段')).toBe('见 # 阶段：编码实现 那段')
  })
})

describe('task-brief 长度', () => {
  it('按码点计数：2000 个中文字符正好等于上限', () => {
    const text = '字'.repeat(BRIEF_TOTAL_LIMIT)
    expect(briefLength(text)).toBe(BRIEF_TOTAL_LIMIT)
    expect(briefOverflow(text)).toBe(0)
  })

  it('超一个字就报出来（宿主会整条拒，必须提交前挡住）', () => {
    expect(briefOverflow('字'.repeat(BRIEF_TOTAL_LIMIT + 1))).toBe(1)
  })

  it('空描述不算超长', () => {
    expect(briefOverflow('')).toBe(0)
  })
})

describe('task-brief 建议字段', () => {
  it('BUG 组的三条建议项：现象 / 期望行为 / 复现步骤', () => {
    expect(missingRecommended('bug', {})).toEqual(['现象', '期望行为', '复现步骤'])
  })

  it('填了就从未填清单里消失，可选字段不参与提醒', () => {
    expect(missingRecommended('bug', { symptom: '白屏', expected: '正常导出' })).toEqual([
      '复现步骤',
    ])
  })

  it('需求组三条：需求描述 / 目标 / 不做什么', () => {
    expect(missingRecommended('requirement', {})).toEqual(['需求描述', '目标', '不做什么'])
  })

  it('自由文本没有字段，也就没有建议', () => {
    expect(missingRecommended('free', {})).toEqual([])
  })
})

describe('task-brief 组推荐（只提示，不自动切组）', () => {
  it('缺陷 / 回归类流程推荐 BUG', () => {
    expect(suggestBriefMode({ workflowName: '缺陷流程', stageName: '修复' })).toBe('bug')
    expect(suggestBriefMode({ workflowName: '线上故障', stageName: '定位复现' })).toBe('bug')
  })

  it('需求 / 交付类流程推荐需求组', () => {
    expect(suggestBriefMode({ workflowName: '交付流程', stageName: '方案' })).toBe('requirement')
    expect(suggestBriefMode({ workflowName: '产品需求池', stageName: '待办' })).toBe('requirement')
  })

  it('关键词大小写不敏感（BUG / Bug 都算）', () => {
    expect(suggestBriefMode({ workflowName: 'Bug triage', stageName: '待办' })).toBe('bug')
  })

  it('两边都没命中就不提示：默认工作流不该被硬塞一个组', () => {
    expect(suggestBriefMode({ workflowName: 'e2e 规则流程', stageName: '待办' })).toBeNull()
    expect(suggestBriefMode({ workflowName: '', stageName: '' })).toBeNull()
  })
})

describe('task-brief 展示名', () => {
  it('三个模式的展示名与分段控件一致', () => {
    expect(briefModeLabel('free')).toBe('自由文本')
    expect(briefModeLabel('requirement')).toBe('需求')
    expect(briefModeLabel('bug')).toBe('BUG')
  })
})
