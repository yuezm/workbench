# 计划：吸纳 agent-autoloop 的工程优点（M35–M37）

> 定稿：2026-11-13。来源：与 `agent-autoloop` 的双向对照（结构、机制、验证体系），经人拍板：P0/P1 全做；P2 只做「内核拆两层」，`remote` 多机执行器另评。
> 本计划只加事实、视图、命令与测试，不改「产品本体是 GUI / 单一真相源 / IPC 三动词」三条边界。落地时逐项登记 CONSTRAINTS 复核记录，并同步对应 SPEC。

## 当前基线（改造起点，实测）

> 2026-11-14 复核：计划定稿后仓库推进到 M40（阶段可执行脚本、命令只来自运行时、Stryker 变异、fast-check 性质、e2e 红检、断言强度 lint）。下表按 M40 现状更新。
> 因此 **A/B 只补「系统级 / 结构级」缺口**：既有工具管「单模块能不能被变异杀死、单函数在任意坏输入下守不守约定」；A 管「跨模块状态机在任意合法序列下守不守系统不变量」，B 管「分层与真相源的结构事实」。

| 项               | 值                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `KERNEL_VERSION` | `M40.0.0`（`src/kernel/types.ts`）                                                                                 |
| 投影表           | 17 张（`PROJECTION_TABLES`），另 `facts` / `projection_meta` / `commands` / `plugin_secrets` / `process_registry`  |
| 事实类型         | 63（`protocol/facts.ts` `FACT_TYPES`）                                                                             |
| 输入             | 38 条命令（`COMMAND_NAMES`）+ 10 条宿主输入（`HOST_INPUT_NAMES`）= 48；内核分派 48 个 `case`，`viewSpec` 48 个分支 |
| 视图             | 39 个内核视图 + 6 个宿主视图                                                                                       |
| `src/kernel`     | ≈8.8k 行（根文件 + `commands/` + `workflow/`），ARCHITECTURE 写的 ≤2000 行从未达标                                 |
| 测试             | 237 文件；已有单测 + 性质（fast-check）+ 变异（Stryker）+ e2e 红检 + 断言 lint；**缺**系统级随机/强杀不变量        |
| 回归门           | `pnpm check`（类型 + lint + floor + secrets + ui + 覆盖率 + 改动行 + audit）、`pnpm e2e`、`pnpm e2e:packaged`      |

对照后确认的四处空白（本计划要补的）：**没有系统级不变量测试**、**投递一次失败即终态**、**禁用规则期间的事件无声丢弃**、**用量只有 token 没有成本口径**。

## 总览

| 里程碑 | 内容                                                   | 一次升版                                                            | 预估   |
| ------ | ------------------------------------------------------ | ------------------------------------------------------------------- | ------ |
| M35    | 不变量测试、架构断言、投递重试账、规则暂停与补跑       | `M35.0.0`（cards 三列）→ `M35.1.0`（events 新表 + rule_fires 两列） | 6.5 天 |
| M36    | 用量与成本、规则预演与下次触发、性能基线、数据目录 ACL | 无 DDL 变更                                                         | 6.5 天 |
| M37    | 内核拆两层（`core` / `scopes`）+ 行数预算门禁          | 无数据变更                                                          | 5–8 天 |

依赖顺序：**B → A → C → D → E → F → G → H → M37**。B 先立断言，A 才有参照；C/D 都动投影，各自升版；M37 会大面积改 import 路径，放在最后且独占分支。

---

## M35 · 不变量与运维补口

### A. 系统级不变量测试（仿 `sim/random.ts`、`sim/crash.ts`、`sim/invariants.ts`）

**为什么**：现有 3390 条用例是「按场景枚举」，没有「按输入序列穷举/随机」这一层。内核已经是纯函数（`decide(view, input, now, env)`，时间与 id 由 `Environment` 注入），`host/store` 已能对临时库跑真 SQLite——不变量测试的原料齐备，缺的只是 harness。

**新增文件**

