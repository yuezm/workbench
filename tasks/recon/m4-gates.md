# M4 测绘：审批与通道的门禁、基线、受影响测试与验收

> 只读测绘（2026-11-05）。当前分支 `master` = `refactor/m3-executors` @ `3d0c40d`，工作区干净；无 `refactor/m4` 分支。证据均写 `相对路径:行号`。
> 本文会被 `floor-guard` 逐行扫描（`.md` 无豁免），故不含任何抑制注释/未完成标记/测试跳过写法。

## 0. 结论速览

| 项          | 结论                                                                                                                                        | 证据                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 门禁入口    | `pnpm check` = check:fast（typecheck+lint+floor+secrets）→ test:coverage → check:diffcov → audit                                            | `package.json:23-28`                                                                         |
| 耗时        | 整链预算约 90s；vitest 实测 10.47s（91 文件/1097 例）；e2e 6 例 8.0s + 构建                                                                 | `CONSTRAINTS.md:56`、`tasks/plan.md:112`、`check-run-m3.log:191-194`、`e2e-run.log` 尾部     |
| 覆盖率基线  | 99.81 / 97.92 / 100 / 100（阈值 98/93/95/98）；改动行 693/695=99.71%（门槛 90%）                                                            | `CONSTRAINTS.md:40,69`、`refactor-plan.md:94`、`vitest.config.mts:18-23`                     |
| floor-guard | 逐行扫新增（含未跟踪全文）；删测试/断言之«净减少»才红；只对整文件搬家有映射表                                                               | `scripts/floor-guard.mjs:79-101,118-170`                                                     |
| M4 现状     | `run.waiting` 已入账但 `cardIds` 恒空；无 `cards` 表、无 `card.*` 事实、无 `kernel/cards.ts`、无 `plugins/channels/**`、无 `host/notify.ts` | `src/kernel/run.ts:207-229`、`src/kernel/project.ts:98-111`、`src/host/schema.ts:326-345`    |
| e2e         | 每条用例独立临时 `--user-data-dir`，**不打真 CLI**；进程断言有现成范式（`process_registry` 行数 + pid 存活）                                | `tests/e2e/helpers/launch.ts:50-58`、`crash-recovery.spec.ts:35-46`、`seed-crash.ts:189-209` |

## 1. 门禁命令做什么、怎么失败

### 1.1 `pnpm check` 的子步骤（`package.json:27-28`）

| 步骤          | 命令                                   | 做什么                                             | 失败表现                                                                                                         |
| ------------- | -------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| typecheck     | `tsc --noEmit` ×2（node/web 工程）     | 含 `tests/**` 与 e2e 的零类型错误                  | tsc 逐行 `error TSxxxx`，exit 1                                                                                  |
| lint          | `eslint .`                             | 含架构边界 `no-restricted-imports`；warning 不阻断 | 有 error 时打印规则+位置，exit 1                                                                                 |
| floor         | `node scripts/floor-guard.mjs`         | `merge-base(master,HEAD)` 范围的门槛违规           | `floor-guard: N floor violation(s):` + `[rule] file: text`，exit 1；无法运行 exit 2（`floor-guard.mjs:236-243`） |
| secrets       | `node scripts/check-secrets.mjs`       | diff 新增行扫 5 类密钥 + 通用赋值；值隐去          | `[rule] file:line` 列表，exit 1；无法运行 exit 2（`check-secrets.mjs:101-107`）                                  |
| test:coverage | `vitest run --coverage`                | 全量单测+契约测试并卡覆盖率阈值                    | 低于阈值打印 `ERROR: Coverage for ...`，exit 1（`vitest.config.mts:17-23`）                                      |
| check:diffcov | `node scripts/check-diff-coverage.mjs` | 改动可执行源码行覆盖率 ≥90%                        | 逐文件 `covered/changed` + 合计不达标，exit 1；缺数据 exit 2（`check-diff-coverage.mjs:14,143-153`）             |
| audit         | `pnpm audit --prod --audit-level=high` | 生产依赖漏洞                                       | 有 high+ 时 exit 1                                                                                               |

- `pnpm check:fast`（`package.json:27`）就是前四步，秒级；不含覆盖率与审计。
- `format:check`（Prettier）**不在** `check` 内（`package.json:30`），只在 pre-commit 的 lint-staged 跑（`CONSTRAINTS.md:51-58`）。
- `pnpm test`（`vitest run`）不卡覆盖率阈值；只有 `test:coverage` 卡。
- 耗时实测：vitest 10.47s / 11.44s（`check-run-m3.log:194`、`check-run-m3-master.log:202`）；`pnpm e2e` = `build:compile` + Playwright，6 例 8.0s（`e2e-run.log` 尾部），总约 40–60s；typecheck/lint/audit 无逐项实测，整链按 90s 预算。

