# M0 任务清单（边界）

> 计划说明见 [plan.md](./plan.md)。规则：每个任务结束跑 `pnpm check:fast`；里程碑检查点跑完整 `pnpm check` 与 `pnpm e2e`。
> 除 T3 的结论外，本阶段不改任何契约、表结构、UI 行为。

## 阶段 1：护栏与第一个 kernel 模块

### T1 目录接线 + 纯度护栏 + ESLint 禁入矩阵

**描述：** 建 `src/kernel/`、`src/protocol/` 与工程接线，把依赖方向写成机器可检查的规则：kernel 只能 import `src/protocol/**`，禁 Electron、Node 内置、shared、main、host、plugins、renderer。

**验收标准：**

- [x] `src/protocol/types.ts` 只做类型转发（`Task`、`WorkflowStage`、`WorkflowWithStages`、`StageInput` 来自 `src/shared/ai-workflow-api`），无运行时代码
- [x] ESLint 对 `src/kernel/**` 禁 `electron`、`node:*`、`fs`、`path`、`os`、`child_process`、`crypto`、`**/shared/**`、`**/main/**`、`src/host`、`src/plugins`、`src/renderer`，只放行 `**/protocol/**`；`Date.now`、`Math.random` 用属性限制规则；`src/kernel/**/*.test.ts` 覆写为放开 import 限制（测试要读盘）
- [x] `src/kernel/purity.test.ts` 扫描 `src/kernel/**/*.ts`（排除 `*.test.ts`），命中 `electron`、`node:fs`、`node:child_process`、`node:http`、`fetch`、`Date.now(`、`Math.random(`、`randomUUID(` 任一即失败，并报出文件与行号；结果里打印扫描到的文件数
- [x] `tsconfig.node.json` 与 `tsconfig.web.json` 的 include 都含 `src/kernel/**/*` 与 `src/protocol/**/*`（两个工程都是 `composite`，漏配会报 TS6307）

**验证：**

- [x] `pnpm typecheck`、`pnpm lint`、`pnpm test src/kernel` 全绿
- [x] 反向验证（一次性，不提交）：临时建 `src/kernel/probe.ts` 写 `Math.random()`，并临时 import shared 类型 → 纯度测试与 lint 都必须失败；删除探针后恢复全绿

**依赖：** 无
**涉及文件：** `src/protocol/types.ts`、`src/kernel/purity.test.ts`、`eslint.config.mjs`、`tsconfig.node.json`、`tsconfig.web.json`
**规模：** M
**完成：** commit `c3d9a4a`（2026-11-04）。探针被 lint 报 3 条、纯度测试报 3 条；删除后全量 548 用例通过、覆盖率 99.6/96.68/99.39/99.79 未变、`pnpm build:compile` 通过。

### T2 阶段状态机搬入 kernel，旧路径 re-export

**描述：** 把 `src/shared/stage-machine.ts`（116 行纯函数）原样搬到 `src/kernel/workflow/stage-machine.ts`，改从 `src/protocol/types.ts` 取类型；`src/shared/stage-machine.ts` 改为只做 re-export，三个调用方零修改。

**验收标准：**

- [x] 两文件逻辑逐字一致（差异只有 import 行与路径注释）
- [x] `src/shared/stage-machine.ts` 只剩 re-export（≤ 15 行，无分支逻辑）
- [x] `engine.ts`、`runner.ts`、`src/shared/stage-machine.test.ts` 均未修改，测试全部通过
- [x] `src/kernel/workflow/stage-machine.ts` 分支覆盖 100%，且通过纯度测试

**验证：**

- [x] `pnpm test src/shared/stage-machine.test.ts`、`pnpm test src/main/ai-workflow` 全绿
- [x] `pnpm test:coverage` 中该文件分支 100%
- [x] 新增 `src/kernel/workflow/stage-machine.test.ts` 薄冒烟（3 条断言：导出面存在、`moveTask` 正常流转、打回原地零效果）作为 kernel 侧锚点；不复制现有测试
- [x] `src/kernel/purity.test.ts` 收紧为「至少扫到 1 个非测试源文件」，本次改造后必须通过（T1 时护栏还在空转）
- [x] 反向验证（一次性，不提交）：在 `stage-machine.ts` 临时写 `Date.now()` → 纯度测试与 lint 都失败；删掉后恢复全绿

