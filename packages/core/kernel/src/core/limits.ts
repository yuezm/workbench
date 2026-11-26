/**
 * 内核限制的默认值（`Limits` 的契约缺省）。
 *
 * 为什么放在内核而不是宿主存储层：默认值是**契约的一部分**——内核单测要按生产口径验证
 * 租约 / 退避 / 超时，就不能从宿主实现里抄一份数字（抄出来的那份会漂：M48 放宽租约时，
 * 测试里的 120 s 副本没人改，而 100% 覆盖率对此毫无感觉）。宿主存储层只消费它
 * （`host/store` 就地 re-export，消费方的 import 路径不变）。
 *
 * 注释里的实测数字是判定依据，改动前先读对应 SPEC 与 `/docs/testing/CONSTRAINTS-HISTORY.md`。
 */
import type { Limits } from './types'

/**
 * M1 的两项（阶段上限与 `protocol/validate` 一致、数组上限取迁移/帧批次量级）
 * + M2 的调度口径（SPEC-kernel「类型契约」原值；测试可注入缩短，语义不变）。
 */
export const DEFAULT_LIMITS: Limits = {
  maxStagesPerWorkflow: 50,
  maxArrayLength: 500,
  maxHops: 8,
  /**
   * 租约与心跳（M48）：120 s 对 high-effort 模型连一次思考都不够用。
   *
   * 实测（任务 `c8ccd24f`）：模型单次 thinking 到过 117 s / 136 s，心跳一旦因宿主重启
   * 或事件循环卡住断掉，2 分钟就判租约过期、整阶段重跑。租约是用来防「进程死了但没报终态」
   * 的护栏，不是用来防「模型慢」的，所以放宽到 10 分钟；心跳仍是 30 s。
   */
  leaseMs: 600_000,
  heartbeatMs: 30_000,
  maxAttempts: 3,
  /**
   * 退避（M48）：300 s 起步对交互式场景就是「白等 5 分钟再看一眼」。
   *
   * 退避的目的是避开瞬时故障（端口占用、宿主刚重启），不是惩罚重试；15 s 起步、
   * 60 s 封顶足够错开，也让「宿主重启打断在跑的轮次」变成几乎无感的抖动。
   */
  backoffBaseMs: 15_000,
  backoffCapMs: 60_000,
  runTimeoutMs: 3_600_000,
  cancelGraceMs: 3_000,
  killAfterMs: 2_000,
  maxFramesPerBatch: 500,
  maxSpawnItems: 32,
  maxSpawnDepth: 8,
}
