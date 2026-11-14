/**
 * 不变量（sim 用）：只看库里的投影与事实，不依赖内核实现细节。
 *
 * 每条规则都要能独立说清「什么样算坏了」，失败信息带行数/编号，便于把随机序列缩到最小复现。
 * 这里断言的是**系统级**性质：任何一条输入序列跑完都不该出现——与单模块单测的性质测试互补。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface Violation {
  rule: string
  detail: string
}

const TERMINAL = "('succeeded', 'failed', 'cancelled')"

const rows = <T>(db: DatabaseSync, sql: string): T[] => db.prepare(sql).all() as unknown as T[]

export function checkInvariants(db: DatabaseSync): Violation[] {
  const violations: Violation[] = []

  // 1. 事实日志：seq 从 1 开始连续，不留空洞（宿主并发重试会放弃整批，不写半截）
  const log = rows<{ n: number; lo: number | null; hi: number | null }>(
    db,
    'SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi FROM facts',
  )[0]
  if (log.n > 0 && (log.lo !== 1 || log.hi !== log.n)) {
    violations.push({
      rule: '事实序号连续',
      detail: `count=${log.n} min=${String(log.lo)} max=${String(log.hi)}`,
    })
  }

  // 2. 投影元信息不落后于日志
  const meta = rows<{ seq: number }>(db, 'SELECT seq FROM projection_meta WHERE id = 1')[0]
  if (meta !== undefined && meta.seq !== log.hi) {
    violations.push({
      rule: '投影追上日志',
      detail: `meta.seq=${meta.seq} max(seq)=${String(log.hi)}`,
    })
  }

  // 3. running 必须持有租约（否则重启对账杀不到、超时也收不回）
  for (const run of rows<{ id: string }>(
    db,
    "SELECT id FROM runs WHERE status = 'running' AND (lease_id IS NULL OR lease_until IS NULL)",
  )) {
    violations.push({ rule: 'running 持有租约', detail: `run=${run.id}` })
  }

  // 4. waiting 释放租约与超时（等人期间不占并发位）
  for (const run of rows<{ id: string }>(
    db,
    "SELECT id FROM runs WHERE status = 'waiting' AND (lease_until IS NOT NULL OR deadline_at IS NOT NULL)",
  )) {
    violations.push({ rule: 'waiting 释放租约', detail: `run=${run.id}` })
  }

  // 5. 任务的当前阶段必须存在（阶段删除用 tombstone，不允许指向空气）
  for (const task of rows<{ id: string; current_stage_id: string }>(
    db,
    'SELECT t.id AS id, t.current_stage_id AS current_stage_id FROM tasks t LEFT JOIN workflow_stages s ON s.id = t.current_stage_id WHERE s.id IS NULL',
  )) {
    violations.push({
      rule: '任务阶段存在',
      detail: `task=${task.id} stage=${task.current_stage_id}`,
    })
  }

  // 6. 同一线程同时最多一个运行中的 run（线程串行）
  for (const thread of rows<{ thread_id: string; n: number }>(
    db,
    `SELECT thread_id, COUNT(*) AS n FROM runs WHERE status = 'running' AND thread_id IS NOT NULL GROUP BY thread_id HAVING COUNT(*) > 1`,
  )) {
    violations.push({
      rule: '线程内串行',
      detail: `thread=${thread.thread_id} running=${thread.n}`,
    })
  }

  // 7. 跳数上限：运行与事件都不越过 8 层
  for (const run of rows<{ id: string; hops: number }>(
    db,
    'SELECT id, hops FROM runs WHERE hops > 8',
  )) {
    violations.push({ rule: '跳数上限', detail: `run=${run.id} hops=${run.hops}` })
  }
  for (const event of rows<{ hops: number; n: number }>(
    db,
    "SELECT CAST(json_extract(payload, '$.hops') AS INTEGER) AS hops, COUNT(*) AS n FROM facts WHERE type = 'event.received' GROUP BY hops HAVING hops > 8",
  )) {
    violations.push({ rule: '事件跳数上限', detail: `hops=${event.hops} 条数=${event.n}` })
  }

  // 8. 运行落终态后名下不留 open 卡（closeCardsOnFinish 的出口保证）
  for (const card of rows<{ id: string; run_id: string; status: string }>(
    db,
    `SELECT c.id AS id, c.run_id AS run_id, r.status AS status FROM cards c JOIN runs r ON r.id = c.run_id WHERE c.status = 'open' AND r.status IN ${TERMINAL}`,
  )) {
    violations.push({
      rule: '终态卡收起',
      detail: `card=${card.id} run=${card.run_id} run.status=${card.status}`,
    })
  }

  // 9. 投递账自洽（M41）：有排期的卡只可能是「失败且未放弃」；已放弃的卡不再排期
  for (const card of rows<{ id: string; delivery: string; given_up: number }>(
    db,
    "SELECT id, delivery, delivery_given_up AS given_up FROM cards WHERE next_delivery_at IS NOT NULL AND (delivery <> 'failed' OR delivery_given_up <> 0)",
  )) {
    violations.push({
      rule: '投递排期自洽',
      detail: `card=${card.id} delivery=${card.delivery} givenUp=${card.given_up}`,
    })
  }

  // 10. 引用完整性：run 的阶段 / 任务、agent 的运行时
  for (const run of rows<{ id: string }>(
    db,
    'SELECT r.id AS id FROM runs r LEFT JOIN workflow_stages s ON s.id = r.stage_id WHERE r.stage_id IS NOT NULL AND s.id IS NULL',
  )) {
    violations.push({ rule: 'run 阶段存在', detail: `run=${run.id}` })
  }
  for (const agent of rows<{ id: string }>(
    db,
    'SELECT a.id AS id FROM agents a LEFT JOIN runtimes rt ON rt.id = a.runtime_id WHERE rt.id IS NULL',
  )) {
    violations.push({ rule: 'agent 运行时存在', detail: `agent=${agent.id}` })
  }

  return violations
}
