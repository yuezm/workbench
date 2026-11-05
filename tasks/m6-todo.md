# M6 任务清单（自动化规则）

> 计划说明见 [m6-plan.md](./m6-plan.md)。规则：每个任务结束跑 `pnpm check:fast`；检查点跑完整 `pnpm check` 与 `pnpm e2e`。
> 前置：分支 `refactor/m6-rules` @ `2f06970` 已开；契约与口径以 m6-plan「架构决议 D1–D10」为准。
> `floor-guard` 扫描未跟踪文件全文，本文件不得出现关闭检查器/未完成标记/放松测试的写法。

## 阶段 1：契约与内核

### T1 契约：规则 / 命令 / 事件输入 / 视图

**描述：** 新增 `protocol/rules.ts`（`AutomationRule`、`RuleSetRow`、`RuleFireRow`、枚举与上限）；`protocol/commands.ts` 增 `rules.replace`、`rule.trigger`；`protocol/inputs.ts` 增宿主输入 `event.received`；`protocol/views.ts` 增 `rules.all`；`protocol/facts.ts` 增 `rules.replaced`、`rule.fired`；`protocol/entities.ts` 的 `Task` 加 `origin/ruleId/externalRef/labels`；`protocol/validate.ts` 校验新命令、事件输入与视图；`kernel/types.ts` 加 View 规则切片、投影表、`KERNEL_VERSION=m6.0.0`；`kernel/view-spec.ts` 补切片。

**验收标准：**

- [ ] `COMMAND_NAMES` / `HOST_INPUT_NAMES` / `INPUT_NAMES` 不重叠且清单测试更新
- [ ] `rules.replace` 形状校验拒绝：非数组、超 100 条、缺 id/name、when 双写、未知枚举、超长 prompt、parallel 越界
- [ ] `event.received` 校验拒绝非法 source/type/hops 与超长 summary
- [ ] `rules.all` 无参数；`Task` 新字段在 `TaskInput` 中仍不可由 UI 直填

**验证：** `pnpm test tests/protocol tests/kernel/view-spec.test.ts` 绿　**规模：** L　**负责：** lead

### T2 内核：规则匹配 / 建任务 / cron / project

**描述：** 新增 `kernel/rules.ts`（source/type 匹配、externalRef 去重、建任务 + 入口 run、手动触发、cron 到期集合）与 `kernel/cron.ts`（5 字段解析、时区墙钟下一次触发）；`decide` 接 `rules.replace` / `rule.trigger` / `event.received` / `app.event` / `run.receipt` 派生事件 / `clock.tick`；`project` 投影 `rules.replaced` / `rule.fired` 并归一 tasks 老行；`next-wake` 纳入 cron；`prompt` 追加规则段。

**验收标准：**

- [ ] 同一事件命中 0/1/多条规则分别建 0/1/N 条任务；多规则不排序
- [ ] 同 ruleId + externalRef 第二次事件不建任务；不同 externalRef 建新任务
- [ ] 规则任务进入 agent 阶段即产 run，`run.ruleId/rulesVersion/eventIds/hops` 正确
- [ ] `rules.replace` 非法整批 reject 且旧规则不变；合法批次版本 +1
- [ ] `rule.trigger` 停用/不存在 reject；启用时建一条任务（externalRef=null）
- [ ] cron 解析 + 触发：同刻一次、错过补最近一次、DST 跳过/重复语义；`nextWakeAt` 返回下一次 cron 时刻
- [ ] 重建后 `rule_sets` / `rule_fires` 与增量一致；老 `task.created` 事实 replay 补默认值

**验证：** `pnpm test tests/kernel` 绿　**依赖：** T1　**规模：** XL　**负责：** lead

## 阶段 2：宿主

### T3 宿主：投影表 / tasks 补列 / 视图 / 导入

**描述：** `host/schema.ts` 加 `rule_sets`、`rule_fires` DDL 与 `tasks` 新列，同步 `PROJECTION_TABLES`、`tableDdl`、`PROJECTION_DDL`、索引；`host/db.ts` 对旧库 `tasks` 做一次性补列；`host/store/projection-apply.ts` 写入新表与新列（含级联清理）；`host/store/views.ts` 装载规则切片与 `rules.all` 查询、tasks 新列读写；`host/store/import.ts` v2 tasks 默认值。