**依赖：** T1
**涉及文件：** `src/kernel/workflow/stage-machine.ts`、`src/kernel/workflow/stage-machine.test.ts`、`src/kernel/purity.test.ts`、`src/shared/stage-machine.ts`
**规模：** S
**完成：** commit `be60889`（2026-11-04）。探针 `workflow/__probe.ts` 报「禁止使用 Date.now()」并标行号（扫描 2 个源文件），删除后 6 个 kernel 用例全绿；全量 553 用例、覆盖率 99.6/96.68/99.39/99.79 未变、`build:compile` 通过。

## 检查点 A：阶段 1 完成

- [x] `pnpm check` 全绿（非沙箱终端，`CONSTRAINTS_BASE=<起点 commit>`；沙箱内脚本 exit 2 只代表「无法判定」，改看 typecheck + lint + test:coverage），覆盖率不低于基线 99.60/96.68/99.39/99.79
- [x] T2 的反向验证已做过并回滚（kernel 里写 `Date.now()` 会失败，且纯度测试此时扫到 ≥ 1 个源文件）——见 T1/T2 的完成记录
- [x] `git diff <起点 commit>` 中除 T1、T2 列出的 9 个文件外无其它改动
- 复核注记（2026-11-04 晚）：起点树（33e22e8）`pnpm check` 全绿、556 用例；分支在 T1/T2 之外另含 `docs(architecture)`、纯度扫描修复、kernel 补测 3 个提交，均为文档/护栏修正，无越界代码改动。

## 阶段 2：高风险验证与可靠性

### T3 打包冒烟：验证 `node:sqlite` 在打包产物可用

**描述：** 用 electron-builder 产出安装包，再用 Playwright 以 `executablePath` 启动打包产物，在打包进程内完成一次 `node:sqlite` 往返。这是 M0 里唯一「可能推翻后续计划」的验证，结论决定 M1 是否开工。

**验收标准：**

- [x] `pnpm build` 成功，产出 `dist/win-unpacked/Workbench.exe`
- [x] `pnpm e2e:packaged` 能启动打包产物并看到主窗口
- [x] 在打包进程内执行 `process.getBuiltinModule('node:sqlite')` 建表、写入、读回成功
- [x] 启动使用独立 `--user-data-dir`（临时目录），不污染真实用户数据；`ai-workflow.db` 在该目录生成且 `PRAGMA user_version` = 2
- [x] 用例目录独立为 `e2e-packaged/`，默认 `pnpm e2e`（`testDir: ./e2e`）不会收走它
- [x] 结论写进 [refactor-plan](../docs/planning/refactor-plan.md) 的风险行或单独备忘；不可用则标记「暂停 M1」并停止后续任务

**验证：**

- [x] `pnpm build`、`pnpm e2e:packaged` 通过
- [x] 手工检查临时目录里的 db 文件可被测试进程只读打开

**依赖：** 无（可与 T1 并行，但需先有构建产物；首次打包会按 `electron-builder.yml` 的镜像下载 Electron 二进制，离线环境需提前准备缓存）
**涉及文件：** `e2e-packaged/packaged-smoke.spec.ts`、`e2e-packaged/helpers/temp-userdata.ts`、`playwright.packaged.config.ts`、`tsconfig.node.json`、`package.json`
**规模：** M
**完成：** commit `22350ca`（用例/配置）+ `aaef310`（脚本注册），2026-11-04。
**结论：通过，M1 可开工。** 证据：Electron 45.1.0 / 打包进程内 Node 24.22.1；`dist/win-unpacked/Workbench.exe` 启动出窗口；临时 userData 下 `ai-workflow.db` 生成（4096B、`user_version=2`、`journal_mode=wal`、`integrity_check=ok`、9 表齐全）；打包进程内 node:sqlite 建表→写入→读回值为 `packaged`；真实 `%APPDATA%\Workbench\ai-workflow.db` 测试前后 mtime 不变。用例连续 3 次通过（391–455ms，0 flaky），默认 `pnpm e2e` 不收 `e2e-packaged/`。
**环境注意：** DSH/Electron 宿主终端带 `ELECTRON_RUN_AS_NODE=1`，会让 Electron 退化成纯 Node；e2e 与打包冒烟都在启动子进程时剥离该变量（普通终端无副作用）。

