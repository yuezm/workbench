/**
 * source 插件测试夹具：按 `SourceContext` 形状构造可控上下文（不启动 hub、不读写库）。
 *
 * - `sdk` 用 `fakeSdk` 再补上假 `net`（`Sdk.net` 是 M7 新增的必填能力）；
 * - `emit` 把事件记进 `emitted`，供「通过才产事件、失败零事件」断言；
 * - `logs` 收集插件 `sdk.log` 的调用，供「未配置时说明原因」断言。
 */
import type { RawEvent } from '../../../src/protocol/inputs'
import type { Sdk, SourceContext } from '../../../src/sdk/types'
import { fakeSdk, type FakeSdk } from '../support/fake-sdk'
import { fakeNet, type FakeNet } from './fake-net'

export interface NetSdk {
  /** 假能力面 + 假 net（结构上满足 `Sdk`） */
  sdk: Sdk
  net: FakeNet
  /** 底层假 sdk（notify 记录等） */
  base: FakeSdk
}

export interface NetSdkOptions {
  /** 插件配置（`sdk.config()` 的返回值） */
  config?: Record<string, unknown>
  net?: FakeNet
  /** 日志落点；缺省收集到调用方的 logs 数组 */
  log?: (line: string) => void
  now?: () => number
}

/** 组装带 net 的假能力面（执行器/通道测试同样可复用）。 */
export function sdkWithNet(options: NetSdkOptions = {}): NetSdk {
  const net = options.net ?? fakeNet()
  const base = fakeSdk({
    // null 是插件契约里的「未配置」：按原样透传（只有 undefined 才补空对象），
    // 否则「宿主未合并默认值」的分支在测试里永远不会被触发。
    config: <T = Record<string, unknown>>() =>
      (options.config === undefined ? {} : options.config) as T,
    log: options.log ?? (() => undefined),
    net,
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
  return { sdk: base, net, base }
}

export interface SourceHarness extends NetSdk {
  ctx: SourceContext
  controller: AbortController
  /** 插件 emit 出去的事件（顺序即调用顺序） */
  emitted: RawEvent[]
  /** 插件经 sdk.log 输出的行 */
  logs: string[]
}

export function sourceHarness(options: NetSdkOptions = {}): SourceHarness {
  const logs: string[] = []
  const controller = new AbortController()
  const emitted: RawEvent[] = []
  const assembled = sdkWithNet({ ...options, log: (line) => logs.push(line) })
  const ctx: SourceContext = {
    sdk: assembled.sdk,
    emit: (event) => {
      emitted.push(event)
    },
    signal: controller.signal,
  }
  return { ...assembled, ctx, controller, emitted, logs }
}
