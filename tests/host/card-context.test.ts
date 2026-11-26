// @vitest-environment node
/**
 * 卡片上下文（M54）：宿主把「这张卡属于哪件活」从投影里拼出来交给通道。
 *
 * 用假 store（按视图名回答）覆盖：完整上下文、聊天卡、任务消失、查询抛错、全空。
 * 这些用例只锁「拼成什么」与「读不到就退化成 null」——多查出的字段不许变成投递失败。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Card } from '@workbench/protocol/entities'
import type { ViewId } from '@workbench/protocol/views'
import { cardContextOf, type CardContextStore } from '@workbench/host/card-context'

const AT = '2026-11-24T09:27:54.268Z'

/** 一张阶段卡（taskId + runId）；聊天卡把 taskId 换成 conversationId。 */
const cardOf = (over: Partial<Card> = {}): Card => ({
  id: 'card-1',
  runId: 'run-1',
  taskId: 'task-1',
  conversationId: null,
  title: '覆盖率棘轮红：打回补测还是接受现状？',
  text: '唯一阻断是覆盖率。',
  kind: 'ask',
  options: ['打回补测', '接受现状'],
  key: null,
  version: 1,
  status: 'open',
  delivery: 'pending',
  deliveryRef: null,
  deliveryRefs: {},
  deliveryAttempts: 0,
  nextDeliveryAt: null,
  deliveryGivenUp: false,
  optionIndex: null,
  answeredBy: null,
  answeredByRef: null,
  answeredAt: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
})

const task = {
  id: 'task-1',
  title: '地空协议配置，数据统一存储',
  description: '',
  workflowId: 'wf-1',
  projectId: 'proj-1',
  currentStageId: 'stage-2',
  archivedAt: null,
  createdAt: AT,
  updatedAt: AT,
}

const workflow = {
  id: 'wf-1',
  name: '需求交付',
  description: '',
  createdAt: AT,
  stages: [
    { id: 'stage-1', name: '实现' },
    { id: 'stage-2', name: '验收' },
  ],
}

const run = {
  id: 'run-1',
  agentId: 'agent-1',
  taskId: 'task-1',
  conversationId: null,
}

/** 按视图名回答的假 store：没登记的视图返回 null（模拟「查不到」）。 */
function storeOf(table: Partial<Record<ViewId, unknown>>, onQuery?: (view: ViewId) => void) {
  const query = vi.fn((view: ViewId) => {
    onQuery?.(view)
    return table[view] ?? null
  })
  return { query } as unknown as CardContextStore
}

const fullTable = {
  'task.byId': task,
  'run.byId': run,
  'projects.all': [{ id: 'proj-1', name: 'sagc3_monorepo' }],
  'workflows.all': [workflow],
  'agents.all': [{ id: 'agent-1', name: '评审员' }],
  'conversations.all': [],
} as Partial<Record<ViewId, unknown>>

describe('cardContextOf：拼出归属上下文', () => {
  it('阶段卡：项目 / 任务 / 阶段 / 智能体（本轮 run 的执行者）', () => {
    expect(cardContextOf(storeOf(fullTable), cardOf())).toEqual({
      projectName: 'sagc3_monorepo',
      taskTitle: '地空协议配置，数据统一存储',
      conversationTitle: null,
      stageName: '验收',
      agentName: '评审员',
    })
  })

  it('聊天卡：会话标题 + 智能体，没有项目 / 任务 / 阶段', () => {
    const store = storeOf({
      'run.byId': { ...run, taskId: null, conversationId: 'conv-1' },
      'conversations.all': [{ id: 'conv-1', title: '帮我看看今天的待办' }],
      'agents.all': [{ id: 'agent-1', name: '小助' }],
    })
    expect(cardContextOf(store, cardOf({ taskId: null, conversationId: 'conv-1' }))).toEqual({
      projectName: null,
      taskTitle: null,
      conversationTitle: '帮我看看今天的待办',
      stageName: null,
      agentName: '小助',
    })
  })

  it('默认目录里的任务：项目是 null，其余照给', () => {
    const store = storeOf({ ...fullTable, 'projects.all': [] })
    expect(cardContextOf(store, cardOf())?.projectName).toBeNull()
    expect(cardContextOf(store, cardOf())?.taskTitle).toBe('地空协议配置，数据统一存储')
  })

  it('任务已被删（视图给 null）：上下文退化成 agent 那一侧，查不到就整块不出现', () => {
    expect(cardContextOf(storeOf({ 'run.byId': run, 'agents.all': [] }), cardOf())).toBeNull()
  })

  it('全空时返回 null（没有可展示的上下文就别在消息里留空行）', () => {
    expect(cardContextOf(storeOf({}), cardOf())).toBeNull()
  })

  it('不挂 run 的卡（进入「会喊人」阶段开的停机卡）：只看任务那一侧，不去查 run', () => {
    const seen: ViewId[] = []
    const store = storeOf(fullTable, (view) => seen.push(view))
    expect(cardContextOf(store, cardOf({ runId: null, kind: 'stall' }))).toEqual({
      projectName: 'sagc3_monorepo',
      taskTitle: '地空协议配置，数据统一存储',
      conversationTitle: null,
      stageName: '验收',
      // 没有 run 就没有「本轮执行者」：这一格留空，不拿别的智能体顶上
      agentName: null,
    })
    expect(seen).not.toContain('run.byId')
  })

  it('上下文读不到不能拖累投递：查询抛错 → 逐项降级为 null', () => {
    const store = {
      query: (view: ViewId) => {
        if (view === 'task.byId') return task
        throw new Error('投影还没就绪')
      },
    } as unknown as CardContextStore
    expect(cardContextOf(store, cardOf())).toEqual({
      projectName: null,
      taskTitle: '地空协议配置，数据统一存储',
      conversationTitle: null,
      stageName: null,
      agentName: null,
    })
  })

  it('形状不对（视图给数组 / 空串 / 缺 stages）一律当没有', () => {
    const store = storeOf({
      'task.byId': { ...task, workflowId: '' },
      'run.byId': [run],
      'projects.all': [{ id: 'proj-1', name: '   ' }],
      'workflows.all': [{ id: 'wf-1', name: '需求交付' }],
    })
    expect(cardContextOf(store, cardOf())).toEqual({
      projectName: null,
      taskTitle: '地空协议配置，数据统一存储',
      conversationTitle: null,
      stageName: null,
      agentName: null,
    })
  })

  it('只查该查的：没有 taskId 时不查任务 / 项目 / 工作流', () => {
    const seen: ViewId[] = []
    const store = storeOf({ 'run.byId': run, 'agents.all': [] }, (view) => seen.push(view))
    cardContextOf(store, cardOf({ taskId: null }))
    expect(seen).toEqual(['run.byId', 'agents.all'])
  })
})
