/**
 * 插件能力面实现（M3）：`createSdk` 把宿主注入的 `SdkHost` 原件按 manifest 声明门控后
 * 交给插件。
 *
 * 依赖方向：`sdk → protocol`——本文件只 import `./types` 与 `../protocol/manifest`，
 * 不碰 node 内置、electron 与 host 实现（原件由 `host/sdk-host.ts` 组装、装配根注入）。
 *
 * 边界与取舍：
 * - 能力门控是运行期最后一道（前两道是 ESLint import 面与 `tests/plugins/boundary.test.ts`）：
 *   未声明 `spawn` 的插件访问 `sdk.process` 立即抛 `capability_not_declared: spawn`，
 *   而不是先拿到入口再被静态检查抓。用 getter 而不是构造期判断，是因为只有真正访问时
 *   才该拒绝；声明了能力但本轮没用到的插件不受影响。
 * - `log` 统一加插件 id 前缀（宿主日志通道据此区分来源），不在这里做格式化/脱敏。
 * - `now` 只给毫秒数：ISO 由回执/事实载体决定，插件不自己拼时间字符串。
 * - `paths`/`config` 原样代理，缺省值由 `host/sdk-host.ts` 决定（sdk 层不读宿主环境）。
 * - M3 最小面：只给执行器「跑一轮」需要的 log/now/paths/config/process；不提供
 *   emit/fs/net——执行器只能经 `ExecutorIO` 回报，不能绕过去直接产事实。
 */
import type { Capability, PluginManifest } from '../protocol/manifest'
import type { Sdk, SdkHost } from './types'

/** 能力门控断言：错误码形式固定，插件与测试都按这个字符串识别。 */
function requireCapability(manifest: PluginManifest, capability: Capability): void {
  if (!manifest.capabilities.includes(capability)) {
    throw new Error(`capability_not_declared: ${capability}`)
  }
}

/**
 * 按 manifest 能力声明组装插件能力面。
 *
 * `log/now/paths/config` 无能力要求、始终可用；`process` 需要声明 `spawn`。
 */
export function createSdk(host: SdkHost, manifest: PluginManifest): Sdk {
  return {
    log: (line) => host.log(`[plugin:${manifest.id}] ${line}`),
    now: () => host.now(),
    paths: host.paths,
    config: <T = Record<string, unknown>>() => host.config<T>(),
    get process() {
      requireCapability(manifest, 'spawn')
      return host.process
    },
  }
}