### 1.2 两个会让门禁「假绿」的坑（M4 必踩）

1. 直接在 `master` 上改：`merge-base master HEAD` 退化成 HEAD，diff 为空 → floor/diffcov 假绿（`scripts/floor-guard.mjs:31-34`、`check-diff-coverage.mjs:51-53`；`tasks/plan.md:62`、`tasks/m3-todo.md:271`）。M4 必须开 `refactor/m4` 或设 `CONSTRAINTS_BASE=3d0c40d`。
2. 沙箱里 `execFileSync('git', ...)` 被拒 → 脚本 exit 2；门禁要在非受限终端跑（`tasks/plan.md:63`）。

## 2. 覆盖率基线与 `check:diffcov`

- 项目阈值：statements 98 / branches 93 / functions 95 / lines 98（`vitest.config.mts:18-23`、`CONSTRAINTS.md:21`）。
- 基线（M3 退出，不得下降）：**99.81 / 97.92 / 100 / 100**（`CONSTRAINTS.md:40,69`、`refactor-plan.md:94`）。跌破基线即 finding（即使仍高于 vitest 阈值，`CONSTRAINTS.md:21`）。M4 退出须 ≥ 此值，并更新 `CONSTRAINTS.md` 的 M4 复核行（保留原行另起，见 `CONSTRAINTS.md:69-70`）。
- 改动行：`check:diffcov` 默认 base `master`、门槛 90%，可用 `--base <ref>` / `CONSTRAINTS_BASE` / `MIN_DIFF_COVERAGE` 覆盖（`check-diff-coverage.mjs:10-14`）。
- 前置是 `coverage/coverage-final.json`（`check-diff-coverage.mjs:32-37`），故顺序固定为 `test:coverage` → `check:diffcov`。
- 规则：只算 `src/**/*.ts(x)` 且非 `*.test.*`；纯类型文件**只认** `types.ts` / `*.d.ts`，否则必须被测试导入；未跟踪文件全文按新增行计；完全没进覆盖率数据的改动源码文件直接判红（`check-diff-coverage.mjs:87-99,101-103,130-136`）。
- M3 实测：693/695 = 99.71%（`refactor-plan.md:94`、`check-run-m3.log:382`）。

## 3. floor-guard 对 M4 的约束

| 机制               | 位置                     | 对 M4 的含义                                                                                                              |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 三类逐行规则       | `floor-guard.mjs:82-101` | 新增行（含全部未跟踪文件、含本 `.md`）不得出现抑制注释、未实现桩、测试跳过写法；`scripts/**` 与 `CONSTRAINTS.md` 正文例外 |
| 删测试             | `:147-152`               | 删 `*.test.ts` 需「被测源码同删」或命中 `RELOCATED_TESTS`，否则 `test-deleted`                                            |
| 断言净减少         | `:162-170`               | **同一文件**内删除的 `expect/assert/should` 行数 > 新增行数 → `assertion-removed`                                         |
| 整文件搬家映射     | `:118-145`               | 现 10 条；只匹配整文件删除+新增。把 `decide.run.test.ts` 的 waiting 用例**拆**到新文件不会命中，只会被判断言减少          |
| CONSTRAINTS 规则行 | `:172-234`               | 改规则行必须保留原行、另起一行补充（`CONSTRAINTS.md:69-70`）                                                              |
| 测试文件识别       | `:79`                    | `.test.` / `.spec.` / `_test.` / `test_` 前缀都算测试；新测试命名沿用 `tests/**/<name>.test.ts(x)` 即可                   |

M4 新增通道插件位于 `src/plugins/channels/**`，ESLint 已有对应禁入段（`eslint.config.mjs:75-90,105-148`），`tests/plugins/boundary.test.ts:22` 的 `KIND_DIRS` 也已包含 `channels`——但边界测试**只实际扫描 executors**（`:254-275`），通道侧等于零门禁，必须扩表。

## 4. M4 落点现状（要补的机制）

