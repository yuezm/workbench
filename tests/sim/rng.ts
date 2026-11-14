/**
 * 确定性伪随机（sim 用）。
 *
 * 不引第三方依赖、不用 `Math.random`：同一个种子必须每次跑出同一条输入序列，
 * 失败用例才能原样复现（`SIM_SEED=24301 pnpm vitest run tests/sim`）。
 */
export interface Rng {
  /** [0, 1) 的浮点 */
  float(): number
  /** [min, max] 的整数（含两端） */
  int(min: number, max: number): number
  /** 均匀取一个元素；空数组返回 null */
  pick<T>(items: readonly T[]): T | null
  /** 以 p 的概率为真 */
  chance(p: number): boolean
}

/** mulberry32：32 位状态、乘法混淆，够用且可复现。 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0

  const float = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const int = (min: number, max: number): number => min + Math.floor(float() * (max - min + 1))

  return {
    float,
    int,
    pick: <T>(items: readonly T[]): T | null =>
      items.length === 0 ? null : items[int(0, items.length - 1)],
    chance: (p: number): boolean => float() < p,
  }
}
