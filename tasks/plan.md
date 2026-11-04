# 实施计划：M0 边界（内核 + 插件重构第一步）

## 概览

把 [refactor-plan](../docs/planning/refactor-plan.md) 的 M0 拆成 9 个可独立验收的任务（T1–T8 是实施，T9 是退出核对）：先立 `src/kernel` 边界护栏（纯度测试 + ESLint 禁入 + tsconfig 接线），把阶段状态机与阶段校验规则搬进 kernel 并保留旧路径，再补 M0 强制的可靠性项（WAL、`integrity_check`、单实例锁、数据导出），最后用打包冒烟验证 `node:sqlite` 在 Electron 45 产物里可用。全程**行为零变化**：不改契约、不改表结构、不动 UI。

任务明细与验收标准见 [todo.md](./todo.md)。

## 开工前置

- 从 `master` 切分支 `refactor/m0-boundary`，把起点 commit 记在这里：`________`（填 `git rev-parse master` 的值）。
- 备份一份当前 `ai-workflow.db`。
- 门禁命令统一带 `CONSTRAINTS_BASE=<起点 commit>`：`CONSTRAINTS_BASE=xxx pnpm check`。

## 收尾执行记录（2026-11-04 晚，分支 `refactor/m0-exit`）

T1/T2 所在分支 `refactor/m0-boundary` 已由用户合并进 `master`（tip `33e22e8`），但 T3–T9 当时并未完成。收尾从 `33e22e8` 切出 `refactor/m0-exit`，把剩余 6 个任务并行做完：

| 任务    | 内容                                                | commit    | 状态               |
| ------- | --------------------------------------------------- | --------- | ------------------ |
| T4      | 阶段校验搬入 kernel 纯函数                          | `84f6bd7` | ✅                 |
| T5 + T8 | WAL / busy_timeout / integrity_check + 只读导出脚本 | `5b026a6` | ✅                 |
| T6      | e2e 独立临时 userData                               | `257d9b5` | ✅                 |
| T7      | 单实例锁 + second-instance 唤出                     | `f2b3985` | ✅                 |
| T3      | 打包冒烟（node:sqlite 可用性）                      | `22350ca` | ✅ 通过，M1 可开工 |
| 脚本    | 注册 `db:export` / `e2e:packaged`                   | `aaef310` | ✅                 |

与计划的偏差（已核实无行为风险）：

1. **T5 与 T3 并行**：计划把 T5 排在 T3 结论之后；实际 T5 代码不依赖打包结论，只有「是否进 M1」受 T3 约束，T3 已通过。
2. **打包冒烟用例名**为 `e2e-packaged/packaged-sqlite.spec.ts`（非计划里的 `packaged-smoke.spec.ts`），另抽出 `e2e-packaged/helpers/temp-userdata.ts` 做临时 userData。
3. **T4 额外补 1 条 `workflowUpdate` 非法阶段用例**：把校验抽成纯函数后，更新侧适配分支需要独立覆盖（改动行覆盖率门禁），原测试断言未动。
4. **T3 证据口径**：打包进程内 Node 为 24.22.1（Electron 45.1.0 内置），不是本机 shell 的 22.22.3；`readOnly` / WAL / integrity_check 行为两边一致。
5. **检查点 A 的复核注记**：起点树 `pnpm check` 全绿、556 用例；`refactor/m0-boundary` 分支另含文档/护栏类提交 3 个，无越界代码改动。

## 已核实现状（2026-11-04）