- 回执已解析并校验 `ask/notices/resolves/later/events`，但内核只处理 `ask`（`src/protocol/inputs.ts:69-97`、`src/protocol/validate.ts:479-486`、`src/kernel/decide.ts:827-830`）。
- `run.waiting` 事实与投影已存在，`cardIds` 恒为 `[]`（`src/kernel/run.ts:212-229`、`src/kernel/project.ts:103-111`）；挂起释放租约/并发位已实现（`run.ts:42-51`、`src/host/scheduler.ts` 由 `run.receipt` 路径收尾）。
- 无 `cards` 表：投影全集为九表（`src/host/schema.ts:326-345`、`src/kernel/types.ts:43-53`），无 `View.cards`（`types.ts:81-94`）。
- 无 `card.*` 事实：事实名全集结束于 `message.appended` / `snapshot.imported`（`src/protocol/facts.ts:29,44-79`）。
- 无 `card.answer` 命令：命令全集 14 条（`src/protocol/commands.ts:11-26`），宿主内部输入 11 条（`src/protocol/inputs.ts` 中 `HOST_INPUT_NAMES`）。
- 无通道目录与宿主通知模块：`src/plugins/` 下只有 `executors/`、`shared/`；`src/host/` 无 `notify.ts`（SPEC 计划位置见 `docs/specs/SPEC-host.md:26,44,48`）。
- 桌面通知当前只有旧契约 `window.workbench.notify` → `main/ipc.ts:1-9`（SPEC 明确 M5 前兼容，`SPEC-host.md:73`）。
- `effects.afterCommit` 只分发「唤醒调度器 / 取消 / changed」（`src/host/effects.ts:44-70`），卡片投递要在这里接。
- 启动装配顺序被 `tests/host/boot.test.ts:467-478` 固定，SPEC 要求启动 sources/channels（`SPEC-host.md:98`）。
- 迁移清单要求：`waiting` 不占并发位、「执行中」= queued/running/waiting、终态归一与取消时序不变（`refactor-plan.md:129-144`）。

## 5. 受 M4 影响的既有测试（file:line）

### 5.1 清单/契约类：改常量必红，需同一提交同步

| 文件:行                                                           | 现在断言                                                               | M4 怎么改                                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `tests/protocol/facts.test.ts:44-85,89-99`                        | `FACT_TYPES` 精确数组 + 前缀白名单（无 `card`）                        | 追加 `card.opened/updated/delivered/delivery_failed/answered/resolved`，前缀加 `card`           |
| `tests/protocol/commands.test.ts:12-32`                           | `COMMAND_NAMES` 精确 14 条                                             | 若 `card.answer` 走命令面，追加并同步 `Command` 联合类型                                        |
| `tests/protocol/inputs.test.ts:95-111`                            | `HOST_INPUT_NAMES` 精确 11 条、与命令不交叠                            | 若回答走宿主输入则追加；`:200-235,343-355` 的 receipt 校验断言应保持                            |
| `tests/kernel/view-spec.test.ts:124-131,85-119`                   | 命令 14 / 宿主输入 11 的硬编码，逐输入映射                             | 追加新输入的切片；`:142` 断言「每条切片 < 投影全集」，投影变 10 表后仍成立                      |
| `tests/host/schema.test.ts:215-229,333-345`                       | 建 9 表精确清单、`PROJECTION_TABLES` 精确 9 项                         | 加 `cards` 后改这两处；投影指纹随 `KERNEL_VERSION` 变更（`src/kernel/types.ts:32` 现 `m3.0.0`） |
| `tests/host/db.test.ts:177-193,247-259`                           | `tableNames` 精确 12 表                                                | 加 `cards` 后改两处清单                                                                         |
| `tests/host/store/test-support.ts:209-318`                        | `PROJECTION_COLUMNS` 九表（重建/等价快照的列清单）                     | 加 `cards` 列，否则 rebuild 等价不覆盖卡片                                                      |
| `tests/host/boot.test.ts:467-478`                                 | 启动顺序精确数组（`executors/registry/reconcile/clock/scheduler/ipc`） | 通道启动/停止进装配后追加条目，并改 `:341-344` 的注册表 mock                                    |
| `tests/plugins/registry.test.ts:30`                               | 目录↔注册表一致性只扫 `executors`                                      | 通道注册后需同样扫 `channels`                                                                   |
| `tests/plugins/boundary.test.ts:201-205,254-275`                  | capability 用法规则只有 spawn/fs；只扫 executors                       | 加 `notify` 规则并扫 channels（否则「声明了没用到」双向一致判不出来）                           |
| `tests/e2e-packaged/packaged-sqlite.spec.ts:32-45`                | `EXPECTED_TABLES` 用 `arrayContaining`（12 表）                        | 非必改；建议加 `cards` 以覆盖打包建表                                                           |
| `tests/host/store/fake-kernel.ts:275` / `fake-kernel.test.ts:478` | 默认 `viewSpec` 返回全投影表                                           | 自动跟随，无需改，但断言「全表装载」仍成立                                                      |

