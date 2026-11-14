// @vitest-environment node
/**
 * 不变量自检：每条断言都必须在「人为破坏」时变红。
 *
 * 随机序列只证明「当前实现没破」；这个文件证明「破了会有人喊」——
 * 做法与 `tests/architecture.test.ts` 的护栏自检同款：先造一个坏库，再断言能点名到规则。
 */
import { describe, expect, it } from 'vitest'
import { checkInvariants } from './invariants'
import { createWorld, runSim } from './world'

/** 造一个跑过短序列的世界（有任务 / 运行 / 卡片），再按用例破坏其中一条。 */
const damaged = (mutate: (world: ReturnType<typeof createWorld>) => void): string[] => {
  const world = createWorld(777)
  runSim(world, 150)
  mutate(world)
  return checkInvariants(world.db).map((violation) => violation.rule)
}

const firstRun = (world: ReturnType<typeof createWorld>): string =>
  String(
    (world.db.prepare('SELECT id FROM runs ORDER BY id LIMIT 1').get() as unknown as { id: string })
      .id,
  )

const firstCard = (world: ReturnType<typeof createWorld>): { id: string; run: string } => {
  const row = world.db
    .prepare('SELECT id, run_id FROM cards ORDER BY id LIMIT 1')
    .get() as unknown as { id: string; run_id: string } | undefined
  if (row !== undefined) return { id: row.id, run: row.run_id }

  // 短序列不一定抽到 ask 回执：这里按真实列形状补一张 open 卡，让用例不依赖随机运气。
  const run = firstRun(world)
  const at = world.clock.now()
  world.db
    .prepare(
      `INSERT INTO cards (id, run_id, task_id, conversation_id, title, text, kind, options_json, key, version, status, delivery, created_at, updated_at)
       VALUES ('card-probe', ?, NULL, NULL, '探针卡', '', 'ask', '["甲","乙"]', NULL, 1, 'open', 'delivered', ?, ?)`,
    )
    .run(run, at, at)
  return { id: 'card-probe', run }
}

describe('sim：不变量能抓到自己人', () => {
  it('事实序号有空洞', () => {
    const rules = damaged((world) => {
      world.db
        .prepare(
          'DELETE FROM facts WHERE seq = (SELECT seq FROM facts ORDER BY seq LIMIT 1 OFFSET 1)',
        )
        .run()
    })
    expect(rules).toContain('事实序号连续')
  })

  it('投影落后于日志', () => {
    const rules = damaged((world) => {
      world.db.prepare('UPDATE projection_meta SET seq = seq + 5 WHERE id = 1').run()
    })
    expect(rules).toContain('投影追上日志')
  })

  it('running 没有租约', () => {
    const rules = damaged((world) => {
      const id = firstRun(world)
      world.db
        .prepare(
          "UPDATE runs SET status = 'running', lease_id = NULL, lease_until = NULL WHERE id = ?",
        )
        .run(id)
    })
    expect(rules).toContain('running 持有租约')
  })

  it('waiting 还占着租约', () => {
    const rules = damaged((world) => {
      const id = firstRun(world)
      world.db
        .prepare(
          "UPDATE runs SET status = 'waiting', lease_until = '2026-01-01T00:00:00.000Z', deadline_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
        )
        .run(id)
    })
    expect(rules).toContain('waiting 释放租约')
  })

  it('任务指向不存在的阶段', () => {
    const rules = damaged((world) => {
      // 破坏方式：先关外键（真实库默认开着，这里模拟「绕过约束的写入」，护栏必须兜住）
      world.db.exec('PRAGMA foreign_keys = OFF')
      const id = String(
        (
          world.db.prepare('SELECT id FROM tasks ORDER BY id LIMIT 1').get() as unknown as {
            id: string
          }
        ).id,
      )
      world.db.prepare('UPDATE tasks SET current_stage_id = ? WHERE id = ?').run('ghost-stage', id)
    })
    expect(rules).toContain('任务阶段存在')
  })

  it('同一线程两个运行中的 run', () => {
    const rules = damaged((world) => {
      const runs = world.db
        .prepare('SELECT id FROM runs ORDER BY id LIMIT 2')
        .all() as unknown as Array<{ id: string }>
      for (const run of runs) {
        world.db
          .prepare(
            "UPDATE runs SET status = 'running', thread_id = 't-shared', lease_id = 'l1', lease_until = '2026-01-01T01:00:00.000Z' WHERE id = ?",
          )
          .run(run.id)
      }
    })
    expect(rules).toContain('线程内串行')
  })

  it('run 跳数越界', () => {
    const rules = damaged((world) => {
      const id = firstRun(world)
      world.db.prepare('UPDATE runs SET hops = 9 WHERE id = ?').run(id)
    })
    expect(rules).toContain('跳数上限')
  })

  it('运行落终态后还留着 open 卡', () => {
    const rules = damaged((world) => {
      const card = firstCard(world)
      world.db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(card.run)
      world.db.prepare("UPDATE cards SET status = 'open' WHERE id = ?").run(card.id)
    })
    expect(rules).toContain('终态卡收起')
  })

  it('投递排期与投递状态不一致', () => {
    const rules = damaged((world) => {
      const card = firstCard(world)
      world.db
        .prepare(
          "UPDATE cards SET delivery = 'pending', next_delivery_at = '2026-01-01T00:30:00.000Z', delivery_given_up = 0 WHERE id = ?",
        )
        .run(card.id)
    })
    expect(rules).toContain('投递排期自洽')
  })

  it('智能体指向不存在的运行时', () => {
    const rules = damaged((world) => {
      world.db.exec('PRAGMA foreign_keys = OFF')
      const id = String(
        (
          world.db.prepare('SELECT id FROM agents ORDER BY id LIMIT 1').get() as unknown as {
            id: string
          }
        ).id,
      )
      world.db.prepare('UPDATE agents SET runtime_id = ? WHERE id = ?').run('ghost-runtime', id)
    })
    expect(rules).toContain('agent 运行时存在')
  })

  it('run 指向不存在的阶段', () => {
    const rules = damaged((world) => {
      world.db.exec('PRAGMA foreign_keys = OFF')
      const id = firstRun(world)
      world.db.prepare('UPDATE runs SET stage_id = ? WHERE id = ?').run('ghost-stage', id)
    })
    expect(rules).toContain('run 阶段存在')
  })
})