| 事实                                                                                                                          | 证据                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/kernel`、`src/protocol`、`src/sdk`、`src/host`、`src/plugins` 均不存在                                                   | 目录实测                                                                                                 |
| 阶段状态机是 `src/shared/stage-machine.ts`（116 行，纯函数），调用方仅 `engine.ts`、`runner.ts`、自身测试                     | `src/main/ai-workflow/engine.ts:2-9`、`runner.ts:10`                                                     |
| repository 的阶段校验在 `validateStages`（`:418-435`）；`:474-492` 是 `workflowUpdate` 事务体内联的阶段回挂逻辑，不是函数     | `src/main/ai-workflow/repository.ts:418-435,474-492`                                                     |
| 无单实例锁、无 WAL、无 `busy_timeout`、无 `integrity_check`                                                                   | `src/main/index.ts`、`src/main/ai-workflow/db.ts:8-20` 均无命中                                          |
| 无事实/数据导出脚本、无打包冒烟                                                                                               | `scripts/` 仅 4 个检查类脚本；`e2e/*.spec.ts` 全部 `electron.launch({args:['.']})`，跑 `out/` 不是安装包 |
| ESLint 只有三段（全局 / renderer / main），无 kernel、protocol 规则                                                           | `eslint.config.mjs:13,28,55`                                                                             |
| 两个 tsconfig 都是 `composite: true`，include 未含新目录；import 到 include 之外的文件会触发 TS6307                           | `tsconfig.node.json:3,19-26`、`tsconfig.web.json:3,23`                                                   |
| 改动行覆盖率门禁要求「改动的 `src/**` 源码文件必须出现在 coverage 数据里」，纯类型文件只有命名为 `types.ts` / `*.d.ts` 才豁免 | `scripts/check-diff-coverage.mjs:101-103,131-136`                                                        |
| floor-guard 把「测试文件被删、且其被测源文件仍存在」判为 `test-deleted` 违规                                                  | `scripts/floor-guard.mjs:104-108`                                                                        |
| 覆盖率阈值 98/93/95/98；`src/main/index.ts` 已被 `src/main/index.test.ts` 动态加载（覆盖率里有它），改它必须同步扩测试        | `vitest.config.mts:18-23`、`src/main/index.test.ts:117-121`                                              |

## 架构决策

1. **M0 不新建 `src/host`、不拆 `protocol` 实体。** db 改动留在 `src/main/ai-workflow/db.ts`，M1 才按「文件去向」搬成 `host/db.ts`。一次只换一层。
2. **kernel 的类型来源用一个过渡桥接：`src/protocol/types.ts` 仅 `export type` 转发 `src/shared/ai-workflow-api` 中 kernel 需要的类型**（`Task`、`WorkflowStage`、`WorkflowWithStages`、`StageInput`）。这样 kernel 不直接依赖 shared，M1 拆 `protocol/entities.ts` 时把定义挪过来即可，桥接文件随之消失。文件名必须是 `types.ts`，否则改动行覆盖率会要求它被测试导入。
3. **纯度测试放在 `src/kernel/purity.test.ts`，扫描 `src/kernel/**/*.ts` 时排除 `*.test.ts`。** 测试自己要读盘（`node:fs`），ESLint 的 kernel 禁入段对测试文件覆写为 `off`。禁用符号取 ARCHITECTURE「边界守则 1」的可扫描清单：`electron`、`node:fs`、`node:child_process`、`node:http`、`fetch`、`Date.now()`、`Math.random()`、`randomUUID()`。同时 kernel 的 import 白名单只有 `src/protocol/**`：ESLint 除 Electron / Node 内置外还要禁 `**/shared/**`、`**/main/**`、`src/host`、`src/plugins`、`src/renderer`，否则「kernel 不直连 shared」只是口头约定。
4. **`src/sdk` 不在 M0 创建**（与 refactor-plan M0 行的「三个骨架」有偏差，见开放问题 1）。sdk 只有类型接口、M0 无消费者；`index.ts` 命名会触发改动行覆盖率红灯，写成空壳又违反 CONSTRAINTS 的 Floor（禁止未实现桩）。
5. **测试文件不搬家。** `src/shared/stage-machine.test.ts` 原地保留，改作「旧路径 re-export 契约测试」；kernel 侧只加一个薄冒烟测试锁住导出面。理由：物理移动会删除该测试文件，而 `src/shared/stage-machine.ts` 仍存在（re-export），floor-guard 会判 `test-deleted`。M1 删除旧路径时源文件与测试一起删，即可正常迁移。
6. **`repository.ts:474-492` 的阶段回挂逻辑不在 M0 外迁。** 它读旧 `current_stage_id`/`position` 再重建阶段，属于 DB 耦合的搬迁逻辑，M1 阶段投影化（`stage.created/updated/deleted` + tombstone）时才自然变成 kernel 规则。M0 只搬 `:418-435` 的纯校验。
7. **打包冒烟是「结论级」任务，不是「修好」任务。** 按 refactor-plan 风险表：`node:sqlite` 在打包产物不可用就暂停 M1，不在此处硬修。
8. **打包冒烟用例独立成 `e2e-packaged/` 目录 + `playwright.packaged.config.ts`。** 默认 `pnpm e2e` 的 `testDir: ./e2e` 会把同目录 spec 一并收走，而它依赖 `dist/` 安装包，混在一起会让检查点 B 恒红。
9. **所有 e2e 启动都拿独立 `--user-data-dir`。** 单实例锁上线后，共用真实 userData 的 5 条现有 e2e 会被本机已开的实例挡住（`firstWindow` 超时）；抽 `e2e/helpers/launch.ts` 统一传临时目录。
10. **M0 在独立分支上做，并把起点 commit 记进本计划。** 当前就在 `master` 上，`check-diff-coverage` 与 floor-guard 默认 `merge-base master HEAD`，在 master 上等价于「无改动、跳过」——门禁会假绿。开工前切 `refactor/m0-boundary`，验收命令带 `CONSTRAINTS_BASE=<起点 commit>`。
11. **门禁脚本必须在非沙箱终端跑。** 三个脚本都用 `execFileSync('git', { stdio: pipe })`，沙箱下 `spawnSync git EPERM` → exit 2（「无法判定」），不代表代码失败；沙箱内只信 `typecheck` + `lint` + `test:coverage` 三项。

## 任务索引

```
T1 ──→ T2 ──→ T4 ─────────────────────┐
T3 ──→ T5 ──→ T8 ─────────────────────┼─→ 检查点 B（pnpm check + 手动验收）
T6 ──→ T7 ────────────────────────────┘        └─→ T9 ──→ 检查点 C
```

| 编号 | 任务                                               | 依赖               | 规模 |
| ---- | -------------------------------------------------- | ------------------ | ---- |
| T1   | 目录接线 + ESLint 禁入矩阵（kernel 只许 protocol） | 无                 | M    |
| T2   | 阶段状态机 + 纯度测试搬入 kernel，旧路径 re-export | T1                 | S    |
| T3   | 打包冒烟：验证 `node:sqlite` 在打包产物可用        | 无（可与 T1 并行） | M    |
| T4   | `repository.validateStages` → kernel 纯函数        | T2                 | S    |
| T5   | WAL + `busy_timeout` + `integrity_check`           | T3 结论通过        | S    |
| T6   | e2e 启动隔离（各用例独立临时 userData）            | 无                 | S    |
| T7   | 单实例锁 + 二次启动唤出窗口                        | T6                 | S    |
| T8   | 数据导出脚本（M1 前的备份底）                      | T5                 | S    |
| T9   | 复跑打包冒烟 + M0 退出核对                         | T4,T5,T7,T8        | S    |

## 检查点

- **检查点 A（T1-T2 后）**：`pnpm check` 全绿（非沙箱终端，带 `CONSTRAINTS_BASE`；沙箱内以 `typecheck` + `lint` + `test:coverage` 为准）、`stage-machine` 分支覆盖 100%、反向验证（kernel 里临时写 `Date.now()` 会失败）已做并回滚。
- **检查点 B（T4-T8 后）**：`pnpm check` 全绿；`pnpm e2e` 全绿（5 条现有用例，各自独立 `--user-data-dir`）；手动验收：开发模式跑一轮真实 CLI、双开被挡、db 出现 `-wal` 文件。
- **检查点 C（M0 退出）**：T9 完成；覆盖率不低于基线（99.60/96.68/99.39/99.79）；迁移清单中 M0 相关项有测试或手动证据。

## 风险与对策

| 风险                                                                          | 影响 | 对策                                                                                                    |
| ----------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------- |
| 新增 `src/kernel/**` 文件没被任何测试 import → 改动行覆盖率直接红（exit 1）   | 高   | 每个新源码文件在同一个任务里带测试；纯类型文件必须叫 `types.ts`                                         |
| tsconfig `composite` 触发 TS6307：shared 的 re-export 把 kernel 拉进 web 工程 | 高   | T1 一次性把 `src/kernel/**`、`src/protocol/**` 加进两个 tsconfig 的 include                             |
| 纯度测试误报：注释/字符串里出现 `Date.now` 字样                               | 中   | 扫描前剥离注释与字符串字面量，或按「`Date.now(` 后跟 `(`」这类带调用括号的模式匹配                      |
| kernel 测试文件需要 `node:fs`，与 kernel 禁入冲突                             | 中   | ESLint 对 `src/kernel/**/*.test.ts` 覆写 `no-restricted-imports: off`；纯度扫描排除测试文件             |
| `:memory:` 库无法启用 WAL                                                     | 中   | `journal_mode` 设置失败只对文件库断言；`:memory:` 用例断言打开成功即可                                  |
| 单实例锁让 e2e 并行/重复启动失败                                              | 中   | e2e 串行（`workers: 1`）；打包冒烟用独立 `--user-data-dir`；同一进程内用例用 `vi.resetModules()` 分离   |
| 打包体积/启动变慢（预算未测）                                                 | 低   | 只记录，不设阈值（CONSTRAINTS「Measured, not yet enforced」）                                           |
| 修 `db.ts` 引入的行为回归                                                     | 中   | 现有 `db.test.ts`、`migrate.test.ts`、`repository*.test.ts` 全绿是硬指标；改动只加 pragma，不改迁移逻辑 |
| 单实例锁与现有 e2e 共用真实 userData → 互相锁死                               | 高   | 先做 T6（独立临时 `--user-data-dir`）再上 T7（决策 9）                                                  |
| 在 `master` 上跑 diffcov / floor → 无 diff、假绿                              | 高   | 独立分支 + `CONSTRAINTS_BASE=<起点>`（决策 10、开工前置）                                               |
| WAL 侧车与「只读导出、库文件不变」冲突                                        | 中   | 应用退出后导出；判据改为主库字节哈希不变，允许 `-wal` / `-shm` 侧车                                     |

## 已确认的决策（2026-11-04，按建议执行）

1. **`src/sdk` 推迟到 M1** 首个消费者（执行器/宿主装配）时再建，M0 不建空壳。
2. **「事实导出」在 M0 的等价物 = 全表 JSON 导出脚本**（T8，只读、幂等），M1 换成事实日志导出。
3. **`repository.ts:474-492` 的阶段回挂推到 M1**，随阶段投影化（`stage.created/updated/deleted` + tombstone）一起处理。
4. **打包冒烟不纳入 `pnpm check`**，独立成 `pnpm e2e:packaged`（`check` 保持 ~90 s 量级）。

## M1 预置决策：数据模型层（已确认，不在 M0 执行）

- **不引第三方 ORM。** 模型层用自己的实体类型 + 行映射，零依赖；ORM 的迁移能力在本项目用不上（投影可丢弃、schema 变化靠重建），代价（RC 版本、打包体积、Electron 主进程依赖）不划算。
- **实体类型放 `src/protocol/entities.ts`**（M1 由 `shared/ai-workflow-api.ts` 拆出），`src/protocol/types.ts` 的过渡桥接随之删除。
- **`src/host/store/**` 全量接管读写**：所有 `SELECT / INSERT / UPDATE / DELETE` 只在 store 内出现，投影应用（`Change[]`）与视图装载都在这里；调用方只拿实体对象，不再出现 `as unknown as XxxRow`。
- **`src/main/ai-workflow/repository.ts` 在 M1 结束时删除**，其 SQL 逐条迁入 store；迁移期内不在两处并存写路径（refactor-plan 总原则 2）。
- 禁止 kernel、插件、renderer 直连数据库；模型层是唯一出口，`why` 链仍由事实日志承担。

## 不在本次范围

M1 的 facts 表/投影/重建；`protocol` 的命令与视图校验；`src/host`、`src/plugins` 目录；UI 侧任何改动；`SPEC-*.md` 的行为重置；任何迁移脚本。

## 与 refactor-plan M0 行的偏差

| refactor-plan M0                                | 本计划                                     | 理由                 |
| ----------------------------------------------- | ------------------------------------------ | -------------------- |
| 建 `src/kernel`、`src/protocol`、`src/sdk` 骨架 | 建 kernel + protocol（仅 `types.ts` 桥接） | 见决策 4、开放问题 1 |
| 主要文件 `host/db.ts`                           | 仍是 `src/main/ai-workflow/db.ts`          | 见决策 1             |
| 「事实导出脚本」                                | 全表 JSON 导出脚本                         | 见开放问题 2         |
| 「把 `repository` 里的阶段规则搬进 kernel」     | 只搬 `:418-435`                            | 见决策 6、开放问题 3 |