### 5.2 行为断言类：语义变化会红，需改断言 + 补新例

| 文件:行                                                             | 现在断言                                                                       | M4 变化                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `tests/kernel/decide.run.test.ts:760-800`                           | 回执带 ask → 仅 `run.waiting`，`cardIds: []`（`:786`）                         | 同时产 `card.opened`（每条 ask 一张、`version=1`、`delivery='pending'`），`cardIds` 对应 |
| `tests/kernel/decide.run.test.ts:802-811`                           | ask 未带 sessionId 时保留旧值                                                  | 续接仍需保留；补「回答后 `resumeSessionId`/`turn+1`」用例                                |
| `tests/kernel/decide.run.test.ts:1239-1253`                         | waiting 对 `clock.tick` 零事实；queued/running/waiting 可取消                  | 卡片超时/`card.resolved` 若进 tick 需改；取消语义保持                                    |
| `tests/kernel/project.test.ts:411-414`                              | `run.waiting` 带 `cardIds:['card-1']` 只写 `runs`                              | 加 `cards` 投影后应同时写 cards 行（或改为断言「卡片由 card.* 事实单独写」）             |
| `tests/host/store/runs-projection.test.ts:296-334`                  | waiting 段 `cardIds: []`（`:320`），waiting→turn2 续接链                       | 卡片行进重建等价；`cardIds` 非空                                                         |
| `tests/host/store/views.test.ts:70-84,249-257,276,373`              | `run-waiting` 夹具与 `activeTaskIds`/`runs.active-by-task` 含 waiting          | 若 `View` 增 `cards`，补装载断言；现有 waiting 判定必须保持                              |
| `tests/host/reconcile.test.ts:246-256`                              | waiting run 保留状态、残留进程仍终止                                           | SPEC 要求对账后「waiting 保留卡片、只补投 pending」（`SPEC-host.md:48`），补断言         |
| `tests/host/scheduler.test.ts:1037-1049`                            | 用直接 `UPDATE runs SET status='running',turn=2` 模拟等待续接（T6 捷径）       | 真实路径是 `card.answered`→`run.queued`；保留该例并新增端到端等待→回答→领取例            |
| `tests/host/effects.test.ts:1-196`                                  | 只断言 run.queued 唤醒 / cancel / changed                                      | 新增 `card.opened/updated` 投递分发与通道异常隔离用例；现有 6 例不动                     |
| `tests/kernel/purity.test.ts:49-139`                                | 扫描 `src/kernel/**` 的 IO/时钟/随机数                                         | 新增 `kernel/cards.ts` 自动纳入，须保持纯函数                                            |
| `tests/main/ipc.test.ts:23-52`、`tests/preload/index.test.ts:51-56` | `notify` 契约形状不变                                                          | 兼容到 M5（`SPEC-host.md:73`）；桌面通道经宿主适配，预期不改                             |
| `tests/renderer/**`                                                 | 无任何 `waiting`/卡片 UI 断言（全仓 `src/renderer` 也 grep 不到 waiting/卡片） | M4 不做 UI；M5 才改，除非 M4 决定先落 in-app 批卡面板                                    |

grep 规模（便于评估回归面）：`waiting` 在测试中 47 处 / 11 个文件；`ask|cardIds` 19 处；测试里目前**没有** `cards` 表或通道断言。

## 6. E2E 隔离、真 CLI、以及「等待期零进程/零 Token」怎么断言

