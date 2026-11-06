import { describe, expect, it } from 'vitest'
import { COMMAND_NAMES, type Command, type CommandName } from '../../src/protocol/commands'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

/** 判别联合的 `type` 必须恰好覆盖 COMMAND_NAMES（多一个或少一个都编译失败）。 */
const unionCoversNames: Assert<Equal<Command['type'], CommandName>> = true

/** 每条命令都带 commandId（幂等键）；M1 配置三组 + 任务四动作，M4 卡片两条，M5 聊天与 app 事件，M7 插件设置两条。 */
const expected = [
  'workflow.create',
  'workflow.update',
  'workflow.remove',
  'agent.create',
  'agent.update',
  'agent.remove',
  'runtime.create',
  'runtime.update',
  'runtime.remove',
  'runtime.probe',
  'runtime.probed',
  'project.create',
  'project.update',
  'project.remove',
  'task.create',
  'task.move',
  'task.complete',
  'task.remove',
  'task.comment',
  'card.answer',
  'card.resolve',
  'chat.create',
  'chat.send',
  'chat.remove',
  'chat.cancel',
  'chat.archive',
  'app.event',
  'rules.replace',
  'rule.trigger',
  'plugins.replace',
  'plugin.set',
  'thread.note',
  'thread.close',
  'thread.bind',
]

describe('protocol/commands', () => {
  it('COMMAND_NAMES 覆盖 M1/M4/M5 决策面且顺序稳定', () => {
    expect([...COMMAND_NAMES]).toEqual(expected)
  })

  it('命令名不重复，拼写与事实命名风格一致（小写点分）', () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length)
    for (const name of COMMAND_NAMES) expect(name).toMatch(/^[a-z]+\.[a-z]+$/)
  })

  it('命令联合类型与名称常量一一对应', () => {
    expect(unionCoversNames).toBe(true)
  })
})
