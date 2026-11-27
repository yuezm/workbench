---
type: plan
status: active
owner: lead
updated: 2026-11-28
---

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

**lead 复核（2026-11-14）**：接受以上四点落地形态。扁平 `scopes/*.ts` + 按域命名的 `commands/` 与计划图等价——边界由 ESLint（`core` 禁 import `scopes`）与行数预算门禁守，目录层数不承载额外约束；`decide.ts` 用 `satisfies` 逐键校验签名的 handler 表，穷尽性没有丢，比 switch 更可查。`core/facts.ts` 暂不抽（构造器与事件→事实序列化耦合、当前只有一个消费者）也接受，等第二个消费者出现再抽。

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

| 2026-11-14 | G | 性能基线：`scripts/bench.mjs`（造数批量事务、装载 + decide / tick 分位、重建、启动增量、库体积、`--json`）+ `docs/testing/PERF.md` + 冒烟用例 | `node scripts/bench.mjs`；`pnpm vitest run tests/tools/bench.test.ts`（2 passed） | 基线指出「装载 + decide p99 56 ms」与验收表 8 ms 差 7 倍，瓶颈是按需装载缺失，另立改造项（同日完成，见下条） |
| 2026-11-14 | G+ | 按需装载 `tasks`：`View.tasks` 改惰性 Map（`get`/`has` 按 id 单行查库，全量遍历才整表），语义与一次性装载等价 | `node scripts/bench.mjs`：装载 + decide p50 47.3→4.0 ms、p99 56.0→8.0 ms，tick p99 51.1→1.2 ms；`pnpm vitest run tests/host/store` 218 passed；`tests/host/store/lazy-tasks.test.ts` 覆盖各方法 | 整表 5000 行（≈40 ms）装载瓶颈消除；`floor-guard` 补登 M37 cron 测试搬家（rename 阈值退化成 delete+add）；PERF.md 基线同批更新 |
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