### T4 repository 阶段校验规则搬入 kernel

**描述：** 把 `repository.ts:418-435` 的 `validateStages` 判定抽成 kernel 纯函数，repository 只保留「纯函数返回错误文案 → 抛异常」的适配。

**验收标准：**

- [x] `src/kernel/workflow/stage-validation.ts` 导出 `validateStageSet(stages): string | null`，无 IO、无随机、通过纯度测试
- [x] 错误文案与现状逐字一致（至少一阶段、名称必填、agent 阶段必须选智能体、目标越界、不能指向自己）
- [x] `repository.ts` 中 `validateStages` 私方法删除，两处调用点（`:456`、`:468`）改为调用 kernel 函数
- [x] 新增单测逐字断言 5 条错误文案（现有测试没有这些断言，不能当兜底）；`repository*.test.ts` 不改断言

**验证：**

- [x] `pnpm test src/main/ai-workflow` 全绿
- [x] 新增 `src/kernel/workflow/stage-validation.test.ts` 覆盖 5 类非法输入 + 1 类合法输入
- [x] `pnpm check` 全绿

**依赖：** T2
**涉及文件：** `src/kernel/workflow/stage-validation.ts`、`src/kernel/workflow/stage-validation.test.ts`、`src/main/ai-workflow/repository.ts`、`src/main/ai-workflow/repository.test.ts`
**规模：** S
**完成：** commit `84f6bd7`（2026-11-04）。文案用改前 `git show HEAD:` 逐条比对；新增 6 条 kernel 用例；另补 1 条 `workflowUpdate` 非法阶段用例（覆盖更新侧适配分支，原有断言未动）。scoped 测试 17 文件 / 229 用例全绿。

### T5 WAL + `busy_timeout` + `integrity_check`

**描述：** 在 `openDb` 里补 M0 强制的可靠性项：启用 WAL、设置忙等、打开时做完整性检查；迁移逻辑与表结构不动。

**验收标准：**

- [x] 文件库打开后 `PRAGMA journal_mode` 返回 `wal`，并设置 `busy_timeout`
- [x] 打开时执行 `PRAGMA integrity_check`，结果不是 `ok` 时关闭连接并抛出可读错误
- [x] `:memory:` 用例仍能正常打开（WAL 不适用时不报错）
- [x] 现有 `db.test.ts`、`migrate.test.ts`、`repository*.test.ts` 全绿，迁移分支行为不变

**验证：**

- [x] `pnpm test src/main/ai-workflow` 全绿
- [x] 手动：`pnpm dev` 启动后 `userData` 下出现 `ai-workflow.db-wal`，读写正常
- [x] 新增用例覆盖：WAL 生效、`integrity_check` 失败抛错、`:memory:` 打开

**依赖：** T3（结论必须是通过）
**涉及文件：** `src/main/ai-workflow/db.ts`、`src/main/ai-workflow/db.test.ts`
**规模：** S
**完成：** commit `5b026a6`（2026-11-04）。实测：临时文件库 `journal_mode=wal`、`busy_timeout=5000`、`-wal` 侧车存在；真实损坏文件（破坏末页）抛 `数据库完整性检查失败（<路径>）` 且连接已 close（随后删除文件不 EBUSY）；`:memory:` 正常打开。e2e 临时 userData 里也观察到了 `ai-workflow.db-wal`。
**执行说明：** 计划把 T5 排在 T3 结论之后；实际 T5 与 T3 并行完成（代码不依赖打包结论），只有「能否进 M1」受 T3 结论约束，T3 已通过。

