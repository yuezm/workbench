/**
 * 内核测试的底座夹具：空的视图切片与显式注入的环境。
 *
 * 只在「边缘臂」测试里用——它们关心的是某一条分支，不需要把每一张投影表都填满；
 * 需要具体实体的测试仍按各自文件里的 `over` 工厂构造（与既有测试同风格）。
 *
 * 两条自律：视图只装产品代码会读到的切片；时间 / id 一律显式，不读时钟、不取随机数。
 * 限制取内核契约的默认值（`kernel/core/limits`）而不是抄一份数字：抄出来的那份会漂，
 * M48 放宽租约时正是「测试还停在 120 s、覆盖率仍然 100%」。
 */
import { DEFAULT_LIMITS } from '@workbench/kernel/core/limits'
import type { Environment, IdKind, Limits, View } from '@workbench/kernel/core/types'

export const TEST_AT = '2026-11-24T09:00:00.000Z'

/** 限制：生产默认值 + 用例自己的覆盖（只改与本分支有关的字段）。 */
export const testLimits = (over: Partial<Limits> = {}): Limits => ({ ...DEFAULT_LIMITS, ...over })

/** 环境：id 生成器按 `<kind>-next` 确定性派生（同一批调用得到同一结果）。 */
export const testEnv = (over: Partial<Environment> = {}): Environment => ({
  timezone: 'Asia/Shanghai',
  limits: testLimits(),
  nextId: (kind: IdKind) => `${kind}-next`,
  ...over,
})

/** 空视图：所有投影表为空，其余切片取「什么都没发生」的缺省。 */
export const emptyView = (over: Partial<View> = {}): View => ({
  seq: 0,
  workflows: new Map(),
  stages: new Map(),
  agents: new Map(),
  runtimes: new Map(),
  projects: new Map(),
  tasks: new Map(),
  runs: new Map(),
  conversations: new Map(),
  messages: new Map(),
  cards: new Map(),
  threads: new Map(),
  taskComments: new Map(),
  reviewReports: new Map(),
  events: new Map(),
  ruleSkips: [],
  rules: [],
  rulesVersion: 0,
  ruleSetReplacedAt: null,
  ruleFiredAt: new Map(),
  pluginSettings: [],
  pluginSettingsVersion: 0,
  activeTaskIds: new Set(),
  ...over,
})
