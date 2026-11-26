/**
 * mutation-targets.mjs — 变异范围的**单一来源**。
 *
 * 「哪些代码值得做变异测试」是一份判断，不是散在各处的配置：`scripts/mutation-scope.mjs`
 * 用它圈定本次改动的范围，`stryker.config.json` 用同一份清单当无参运行的默认范围。
 * 两份各写一遍必然漂（改了一边忘了另一边，门禁就悄悄窄了），所以清单只在这里，
 * 由 `tests/architecture.test.ts` 核对配置与它一致。
 *
 * 为什么内核 + 协议：
 * - `packages/core/kernel/src`：纯函数决策层，变异能落到语义上；
 * - `packages/core/protocol/src`：归一 / 校验 / 契约常量的纯逻辑部分。
 *
 * 为什么排除下面这些：纯类型、纯常量、纯路由与纯查表没有运行时分支，变异只能产出噪音；
 * `plugin-host.ts` 在 IO 边界上，mock 会把变异吸收掉。
 * `packages/host`、`apps/server`、`packages/client` 整体不在内：IO 密集，变异大多被 mock 吸收。
 */

export const SCAN_ROOTS = ['packages/core/kernel/src', 'packages/core/protocol/src']

/** 相对仓库根的文件路径（与 `git` 输出的分隔符一致，正斜杠）。 */
export const SCAN_EXCLUDE = [
  'packages/core/kernel/src/core/types.ts', // 类型定义
  'packages/core/kernel/src/decide.ts', // 纯命令路由（规则都在 commands/*）
  'packages/core/kernel/src/scopes/view-spec.ts', // 纯查表
  'packages/core/protocol/src/entities.ts', // 类型定义
  'packages/core/protocol/src/facts.ts', // 类型 + 常量
  'packages/core/protocol/src/commands.ts', // 命令契约
  'packages/core/protocol/src/inputs.ts',
  'packages/core/protocol/src/ipc.d.ts', // 声明文件（IPC 类型，无运行时）
  'packages/core/protocol/src/views.ts',
  'packages/core/protocol/src/plugins.ts',
  'packages/core/protocol/src/rules.ts',
  'packages/core/protocol/src/review.ts',
  'packages/core/protocol/src/thread.ts',
  'packages/core/protocol/src/task-comment.ts',
  'packages/core/protocol/src/receipt-keys.ts',
  'packages/core/protocol/src/channels.ts',
  'packages/core/protocol/src/manifest.ts',
  'packages/core/protocol/src/executor.ts',
  'packages/core/protocol/src/worker.ts',
  'packages/core/protocol/src/model-id.ts',
  'packages/core/protocol/src/plugin-host.ts', // 插件宿主契约校验（IO 边界，mock 会吸收变异）
]

/**
 * `stryker.config.json` 的 `mutate`：范围 = 两个根目录 − 排除名单。
 *
 * Stryker 只吃 glob，没有「排除文件清单」的写法，所以这里把清单展开成
 * 「包含 + 逐个否定」的形式；顺序有意义（否定必须排在包含之后）。
 */
export function mutateGlobs() {
  return [...SCAN_ROOTS.map((root) => `${root}/**/*.ts`), ...SCAN_EXCLUDE.map((file) => `!${file}`)]
}

/** 一个路径是否落在这个范围内（脚本、测试、文档共用同一份判断）。 */
export function isMutable(relativePath) {
  const file = relativePath.replace(/\\/g, '/')
  if (!file.endsWith('.ts')) return false
  if (/\.(test|spec)\.ts$/.test(file)) return false
  if (!SCAN_ROOTS.some((root) => file.startsWith(`${root}/`))) return false
  return !SCAN_EXCLUDE.includes(file)
}