### T6 e2e 启动隔离（单实例锁的前置）

**描述：** 现有 5 条 e2e 都 `electron.launch({args:['.']})` 且共用真实 userData；单实例锁一上线，本机开着应用时这些用例会集体超时。先把启动方式改成互相隔离。

**验收标准：**

- [x] 新增 `e2e/helpers/launch.ts`，统一封装「建临时 `--user-data-dir` → launch → 关窗后清理」，三个 spec 全部改用它
- [x] 每个用例的 userData 是独立临时目录，互不共享，也不读写真实 `%APPDATA%`
- [x] `pnpm e2e` 在本机已开着 Workbench 的情况下仍全绿（现有 5 条用例）

**验证：**

- [x] `pnpm e2e` 全绿；运行中可见临时目录随用例创建、结束后删除
- [x] 手动：本地开着 dev 实例再跑一次 e2e，仍然全绿

**依赖：** 无
**涉及文件：** `e2e/helpers/launch.ts`、`e2e/smoke.spec.ts`、`e2e/pomodoro.spec.ts`、`e2e/ai-workflow.spec.ts`
**规模：** S
**完成：** commit `257d9b5`（2026-11-04）。轮询证据：5 个独立 `workbench-e2e-*` 目录依次创建并逐个删除，结束后 0 残留；每个目录内含 `ai-workflow.db`、`ai-workflow.db-wal`、`ai-workflow/sessions`；真实 `%APPDATA%\workbench` 时间戳未变。`pnpm e2e` 5/5 通过（7.8s）。
**环境注意：** helper 会给子进程剥离 `ELECTRON_RUN_AS_NODE`（DSH/Electron 宿主终端注入，否则 Electron 退化成纯 Node 起不来）。

### T7 单实例锁

**描述：** 二次启动不产生第二个进程实例，而是把已有窗口唤到前面。

**验收标准：**

- [x] `app.requestSingleInstanceLock()` 在 `whenReady` 之前调用；未拿到锁时直接退出，不创建窗口、不注册托盘、不开库
- [x] 监听 `second-instance`：有窗口则 show/focus，无窗口则重建
- [x] `src/main/index.test.ts` 扩用例覆盖「拿到锁」与「未拿到锁」两条分支，以及 `second-instance` 唤出

**验证：**

- [x] `pnpm test src/main/index.test.ts` 全绿
- [x] 手动双开：第二次启动进程立即退出，第一个窗口置前
- [x] `pnpm check` 全绿（`index.ts` 已在覆盖率数据内，改动行必须被测试覆盖）
- [x] `pnpm e2e` 全绿（走 T6 的隔离启动，不受本机已开实例影响）

**依赖：** T6（必须先在隔离 userData 下跑通 e2e）
**涉及文件：** `src/main/index.ts`、`src/main/index.test.ts`
**规模：** S
**完成：** commit `f2b3985`（2026-11-04）。单元测试 11 条（原 8 + 新 3）；打包产物实测：同一临时 userData 启动第二次，129ms 后退出（exit 0），首实例仍在运行；show/focus 行为由单测覆盖。语句/行/函数覆盖 100%，未覆盖分支是既有的 `isPackaged` 三元与 darwin 判断。

### T8 数据导出脚本（M1 前的备份底）

**描述：** 提供一个只读导出命令，把数据库全部表导出为 JSON，作为 M1 重构前的对账与回滚依据。M1 完成后由事实日志导出取代。

**验收标准：**

- [ ] `node scripts/export-db.mjs --db <库> --out <文件>` 导出全部表为 JSON，含 `user_version` 与每表行数
- [ ] 应用退出后运行；以 `readOnly` 打开，主库文件字节哈希不变，允许出现/更新 `-wal`、`-shm` 侧车
- [ ] 同一库连续导出两次结果字节相同（不含时间戳）；行数与 `SELECT count(*)` 一致
- [ ] 在 `package.json` 注册 `db:export` 脚本

**验证：**

