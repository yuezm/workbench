/**
 * 提交后分发（afterCommit）：一次写入成功之后，把事实分发给订阅者。
 *
 * - `run.queued` → 唤醒调度器（领取与执行只由 scheduler 发起）；
 * - `run.cancel_requested` → 中止执行中的 run（终止时序由执行器负责）；
 * - `card.opened` / `card.updated` → 交给通道 hub（fire-and-forget：hub 自己异步投递、
 *   自捕获异常与超时，不拖住写路径）；
 * - 结局通知（M12）→ `announce`：`task.completed` / `run.failed` 由装配根翻成系统通知；
 * - 其余事实 → 只做变更通知。
 *
 * **所有写入口统一走 `effects.dispatch`**（IPC、scheduler、clock、通道）：先提交事实，
 * 再分发；订阅者之间异常互相隔离——一个通道抛错不影响其它分发，也不影响调用方拿到
 * 提交结果。变更通知按「一次提交」合并成一次推送（同一批事实不重复通知 UI）。
 */
import type { Fact } from '../kernel/types'
import type { DispatchResult } from './store/index'

/** 分发只需要的 store 能力。 */
export interface EffectsStore {
  dispatch(input: unknown): DispatchResult
}

/** 分发只需要的调度器能力（装配时惰性取，避免与 scheduler 的构造顺序耦合）。 */
export interface EffectsScheduler {
  wake(): void
  cancel(runId: string): void
}

/** 分发只需要的通道 hub 能力：hub 自己过滤 `card.opened/updated` 并异步投递。 */
export interface EffectsChannels {
  dispatch(facts: readonly Fact[]): void
}

export interface EffectsOptions {
  store: EffectsStore
  /** 调度器：惰性取，装配根可以先建 effects 再建 scheduler */
  scheduler: () => EffectsScheduler
  /** 通道 hub：惰性取，装配根在 effects 之后、scheduler 之前 startAll */
  channels?: () => EffectsChannels
  /** 变更广播（窗口）：一次提交推一次；异常隔离 */
  notifyChanged?: () => void
  /**
   * 结局通知（M12）：把「任务完成 / 运行失败」翻成系统通知，由装配根接到 `sdkHost.notify`
   * （宿主不 import Electron）。只在**实时提交**路径调用，重建 / 存量导入不产生打扰。
   */
  announce?: (facts: readonly Fact[]) => void
  /** 事实观察钩子（诊断 / 测试）；异常同样隔离 */
  onFacts?: (facts: readonly Fact[]) => void
}

export interface Effects {
  /** 唯一写入口：追加事实 + 提交后分发；返回值原样透出（含事实） */
  dispatch(input: unknown): DispatchResult
  /** 事实已提交后的分发；调用方保证不在事务内调用 */
  afterCommit(facts: readonly Fact[]): void
}

/** 订阅者隔离：任何一个抛错都不能打断其余分发。 */
const safely = (run: () => void): void => {
  try {
    run()
  } catch {
    // 订阅者异常隔离（通道 / 窗口 / 调度器都不能拖垮写路径）
  }
}

export function createEffects(options: EffectsOptions): Effects {
  const { store } = options

  const afterCommit = (facts: readonly Fact[]): void => {
    for (const fact of facts) {
      if (fact.type === 'run.queued') {
        safely(() => options.scheduler().wake())
        continue
      }
      if (fact.type === 'run.cancel_requested') {
        const runId = (fact.payload as { run: { id: string } }).run.id
        safely(() => options.scheduler().cancel(runId))
      }
    }
    if (facts.length === 0) return
    // 卡片投递：hub 的 dispatch 只做「选集 + 异步投递」，立即返回；异常/超时在 hub 内隔离
    if (facts.some((fact) => fact.type === 'card.opened' || fact.type === 'card.updated')) {
      safely(() => options.channels?.().dispatch(facts))
    }
    safely(() => options.onFacts?.(facts))
    // 结局通知：卡片之外的打扰（任务完成 / 运行失败），与卡片投递互不影响
    safely(() => options.announce?.(facts))
    safely(() => options.notifyChanged?.())
  }

  return {
    afterCommit,
    dispatch: (input) => {
      const result = store.dispatch(input)
      afterCommit(result.facts)
      return result
    },
  }
}