| 文件                       | 职责                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/sim/world.ts`       | 确定性伪随机（自写 LCG，禁 `Math.random`）：生成 `Input` 序列（建项目/工作流/智能体/任务、`clock.tick`、`run.claim`、`run.receipt`、`card.answer`、`event.received`、`thread.*`、`task.move`），按权重随机，固定种子可复现 |
| `tests/sim/apply.ts`       | 把序列喂进真内核 + 真 `store`（临时文件库，`host/store/test-support.ts` 已有夹具），可选注入故障（丢回执、重复提交、乱序 tick、进程中断）                                                                                  |
| `tests/sim/invariants.ts`  | oracle：从 `facts` 独立重放（自写 fold，不复用 `projection-apply`）与实时投影逐行比对；再断言不变量清单                                                                                                                    |
| `tests/sim/random.test.ts` | 默认 2 万步（`SIM_STEPS` 可调），进 `pnpm check`                                                                                                                                                                           |
| `scripts/sim-crash.mjs`    | 子进程循环：随机时刻 `SIGKILL`（Windows `taskkill /F`）→ 重启 → 对账 → 断言「已确认事实零丢失、投影与日志一致、无残留 running」；默认 200 次，nightly 1000 次                                                              |

**不变量清单（每条都要有独立断言与失败信息）**

1. 事实日志：`seq` 严格递增无空洞；同 `commandId` 二次提交零新事实。
2. 投影：实时 fold 与全量重建逐行相等；`projection_meta.seq == max(facts.seq)`。
3. 运行：终态唯一（不再变化）；重启对账后无 `running` 残留；租约任一时刻至多一个持有者。
4. 卡片：run 落终态或任务完成后，名下无 `open` 卡；`(cardId, version)` 的 `delivered` 至多一条。
5. 跳数：任何 `event.received.hops ≤ 8`；超限必有 `event.dropped` 且零 `task.created`。
6. 线程：同线程同时至多一个 `running` run；派生任务与父任务同线程。
7. 唤醒：`nextWakeAt(view, now) > now`，且不遗漏 `leaseUntil` / `deadlineAt` / `notBefore` / cron 四类里最早的一刻。
8. 阶段：任务任一时刻只在一个阶段；内置四阶段恒存在且不可删。

**验收**

```bash
pnpm vitest run tests/sim            # 2 万步
SIM_STEPS=200000 pnpm vitest run tests/sim
node scripts/sim-crash.mjs 200
pnpm check                           # 覆盖率不降
```

**风险**：随机世界容易生成「内核本来就会拒」的输入，断言要按 `reject` 分支处理，不能把拒收当失败。做法：`apply.ts` 记录 `(input, reject?)`，不变量只对「已接受」的输入序列断言。

### B. 架构边界断言（仿 autoloop 的 `tests/purity.test.ts`：把结构事实写成可判定的测试）

**新增** `tests/architecture.test.ts`，读 `src/**` 源码文本（与 `tests/kernel/purity.test.ts` 同风格，不引 AST 依赖）：

| 断言                            | 说明                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| kernel 零第三方 import          | `src/kernel/**` 的 import 只允许相对路径与 `../protocol`                                     |
| 只有 `host/store/**` 写事实表   | 全仓 `INSERT INTO facts` 只出现在 `src/host/store/**`                                        |
| plugins 不 import host          | `src/plugins/**` 不得出现 `../host` / `src/host`                                             |
| renderer 不碰 node/electron     | `src/renderer/**` 无 `node:*`、`electron`（已有 ESLint 规则，这里加文本兜底）                |
| `PROJECTION_TABLES` == DDL      | 与 `host/schema.ts` 里 `CREATE TABLE` 的表名集合完全相等                                     |
| `COMMAND_NAMES` == 内核 handler | 每条命令在内核 dispatcher 里都有分支，且无多余分支                                           |
| 事实类型全覆盖                  | `FactPayloads` 的每个键在 `kernel/project.ts` 有 `case`、在 `kernel/view-spec.ts` 有切片归属 |

**验收**：故意删一个 `case`、改一个表名、在 kernel 里 `import 'node:fs'`，三处都必须让用例变红；`pnpm check` 绿。

### C. 卡片投递重试账（仿 `deliveries` 投递状态机）

**现状**：`host/channels.ts` 按 registry 顺序投一次，首个 ack 记 `card.delivered`，全败记 `card.delivery_failed`，**没有重试**；webhook 通道离线即永久失败。

**变更**

| 层   | 改动                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 事实 | `card.delivery_failed` 增 `attempt: number`、`retryAt: Iso \| null`；`card.delivered` 增 `attempt`。老事实归一：`attempt=1`、`retryAt=null`         |
| 常量 | `src/protocol/channels.ts` 增 `DELIVERY_RETRY_DELAYS_MS = [0, 30_000, 120_000, 600_000, 1_800_000]`（5 次，1 小时内放弃）与 `DELIVERY_MAX_ATTEMPTS` |
| 内核 | `kernel/cards.ts` 由 `attempt` + 常量算出 `retryAt`（纯函数）；预算用尽 `retryAt=null` 即 give up                                                   |
| 投影 | `cards` 增三列 `delivery_attempts` / `next_delivery_at` / `delivery_given_up`（DDL 变更 → 升版重建）                                                |
| 唤醒 | `kernel/next-wake.ts` 把 `cards.next_delivery_at` 纳入最早到期集合；`view-spec` 的 `clock.tick` 切片补 `cards`                                      |
| 宿主 | `host/channels.ts`：投递前查 `nextDeliveryAt`，`inFlight` 键加 `attempt`，失败后写带 `retryAt` 的事实；启动补投所有待投卡                           |
| UI   | 卡片与通知条显示「未送达（第 N 次，下次 M 分钟后重试）」；give up 显示「已放弃」                                                                    |

**验收**：`tests/host/channels.test.ts`（断网 → 依次重投 → give up 后不再投 → 恢复网络后即使重投也不重复写 delivered）、`tests/kernel/decide.card.test.ts`（预算/`retryAt` 计算）、`tests/kernel/next-wake.test.ts`（卡片到期参与排期）、`tests/host/store/rebuild.test.ts`（三列重建后一致）。`KERNEL_VERSION=M35.0.0`。

### D. 规则暂停与补跑（仿 `pause / resume / replay --since`）

**现状**：`AutomationRule.enabled` 已有（规则页开关、`RulesManager.tsx:140`），但**禁用期间命中的事件无声丢弃**——没有记录，也就无法补跑。

**变更**

| 层                | 改动                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新投影表 `events` | 外部事件的最小快照：`id/source/type/subject/summary/detail_ref/link/hops/dedupe_key/origin_run_id/received_at/routed`（`routed` = 命中的规则 id 数组）。只存外部与派生事件，不存 `run.frames`；按 90 天裁剪（事实仍在，重建可恢复全量）              |
| 事实              | 新增 `event.skipped{eventId, ruleId, reason:'rule-disabled'}`；`rule_fires` 增 `status`（`fired` \| `skipped`）与 `event_id` 两列（DDL 变更 → 升版重建）                                                                                             |
| 内核              | `kernel/rules.ts` 匹配时：禁用规则命中 → 只写 `event.skipped` + `rule_fires{status:'skipped'}`，不建任务；启用规则照旧                                                                                                                               |
| 新命令            | `rule.replay{ruleId, since, until}`（宿主输入侧读 `events` + `rule_fires` 切片）：对每条 `skipped` 事件重放一次匹配，产 `event.received{replayedFrom}` 等价事实；`(ruleId, eventId)` 幂等，重复补跑零新事实。命令返回 `{replayed, created, skipped}` |
| 视图              | `events.bySource` / `events.recent`、`rule.fires{ruleId}`；规则页「跳过的事件（N）」抽屉 + 「补跑」按钮（带 since 选择）                                                                                                                             |
| 提示词            | 补跑建出的任务与正常任务逐字一致（不新增提示词段）                                                                                                                                                                                                   |

**验收**：`tests/kernel/decide.rules.test.ts`（禁用命中只记 skipped）、`tests/host/store/views.test.ts`（events 与 fires 视图）、`tests/host/commands.test.ts`（replay 幂等：跑两次第二次 `created=0`）、e2e 一条「暂停 → 发 3 条事件 → 恢复 → 补跑 → 3 个任务」。`KERNEL_VERSION=M35.1.0`。

---

## M36 · 运维可见性

### E. 用量与成本口径（仿 `spend`：rounds / tokens / cached / cost + 缺值单独计）

| 层       | 改动                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 契约     | `RunUsage` 增 `costUsd?: number \| null`（存在 `usage_json` 里，**无 DDL 变更**）                                                                                 |
| 执行器   | `claude`（stream-json 的 `total_cost_usd`）、`dsh`、`hermes`（ACP usage 帧）各自映射；无成本就 `null`，不估算                                                     |
| 宿主视图 | 新增 `usage.daily` / `usage.byAgent`：按天聚合 rounds、input/output/cacheRead/cacheWrite token、cost，另出 `missing*` 计数（无 usage 的轮次单独计，**不当作 0**） |
| UI       | 设置页新增「用量」栏（今日 / 近 7 天 / 按智能体）；顶栏徽标只显示今日 cost，缺失时显示「部分缺失」                                                                |

**验收**：`tests/host/store/views.test.ts` 聚合用例（含缺值口径）、各执行器 fixtures 的 cost 映射用例、`tests/protocol/entities.test.ts` 形状。不升版。

### F. 规则预演与下次触发（仿 `rules explain` / `emit --dry-run`）

| 层         | 改动                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 内核纯函数 | `previewEvent(view, event, now, env)` → `{ matches: [{ruleId, enabled, workflowId, stageId, title, threadKey}], wouldCreate }`，零事实                             |
| 入口       | 新增宿主内部输入 `rule.preview`（零事实，`viewSpec` 声明切片）：宿主调纯函数，把结果放进 `DispatchResult.value`（与 `review.export` 同款「内核零事实、宿主给值」） |
| 视图       | 宿主视图 `rules.next`：每条 cron 规则的 `nextCronTime`（`kernel/cron.ts` 已有）与「已禁用」标记                                                                    |
| UI         | 规则页：每条规则显示「下次触发 11-14 09:00」；「试跑一条事件」弹窗填 source/type/subject → 显示会建哪个任务、进哪个阶段、命中哪几条规则（只展示，不落库）          |

**验收**：`tests/kernel/preview.test.ts`（纯函数：单命中/多命中/禁用/无命中）、`tests/host/commands.test.ts`（预览零事实）、`tests/protocol/validate.test.ts`（输入校验）、e2e 一条 UI 用例。

### G. 性能基线（把 ARCHITECTURE 里那些数字变成仪器读数）

Architecture 验收表写着「装载 + `decide` p99 < 8ms（10 万事实 / 1 万任务）」「10 万事实重建 < 5s」「启动增量 < 100ms」，现在没有仪器。新增 `scripts/bench.mjs`（复用 `tests/host/store/rebuild.perf.test.ts` 的造数方式）：

| 指标                      | 口径                                                       |
| ------------------------- | ---------------------------------------------------------- |
| 装载 + `decide` p99 / p50 | 按 `viewSpec` 切片装载，10 万事实 / 1 万任务 / 1000 次采样 |
| 全量重建                  | 10 万事实，逐条 fold                                       |
| 启动增量                  | 已有 `projection_meta` 时不重建的启动耗时                  |
| 库体积                    | facts 行数与 db 文件大小                                   |

输出 markdown 表；基线写进新文件 `docs/testing/PERF.md`，每次跑出偏差 >20% 时在交付说明里点名。仓库当前无 `.github/workflows`，本计划**不新建 CI**，先本地可跑，nightly 留待 CI 立项。

### H. 数据目录 ACL 与子进程环境白名单

| 项   | 改动                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| ACL  | 启动时把 `app.getPath('userData')` 收紧：Unix `0700`，Windows 用 `icacls` 只留当前账号与 SYSTEM（不引依赖，失败记日志不阻断启动） |
| env  | 子进程环境白名单固化：`plugins/env.ts` 增断言用例「执行器/通道/外部插件都拿不到 `SAFE_STORAGE`/插件 secret/宿主路径以外的变量」   |
| 文档 | SECURITY 口径新增一条：ACL 挡的是其他系统账号，**不是同账号下的进程**，与 autoloop 的表述对齐                                     |

**验收**：`tests/main/workdir*.test.ts` 风格的新用例（Unix 权限位、Windows 跳过并标注）、`tests/host/plugins/env.test.ts` 扩展。

---

## M37 · 内核拆两层（P2 选项一）

**要解决的问题**：验收表写着「`src/kernel/` ≤2000 行」，实测 8.7k。红着的红线等于没有红线，且掩盖了真实问题——内核里已经长出一个编排引擎（阶段机、闸门、验收、评审、交接、任务树、提示词装配）。

### 拆法

```
src/kernel/
├─ decide.ts                表驱动 dispatcher（拼 handler 表；现 153 行，预算 ≤220）
├─ core/                    纯基础：预算 ≤2000 行
│   ├─ types.ts              View / Iso / Environment / Decision / KERNEL_VERSION / Reason（现 279 行）
│   ├─ facts.ts              事实构造器与序号（现散在 commands/common.ts，抽出来）
│   ├─ cron.ts               解析 + 下次时刻（现 274 行）
│   └─ next-wake.ts          下次唤醒（现 41 行，只依赖 core/types）
└─ scopes/                  决策域，各自一个目录 + 一个 handler 表
    ├─ run/                  claim / heartbeat / receipt / settle / cancel / usage
    ├─ card/                 open / answer / resolve / deliver 回写
    ├─ task/                 create / move / complete / stop / remove / comment / rerun
    ├─ thread/               归并与上下文派生（thread-context）
    ├─ workflow/             阶段机、出口、闸门、内置阶段
    ├─ review/               评审结论与逐条闭环
    ├─ automation/           规则匹配、cron 触发、事件接收
    ├─ agent/ runtime/ project/ chat/ plugin/
    └─ prompt/               提示词装配
```

`src/kernel/commands/` 与 `src/kernel/workflow/` 的内容分别落进对应 `scopes/<域>/`，不保留旧路径，也不加 re-export 兼容层（仓库明令不留兼容层）。

### 实际落地（2026-11-14）

拆成了两层，但**没按上面的目录图逐域建目录**——落地形态更扁平，理由写在下面：

```
src/kernel/
├─ decide.ts            95 行（预算 ≤220）：表驱动分派，见下面第 2 条
├─ core/                640 行 / 3 文件（预算 ≤2000）
│   ├─ types.ts         View / Iso / Environment / Decision / KERNEL_VERSION / Reason
│   ├─ cron.ts          解析 + 下次时刻
│   └─ next-wake.ts     下次唤醒（只依赖 core/types）
└─ scopes/              20 个域文件 + commands/ + workflow/
    ├─ cards.ts rules.ts run.ts threads.ts project.ts prompt.ts review.ts spawn.ts
    ├─ timeline.ts handoff.ts handoff-source.ts task-effects.ts thread-context.ts
    ├─ plugins.ts view-spec.ts
    ├─ commands/        agent automation card chat common review run runtime task thread workflow
    └─ workflow/        stage-machine / stage-acceptance / stage-handoffs / builtin-stages / …
```

与计划的差异（都是有意为之）：

1. **没有 `scopes/<域>/` 子目录**：`commands/` 里的文件本来就是按域命名的（`agent.ts` / `run.ts` / …），再套一层目录只增加 `../../` 深度，不增加边界信息。边界由 ESLint + 预算门禁守，不靠目录层数。
2. **`decide.ts` 换成了 handler 表（95 行）**：表用 `satisfies { [T in Input['type']]: HandlerOf<T> }` 逐键校验签名——少键、多键、输入类型对不上都是编译期错误，穷尽性没丢；分派处只有一次向下转型（键是联合类型，查表后 TS 收不窄）。`clock.tick` 的 handler 不吃 input，用一个忽略位保持表形状统一。`tests/architecture.test.ts` 的「命令 ↔ 分派」改为同时读 `case` 标签与对象键（`tableKeys`），白名单对不上仍然红。
3. **`core/facts.ts` 没抽**：事实构造器与「收到事件 → 序列化四类事实」绑在一起（`commands/common.ts` 里 `receivedEventFacts` 依赖规则匹配），单抽构造器只会把 `common.ts` 劈成两半、把 `scopes` 的调用点改成两个 import。等真有第二个消费者再抽。
4. **测试与源码同构**：`tests/kernel/{core,scopes}/…` 跟着移动；`tests/kernel/decide.*.test.ts` 覆盖 `decide.ts` 本身，留在 `tests/kernel/`。

门禁：`scripts/check-kernel-budget.mjs` 进 `check:fast`（`pnpm check:kernel`），实测 core 640/2000、decide 95/220、scopes 最大 `rules.ts` 674/900；`eslint` 新增 `src/kernel/core/**` 不得 import `scopes/**`（做过一次探针验证：故意加 `from '../scopes/rules'` 报 error 后还原）。顺带修了三个脚本的 `maxBuffer`：内核拆分让 `git diff` 超过 1 MB，`floor-guard` / `check-secrets` / `check-diff-coverage` 把 ENOBUFS 吞成「无法 diff」并以 exit 2 误报。

### 依赖规则（写进 SPEC-kernel 与 ESLint）

1. `core` 不 import `scopes`，也不 import `protocol` 以外的任何东西（ESLint `no-restricted-imports`）。
2. `scopes/*` 可 import `core`，跨域允许但**只许单向**：`run → task → thread → workflow/review/automation → prompt`；反向 import 需要显式评审。
3. `decide.ts` 只 import `scopes/**/handlers`，不写业务分支。

### 预算门禁

新增 `scripts/check-kernel-budget.mjs`（照 `floor-guard.mjs` 的写法）：`core/` ≤2000 行、单个 `scopes/<域>` ≤900 行、`decide.ts` ≤220 行；超限即 exit 1，接入 `check:fast`。ARCHITECTURE 验收表同步改成这两条预算，删掉旧的「kernel ≤2000 行」。现状参照：根文件最大 `thread-context.ts` 590 行、`rules.ts` 471、`review.ts` 467，单域预算 900 行留了余量。

### 迁移顺序（每步一个提交，`pnpm check` 必须绿）

1. 建 `core/`（纯搬移 + import 路径替换，行为零变化）。
2. 逐域搬 `scopes/`：run → card → task → thread → workflow → review → automation → 其余；每域搬完同步 `tests/` 的镜像路径。
3. `decide.ts` 收成表驱动。
4. 加预算门禁 + ESLint 方向规则；跑 `pnpm e2e` 全量。
5. 更新 ARCHITECTURE / SPEC-kernel / CAPABILITY-MAP 的模块表与路径。

**风险与对策**：一次性大面积改 import，冲突面最大 → 独占分支、期间禁止其他并行任务；用 `rg` 批量替换 + `tsc` 兜底，搬完每域立刻 `pnpm check`。数据层零变更，不需要升 `KERNEL_VERSION`，也不需要重建投影。

**验收**：`pnpm check` 全绿、覆盖率不低于 99.84/99.16/99.89/99.93、`pnpm e2e` 全绿、`node scripts/check-kernel-budget.mjs` 输出各项实测行数。

---

## 不在本计划内

| 项                                            | 原因                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `remote` 多机执行器落地                       | P2 未拍板；M37 之后再单独立项，先做「同机第二进程」的 loopback transport    |
| 对外 HTTP / 卡片网页 / MCP 客户端             | 与 IPC 三动词、单实例锁冲突                                                 |
| `rules.json` 热加载、零运行时依赖、系统服务化 | ARCHITECTURE 已列为不照抄项                                                 |
| 变异测试工具（Stryker 类）                    | 新基础设施；需要时按 autoloop 思路写 `scripts/mutate.mjs` 限定 `src/kernel` |
| CI 工作流                                     | 仓库当前无 `.github/workflows`；G 只交付本地脚本                            |

## 每步都要守的规矩

1. 新增事实类型必须同批补齐：`FactPayloads` → `kernel/project.ts` 的 case → `view-spec.ts` 切片 → `timeline.ts` 文案 → `tests/` 镜像用例 → SPEC/TEST-CASES 登记。B 的断言会自动拦住漏项。
2. 改 DDL 就升 `KERNEL_VERSION` 并接受一次重建；重建是常态，不做手写迁移。
3. 每步结束跑 `pnpm check`；动主进程启动/打包路径的跑 `pnpm e2e`；里程碑收尾跑 `pnpm e2e:packaged`。
4. 覆盖率不降、改动行 ≥90%、`floor`/`secrets`/`ui` 三门不放松（CONSTRAINTS 的 Exceptions 只在确有不可达防御分支时登记，附理由与到期）。
5. 每里程碑在 CONSTRAINTS 末尾追加一条复核记录（口径照 M14–M34 的写法），并同步 `docs/specs/` 与 `docs/testing/TEST-CASES.md`。

## 执行记录

| 日期       | 项  | 交付                                                                                                                                                                                                                                                                                                                                                          | 验证                                                                                                                                                                                                                                                     | 备注                                                                                                                                                                                                                                                                                                                                           |
| ---------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-14 | A   | `tests/sim/{rng,world,invariants}.ts` + `tests/sim/{random,invariants,crash}.test.ts` + `scripts/sim-crash{,-child}.mjs`                                                                                                                                                                                                                                      | `pnpm vitest run tests/sim` 17 passed（4.2s）；`node scripts/sim-crash.mjs 3` → `crash-sim ok restarts=3`；第一版用 `SIM_STEPS=1500` 跑 1047 步、25 种输入被接受，拒绝率 12%                                                                             | 11 条系统不变量：序号连续、投影追上日志、running 持租约、waiting 释租约、任务阶段存在、线程串行、跳数上限、终态卡收起、agent/run 引用完整、可复现、幂等。**过程中抓到一个真 bug（在 harness 侧）**：`list()` 没把参数透传给 `db.all()`，`task.move` 一步都没跑成——被「防退化」用例（`task.move` 接受数必须 > 0）抓住，修好后 25 类输入全部打到 |
| 2026-11-14 | B   | `tests/architecture.test.ts`（16 用例：kernel 零第三方 import、事实只由 `host/store` 追加、投影表只由 `host/store` 写、plugins 不 import host、renderer 不碰 electron/node、命令与分派一一对应、输入与视图切片一一对应、两张 `PROJECTION_TABLES` 一致、每张表有 DDL、每个事实类型有投影与时间线分支）+ `tests/support/source.ts`（剥离注释/字面量的扫描夹具） | `pnpm vitest run tests/architecture.test.ts` 16 passed；**反向验证**：临时给 `kernel/next-wake.ts` 加 `import 'node:fs'` → 断言变红并点名 `kernel/next-wake.ts:42`，`git checkout` 还原后 16 passed                                                      | 自检用例含「注释里的违规词不算违规」「字符串里的 SQL 仍算写入（SQL 只存在于字面量）」；后者是刻意的误报取舍                                                                                                                                                                                                                                    |
| 2026-11-14 | C   | 投递重试账：`protocol/channels` 曲线常量 + `Card` 三字段 + `cards` 三列 + `deliveryFacts` 重试/放弃 + `next-wake` 纳入排期 + `host/channels` 按 `nextDeliveryAt` 排期/补投/停止清理；`KERNEL_VERSION=M41.0.0`                                                                                                                                                 | `pnpm vitest run tests/kernel/decide.card.test.ts tests/kernel/next-wake.test.ts tests/host/channels.test.ts` → 77 passed；新增 sim 不变量「投递排期自洽」并配自检用例；`pnpm check` exit 0，改动行 352/352 = 100%；`host/channels.ts` 语句与分支双 100% | 老库/老事实归一（0 次 / 无排期 / 未放弃）由 `upgradeLegacyCards` + `normalizeCard` 负责；卡片 UI 的「未送达 / 已放弃」标记未做，留给 M36 用量栏一起收                                                                                                                                                                                          |
| 2026-11-14 | D   | 规则暂停与补跑：`event.skipped` / `rule.replayed` 两条事实 + `events` / `event_skips` 两张投影表 + `rule.replay` 命令（39 条命令）+ `eventThreadFacts` 的 `onlyRuleId` + 影子视图重放；`KERNEL_VERSION=M42.0.0`                                                                                                                                               | `pnpm vitest run tests/kernel/decide.rule-skip.test.ts tests/host/store/rule-replay.test.ts`（12 passed，含真库全链路：停用→跳过→恢复→补跑→重复补跑零事实→重建全等）；`pnpm check` exit 0，改动行 426/430 = 99.07%                                       | 规则页「跳过事件抽屉 + 补跑按钮」未做（数据与命令已就绪），与卡片「未送达」标记一起在 M36 收                                                                                                                                                                                                                                                   |

| 2026-11-14 | E | 用量与成本：`RunUsage.costUsd`（claude 映射 `total_cost_usd`）+ `usage.daily` / `usage.byAgent` 两条只读视图（窗口 + 缺失计数）+ 设置第六栏「用量」面板 | `pnpm vitest run tests/host/usage-views.test.ts tests/renderer/src/apps/ai-workflow/components/UsagePanel.test.tsx`（9 passed）；`pnpm check` exit 0，改动行 473/474 = 99.79% | 旧轮次没有成本（历史事实不动）；面板固定 7 天窗口，没做时间选择器 |

## 验收总表

| 2026-11-14 | F | 规则预演：内核 `previewEvent` / `nextRuleFires` + `rules.preview` / `rules.next` 两条视图 + 规则页「试跑事件」面板与「下次触发」 | `pnpm vitest run tests/kernel/preview.test.ts tests/host/rule-preview-views.test.ts tests/renderer/src/apps/ai-workflow/components/RulePreviewPanel.test.tsx`（13 passed）；`pnpm check` exit 0 | 预演不判断当前并发 / 线程状态，只回答「会不会被接、落到哪」；试跑结果不落库 |

| 2026-11-14 | G | 性能基线：`scripts/bench.mjs`（造数批量事务、装载 + decide / tick 分位、重建、启动增量、库体积、`--json`）+ `docs/testing/PERF.md` + 冒烟用例 | `node scripts/bench.mjs`；`pnpm vitest run tests/tools/bench.test.ts`（2 passed） | 基线指出「装载 + decide p99 56 ms」与验收表 8 ms 差 7 倍，瓶颈是按需装载缺失，另立改造项 |
| 2026-11-14 | H | 数据目录收紧（`host/secure-dir`，Unix 0700 / Windows icacls，失败不阻断）+ 启动接线 + env 凭据点名用例 + SPEC-host 安全边界 | `pnpm vitest run tests/host/secure-dir.test.ts tests/host/plugins/env.test.ts`（15 passed）；`pnpm check` exit 0 | `pnpm e2e` 必须补跑一次（改了主进程启动路径），排在 M37 收尾 |
| # | 里程碑 | 交付物 | 判定命令 |
| 2026-11-14 | M37 | 内核拆两层：`core/`（640 行）+ `scopes/`（域文件 + `commands/` + `workflow/`），`decide.ts` 表驱动 95 行；预算门禁进 `check:fast`；ESLint 禁 `core → scopes`；ARCHITECTURE / SPEC-kernel / CAPABILITY-MAP 同步 | `pnpm check` exit 0（212 文件 / 3593 用例，改动行 2720/2729 = 99.67%）；`pnpm e2e` 27 passed | 未按计划的 `scopes/<域>/` 子目录落地（扁平域文件 + `commands/` 已按域命名），差异与理由见 M37「实际落地」 |
| --- | ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| A | M35 | `tests/sim/*`、`scripts/sim-crash.mjs` | `pnpm vitest run tests/sim`、`node scripts/sim-crash.mjs 200` |
| B | M35 | `tests/architecture.test.ts` | `pnpm vitest run tests/architecture.test.ts`（故意改坏能红） |
| C | M35 | 投递重试账（三列 + 曲线 + 唤醒） | `pnpm vitest run tests/host/channels.test.ts tests/kernel/next-wake.test.ts` |
| D | M35 | `events` 投影 + `event.skipped` + `rule.replay` | `pnpm vitest run tests/kernel/decide.rules.test.ts tests/host/commands.test.ts` + e2e |
| E | M36 | `RunUsage.costUsd` + `usage.*` 视图 + 用量栏 | `pnpm vitest run tests/host/store/views.test.ts` + e2e |
| F | M36 | `previewEvent` + `rule.preview` + `rules.next` | `pnpm vitest run tests/kernel/preview.test.ts` + e2e |
| G | M36 | `scripts/bench.mjs` + `docs/testing/PERF.md` | `node scripts/bench.mjs` |
| H | M36 | 启动 ACL 收紧 + env 白名单断言 | `pnpm vitest run tests/main tests/host/plugins/env.test.ts` |
| I | M37 | `core/` + `scopes/` + 预算门禁 | `node scripts/check-kernel-budget.mjs`、`pnpm check`、`pnpm e2e` |