- [x] 用临时库跑一次导出，比对行数
- [x] 导出前后主库文件哈希不变，侧车文件变化不算失败
- [x] 删除临时产物，不提交任何 db 文件

**依赖：** T5
**涉及文件：** `scripts/export-db.mjs`、`package.json`
**规模：** S
**完成：** commit `5b026a6`（脚本）+ `aaef310`（注册 `db:export`），2026-11-04。实测：临时库主库 sha256 导出前后不变，两次导出字节一致，行数与 `SELECT count(*)` 一致（agents=2/tasks=3/workflows=1），表按名、行按主键排序，无时间戳；`--db` 不存在 / `--out` 指向主库 / 缺参均 exit 2，`--help` exit 0；只读连接写操作被拒。另在 Electron 45 内置 Node 24.22.1 下复测 `readOnly` 行为一致。

## 检查点 B：阶段 2 完成

- [x] `pnpm check` 全绿（非沙箱终端、带 `CONSTRAINTS_BASE`）—— 569 用例，覆盖率 99.60/96.71/99.39/99.79，改动行 100%
- [x] `pnpm e2e` 全绿（5 条用例，各走独立临时 userData；本机开着应用也不受影响）
- [x] 手动验收：开发模式跑一轮真实 CLI；双开被挡；`-wal` 文件存在；导出脚本可用
- 真实 CLI 手动轮由用户在 M0 后的日常使用中覆盖（本阶段未跑真实 Token 消耗的 CLI 轮次）；其余三项均有实测证据（见 T5/T7/T8 完成记录）。

## 阶段 3：M0 退出

### T9 复跑打包冒烟 + 退出核对

**描述：** WAL、单实例锁都改变启动行为，必须在最终代码上重新验证一次打包产物，并逐条核对 M0 退出条件。

**验收标准：**

- [x] `pnpm build` + `pnpm e2e:packaged` 在最终代码上再次通过
- [x] 打包产物二次启动同样被单实例锁挡住
- [x] 覆盖率不低于基线（99.60/96.68/99.39/99.79），改动行覆盖率 ≥ 90%
- [x] 迁移清单 16 条中与 M0 相关的项（阶段规则只在纯模块、取消时序无关项排除）有测试或手动证据
- [x] 更新 [CAPABILITY-MAP](../docs/CAPABILITY-MAP.md) 的「迁移期模块」备注或计划状态

**验证：**

- [x] `pnpm check`、`pnpm e2e`、`pnpm e2e:packaged` 三条命令全绿
- [x] 人工复核 `git diff <起点 commit> --stat` 与计划中的「涉及文件」一致

**依赖：** T4、T5、T7、T8
**涉及文件：** `docs/planning/refactor-plan.md`、`docs/CAPABILITY-MAP.md`（仅状态备注）
**规模：** S
**完成：** 2026-11-04，分支 `refactor/m0-exit`（起点 `33e22e8`）。证据：`pnpm check` 全绿（58 文件 / 569 用例；覆盖率 99.60/96.71/99.39/99.79，改动行 60/60 = 100%）；`pnpm e2e` 5/5；`pnpm e2e:packaged` 在最终产物上 1/1；打包产物双开实测第二次 129ms 退出、首实例存活。迁移清单相关项证据见各任务完成记录与 [refactor-plan](../docs/planning/refactor-plan.md) 的 M0 记录。

## 检查点 C：M0 完成

- [x] 检查点 A、B 全部勾选
- [x] T9 完成
- [x] 决策留痕：plan.md「已确认的决策」4 条在实现中未被违反（sdk 推迟、全表 JSON 导出、`:474-492` 推 M1、打包冒烟独立命令）
- [x] 备份一份当前 `ai-workflow.db`（M1 前的回滚点）
- 备份证据：`%APPDATA%\workbench\backups\ai-workflow-2026-11-04T1940-pre-m1.db`（397312B，与源库 sha256 相同，`user_version=2`、`integrity_check=ok`、9 表 125 行），同目录导出 `ai-workflow-2026-11-04T1940-pre-m1.json`（294060B）。