- 隔离：每条用例 `mkdtemp` 临时 userData + `electron.launch({ args:['.', '--user-data-dir=<tmp>'] })`，关闭即删；目录在 `tmpdir()`（`tests/e2e/helpers/launch.ts:6-9,22-24,46-58`）。打包冒烟复用另一份 helper（`tests/e2e-packaged/helpers/temp-userdata.ts`）。
- 必须剔除继承的 `ELECTRON_RUN_AS_NODE`，否则 Electron 退化成 Node（`launch.ts:33-43`、`docs/testing/TESTING.md:56`）。
- 现有 e2e **不打真 CLI**：`ai-workflow.spec.ts:16-58` 纯 UI；崩溃恢复种子是 `node -e setTimeout` 长睡进程（`seed-crash.ts:60-70`）。
- 现成进程断言范式：种子写 `process_registry`（`seed-crash.ts:152-156`）→ 启动后轮询 `isPidAlive` 为假、`readRecoveryState` 的 `runningRuns/registryRows` 归零（`crash-recovery.spec.ts:35-46`）；`readRecoveryState` 用独立只读连接 + `busy_timeout=5000` 可在应用运行中读库（`seed-crash.ts:188-209`）。
- M4 建议照同一范式加一条用例：`prepare` 里用真实 `createStore` 种 runtime/agent/workflow/task/claim 后 dispatch `run.receipt{ask:[…]}` 得到 waiting + cards；启动后只读轮询 `runs.status='waiting'`、`lease_id/deadline_at/usage_json` 为 NULL、`run_events` 行数不增、`process_registry` 为 0、`cards.delivery='pending'`（in-app 通道启动后应为 `delivered`）。回答用 `page.evaluate` 调桥（写法同 `crash-recovery.spec.ts:49-66`）或 `app.evaluate` 内 dispatch，再断言 `turn=2 / status='queued' / resume_session_id` 与旧会话一致、卡片 `answered`，「重复回答」返回拒绝。
- 真 CLI 验收**没有脚本**，是手工流程：复制真实库到临时目录，按 `--user-data-dir` 启动构建产物（`tasks/m2-todo.md:349`、`tasks/m3-todo.md:278`；参数形式同 `launch.ts:55-58`，即先 `pnpm build:compile` 再 `electron . --user-data-dir=<tmp>`）。M3 实测：阶段 4.0s/PONG、聊天 5.5s/PONG、取消 2.0s（`refactor-plan.md:95`）。

## 7. M4 验收证据清单

| #   | 命令/步骤                                                   | 期望                                                                                                                          | 依据                                               |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `pnpm check:fast`                                           | `floor-guard: clean`、`check-secrets: clean`、tsc/eslint 0 error                                                              | `package.json:27`                                  |
| 2   | `pnpm check`                                                | exit 0；覆盖率 ≥ 99.81/97.92/100/100；diffcov ≥90%（预期 >99%）；audit 无 high                                                | `CONSTRAINTS.md:21-24,69`                          |
| 3   | `node scripts/check-diff-coverage.mjs --base 3d0c40d`       | 逐文件 100% 或列出缺口；合计 ≥门槛                                                                                            | `check-diff-coverage.mjs:14,143-153`               |
| 4   | `pnpm test tests/kernel tests/host tests/plugins`           | 卡片/等待/通道新例全绿                                                                                                        | `vitest.config.mts:14`                             |
| 5   | `pnpm e2e`                                                  | 现有 6/6 + 新增「等待期零进程」≥1 = 7/7（先 build:compile）                                                                   | `e2e-run.log`、`playwright.config.ts:8-16`         |
| 6   | `pnpm e2e:packaged`                                         | 沿用 M2 已知问题（electron-builder 产物启动崩溃），只记录不纳入门禁                                                           | `refactor-plan.md:72,100`                          |
| 7   | 手动真 CLI：阶段一轮、聊天一轮、触发 ask→in-app 批→续接一轮 | 各轮 `succeeded`、输出 `PONG`；等待期任务栏无子进程（任务管理器/`process_registry`）；回答后同一 session 续接、`turn=2`       | `refactor-plan.md:95,162`                          |
| 8   | 手动桌面通道：真实 `Notification` 弹出                      | 标题/正文正确；卡片文字只做参数（不含脚本/HTML 拼接）                                                                         | `SPEC-plugins.md:255`、`SPEC-host.md:73`           |
| 9   | 文档收口                                                    | 更新 `CONSTRAINTS.md` M4 复核行、`refactor-plan.md` M4 退出记录、`TEST-CASES.md`/`TESTING.md` 基线；`tasks/m4-todo.md` 记证据 | `CONSTRAINTS.md:69-70`、`refactor-plan.md:160-162` |

## 8. 给 M4 的四条硬约束

1. 先开 `refactor/m4` 或固定 `CONSTRAINTS_BASE=3d0c40d`，否则 floor/diffcov 在 master 上假绿。
2. 新增任何 `src/**` 文件都必须被测试加载；纯类型入口命名 `types.ts`（`check-diff-coverage.mjs:101-103,130-136`）。
3. 新测试一律 `tests/**/*.test.ts(x)`，按层镜像；不要拆走既有用例的断言（会触发 `assertion-removed`，`floor-guard.mjs:162-170`）。
4. 本文件与 M4 计划文档会进 floor-guard 扫描范围（未跟踪文件全文），文档里同样不能出现那三类字面量。