**验收标准：**

- [ ] 新建库 + 旧库（缺列）打开后 tasks 列齐全，旧行 origin='manual'
- [ ] 投影写入/重建后 `rule_sets` / `rule_fires` / tasks 与事实逐行一致
- [ ] `rules.all` 返回 `{ version, rules }`；参数校验拒绝多余参数
- [ ] 任务删除/工作流删除不残留规则外键或悬空行
- [ ] `PROJECTION_TABLES` 与 `schema.ts` 两份清单一致（测试断言）

**验证：** `pnpm test tests/host` 绿　**依赖：** T1　**规模：** L　**负责：** host-dev

### T4 宿主接线：命令路由 / 装配根

**描述：** 命令路由对 `rules.replace` / `rule.trigger` 走内核决策并返回规则值（如需）；确认 `main/index.ts` 装配无需新增副作用；`host/feed` 只推事实类型，不改协议；必要时补命令路由测试。

**验收标准：**

- [ ] `rules.replace` 经 IPC 保存后 `rules.all` 立即可读
- [ ] `rule.trigger` 经 IPC 返回任务值；重复 `commandId` 不重复建任务
- [ ] `event.received` 只由宿主内部输入注入，renderer 不能直接发

**验证：** `pnpm test tests/host/commands.test.ts tests/main` 绿　**依赖：** T1、T3　**规模：** M　**负责：** host-dev

## 阶段 3：renderer

### T5 规则页（settings）

**描述：** `SettingsNav` 加第四栏「规则」；新增 `components/RulesManager.tsx`（列表 / 启用开关 / 新建 / 编辑 / 删除 / 立即运行 + 两个模板按钮）；新增规则表单对话框（cron 或事件源、目标工作流/阶段、titleFrom、prompt、parallel、merge、keyFrom/onExisting）；`AiWorkflowPage` 挂载；`kernelStore` 失效表登记 `rules.` / `rule.`。

**验收标准：**

- [ ] 规则列表只读 `rules.all`，保存整批发 `rules.replace`
- [ ] 表单校验与内核口径一致（空名、未选工作流、非法 cron 前端先提示；后端 reject 文案原样展示）
- [ ] 启停/删除/立即运行可用；「Issue 进研发」「每日早报」模板预填正确
- [ ] 事实到达后列表自动刷新（无 reload 链、无轮询）
- [ ] 现有设置三栏行为与文案不变

**验证：** `pnpm test tests/renderer` 绿　**依赖：** T1、T3　**规模：** L　**负责：** ui-dev

### T6 集成与门禁

**描述：** 新增/更新内核、宿主、renderer 用例补覆盖；e2e 视代价补「规则建任务」一条；`pnpm check`、`check:diffcov`、`pnpm e2e`；真机一轮（cron 规则到点建任务并执行 + 事件规则建任务）。

**验收标准：**

- [ ] `pnpm check` exit 0；覆盖率不低于 99.89 / 98.18 / 100 / 100
- [ ] `check:diffcov` ≥90%（目标 100%）
- [ ] `pnpm e2e` 全绿；清单类断言同批更新
- [ ] 手工验收记录：cron 规则准时建任务并执行；`event.received` 注入后规则任务出现在看板

**依赖：** T2–T5　**规模：** L　**负责：** lead + 全员

## 阶段 4：文档与退出

### T7 文档同步与退出记录

**描述：** SPEC-kernel（规则事实/视图/输入表）、SPEC-host（视图与启动）、SPEC-plugins（事件入口与来源边界）、CAPABILITY-MAP、TEST-CASES 同步；refactor-plan 写 M6 退出记录（提交链、门禁数字、已知边界：线程上下文留 M6.5、source 插件留 M7、回执块重写留 M6.5+、`to.thread` 字段 M6 只校验不生效）。

**验收标准：**

- [ ] 五份文档无「规则不存在 / 事件只入账」的过期描述
- [ ] refactor-plan M6 退出记录含门禁数字、回滚点、已知边界
- [ ] `check:floor` / `check:secrets` clean

**依赖：** T6　**规模：** M　**负责：** lead
