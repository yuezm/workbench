// @vitest-environment node
/**
 * 系统级不变量（计划 M35-A）：随机输入序列 → 真内核 + 真 SQLite → 逐条断言。
 *
 * 默认 800 步（并行全量跑时也在秒级）；放大用 `SIM_STEPS=200000 pnpm vitest run tests/sim`。
 * 失败时先看违规里的 `rule`，再用同一个 `SIM_SEED` 原样复现。
 */
import { describe, expect, it } from 'vitest'
import { dumpProjection } from '../host/store/test-support'
import { createWorld, runSim } from './world'

const SEED = Number(process.env['SIM_SEED'] ?? 24301)
const STEPS = Number(process.env['SIM_STEPS'] ?? 800)
const SLOW = 30_000

describe('sim：随机序列下的系统不变量', () => {
  it(
    '随机序列跑完不破任何不变量',
    () => {
      const world = createWorld(SEED)
      const { violations, executed } = runSim(world, STEPS)

      expect(
        violations,
        `违规（seed=${SEED}）：\n${violations.map((item) => `${item.rule} ${item.detail}`).join('\n')}`,
      ).toEqual([])
      // 序列不能空转：至少三成步骤真的落到了内核（否则「全绿」只是因为什么都没发生）
      expect(executed / STEPS, '实跑比例过低，随机世界没打到内核').toBeGreaterThan(0.3)
    },
    SLOW,
  )

  it(
    '随机世界真的打到主要路径（防退化成空转）',
    () => {
      const world = createWorld(SEED)
      const { executed } = runSim(world, Math.min(STEPS, 600))
      const accepted = world.accepted
      const total = executed + world.rejected.length

      expect(executed / Math.min(STEPS, 600), '实跑比例过低').toBeGreaterThan(0.5)
      expect(world.rejected.length / total, '拒绝率过高：生成器与契约脱节了').toBeLessThan(0.4)
      expect(accepted.size, '被接受的输入种类过少').toBeGreaterThanOrEqual(18)
      for (const type of [
        'task.create',
        'task.move',
        'task.complete',
        'run.claim',
        'run.receipt',
        'card.answer',
        'event.received',
        'clock.tick',
        'rules.replace',
      ]) {
        expect(
          accepted.get(type) ?? 0,
          `「${type}」一次都没被接受，这条路径没被测到`,
        ).toBeGreaterThan(0)
      }
    },
    SLOW,
  )

  it(
    '同一序列在增量投影与重建投影下逐表相等',
    () => {
      const world = createWorld(SEED)
      runSim(world, Math.min(STEPS, 400))
      const incremental = dumpProjection(world.db)

      world.store.rebuild()
      expect(dumpProjection(world.db)).toEqual(incremental)
    },
    SLOW,
  )

  it(
    '下一次唤醒时刻总在将来（不空转、不遗漏）',
    () => {
      const world = createWorld(SEED)
      runSim(world, 300)
      const now = world.clock.now()
      const next = world.store.nextWakeAt(now)
      // 允许「没有下一次」；有就必须晚于当前时刻（否则定时器会原地空转）
      expect(next === null || next > now, `nextWakeAt 返回了过去的时刻：${String(next)}`).toBe(true)
    },
    SLOW,
  )

  it(
    '同一种子跑两遍得到同一份投影（可复现）',
    () => {
      const first = createWorld(1234)
      runSim(first, 200)
      const second = createWorld(1234)
      runSim(second, 200)
      expect(dumpProjection(second.db)).toEqual(dumpProjection(first.db))
    },
    SLOW,
  )

  it('重复的 commandId 不重复产事实（命令幂等）', () => {
    const world = createWorld(SEED)
    const taskId = firstTaskId(world)

    world.store.dispatch({
      type: 'task.comment',
      commandId: 'idem-comment',
      taskId,
      text: '同一条反馈',
    })
    const first = world.store.factsCount()
    expect(first).toBeGreaterThan(0)

    world.store.dispatch({
      type: 'task.comment',
      commandId: 'idem-comment',
      taskId,
      text: '同一条反馈',
    })
    expect(world.store.factsCount(), '同一 commandId 第二次提交必须零事实').toBe(first)
  })
})

function firstTaskId(world: ReturnType<typeof createWorld>): string {
  const workflowId = String(
    (
      world.db.prepare('SELECT id FROM workflows ORDER BY id LIMIT 1').get() as unknown as {
        id: string
      }
    ).id,
  )
  world.store.dispatch({
    type: 'task.create',
    commandId: 'idem-task',
    input: { title: '幂等任务', workflowId, projectId: null },
  })
  return String(
    (
      world.db.prepare('SELECT id FROM tasks ORDER BY id LIMIT 1').get() as unknown as {
        id: string
      }
    ).id,
  )
}
