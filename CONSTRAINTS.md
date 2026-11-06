# Constraints

Last reviewed: 2026-11-04（lead）。适用于 workbench（个人工作台）。

> 每次交付前读本文件。**改代码不得为过关而放松本文件**；放松门槛必须显式、可追溯（走 Exceptions，附 owner 与到期日）。

## Floor（永久底线，始终强制，无需额外配置）

- 不新增抑制检查器的注释：`@ts-ignore` / `@ts-nocheck` / `eslint-disable` / `istanbul ignore` / `nosemgrep` 等。
- 不留未实现桩：`throw new Error('Not implemented')`、空 `catch {}`、用 `TODO` 顶替实现。
- 不用 `.skip` / 删除测试 / 删除断言来掩盖失败。
- 源码不含密钥、令牌、私有密钥。
- 本文件不为了过关而放松。

## Enforced with numbers

| 维度               | 规则                                                                           | 检查命令                                   | 何时                  |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------ | --------------------- |
| 类型               | 零类型错误                                                                     | `pnpm typecheck`                           | 每次编辑 / pre-commit |
| Lint（含架构边界） | 零 error                                                                       | `pnpm lint`                                | 每次编辑 / pre-commit |
| 覆盖率（项目）     | 全局阈值 statements≥98 / branches≥93 / functions≥95 / lines≥98，且不得低于基线 | `pnpm test:coverage`                       | 任务结束 / CI         |
| 覆盖率（改动行）   | 改动的可执行源码行 ≥ **90%**                                                   | `pnpm test:coverage && pnpm check:diffcov` | 任务结束              |
| 密钥               | diff 内零命中                                                                  | `pnpm check:secrets`                       | 每次编辑 / pre-commit |
| 依赖漏洞           | 生产依赖无 high 及以上                                                         | `pnpm audit`                               | 任务结束 / CI         |
| Floor              | 零违规                                                                         | `pnpm check:floor`                         | 每次编辑 / pre-commit |

每一行都写出产生判定的命令；没有命令的维度只是愿望，不是约束。

### 架构边界（由 ESLint `no-restricted-imports` 强制）

- `src/renderer/**` 禁止 import `electron` 与 Node 内置（`fs` / `path` / `os` / `child_process` / `crypto` / `node:*`）；只能走 `window.workbench` / `window.aiWorkflow` 桥接。
- `src/main/**` 禁止 import `renderer`（依赖方向单向：renderer → main）。
- 测试同层同规：`tests/renderer/**` 禁 Electron/Node 内置，`tests/main/**` 禁 import `renderer`（ESLint 按同一规则集执行，门禁强度不因测试目录搬家而下降）。
- app 之间不互相 import、app 只依赖 shell（`AppDefinition` 契约 + 桥接）——**暂无自动检查，靠 code review**。

## Measured, not yet enforced（只记录，不动）

| 指标                      | 当前                                            | 方向                     |
| ------------------------- | ----------------------------------------------- | ------------------------ |
| 项目覆盖率（st/br/fn/ln） | 99.93 / 99.48 / 100 / 100                       | 不得下降                 |
| 开发依赖 high 漏洞数      | 3（electron-builder → semver 链等；生产依赖 0） | 不得增加                 |
| SAST（semgrep）           | 未安装                                          | 接入 CI 后启用，本地不跑 |
| 打包产物大小              | 待测                                            | 后续补基线               |

## Exceptions

| ID       | 规则                         | 路径     | 原因                                                                                                                                                                        | Owner | 到期      |
| -------- | ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------- |
| （暂无） |                              |          |                                                                                                                                                                             |       |           |
| EX-001   | 覆盖率基线（“不得低于基线”） | `src/**` | M8 任务派生新增 `kernel/spawn.ts` 与 decide 级联/防御分支；实测 99.86 / 99.2 / 99.83 / 99.94，仍高于强制阈值（98/93/95/98），改动行 91.4%（≥90%）。阈值不放松，待 M9 前补口 | lead  | M9 开工前 |
| EX-002   | 覆盖率基线（“不得低于基线”） | `src/**` | M9（阶段说明 / 对话归档 / 设置页改版）与 M10（项目维度：`projects` 投影、`pickFolder`、项目弹窗与「未归属」入口）新增代码后实测 99.74 / 98.9 / 99.79 / 99.83，仍高于强制阈值（98/93/95/98），改动行 96.13%（≥90%）。阈值不放松，待下一阶段补口 | lead  | M11 开工前 |

## 检查链（生命周期）

| 阶段        | 命令                                    | 内容                                                               | 预算   |
| ----------- | --------------------------------------- | ------------------------------------------------------------------ | ------ |
| 编辑后      | `pnpm check:fast`                       | 类型 + lint(含架构边界) + floor + secrets                          | 秒级   |
| 任务结束    | `pnpm check`                            | `check:fast` + 项目覆盖率 + 改动行覆盖率 + 依赖审计                | ≤ ~90s |
| 交付 / 推送 | `pnpm e2e`                              | 真实 Electron 关键路径（先 build 再跑；每条用例独立临时 userData） | 分钟级 |
| 打包验收    | `pnpm e2e:packaged`                     | electron-builder 产物冒烟（打包进程内 node:sqlite / 单实例锁）     | 分钟级 |
| 数据备份    | `pnpm db:export --db <库> --out <文件>` | 只读导出全表 JSON，确定性输出（M1 前回滚点）                       | 秒级   |

## 备注

- 安全工具现状：`gitleaks` / `osv-scanner` / `semgrep` **均未安装**。密钥用 `scripts/check-secrets.mjs`（diff 范围、值已隐去）近似 gitleaks 规则；依赖漏洞用 `pnpm audit` 指向 npmjs（默认 npmmirror 无 audit 端点）；SAST 暂缺，见上表。
- 基线记录日期：2026-11-03。覆盖率提升后更新本文件基线；下降即为 finding。
- 基线复核：2026-11-04（M0 退出）。覆盖率基线随 M0 收尾更新为上表数值（99.60 / 96.71 / 99.39 / 99.79）。
- M1 复核：2026-11-04。账本落地后覆盖率更新为 99.71 / 97.59 / 99.52 / 99.85；改动行门禁 948/948 = 100%。
- 测试目录重组复核：2026-11-04。测试与夹具搬到 `tests/`（与 `src/` 同构镜像）后覆盖率仍为 99.71 / 97.59 / 99.52 / 99.85，基线不变。
- M2 复核：2026-11-05。运行生命周期入账后覆盖率为 99.73 / 97.78 / 100 / 100（改动行 1024/1031 = 99.32%）；`main/ai-workflow/{repository,runner,chat}.ts` 与 `shared/stage-machine.ts` 删除，运行时读路径改投影视图，检测见 [refactor-plan](docs/planning/refactor-plan.md) M2 退出记录。
- 改本文件的**规则行**时，保留原行、另起一行补充，不要就地改写措辞：`floor-guard` 按行文本匹配规则，措辞改写会被判成 `rule-removed`（收紧也会误报）。
- M3 复核：2026-11-05。执行器插件化收尾（detect 归插件、`runtimes.executors`、`command` 插件与 `argsTemplate`）后覆盖率为 99.81 / 97.92 / 100 / 100（改动行 693/695 = 99.71%），阈值与门禁强度不变；`pnpm e2e` 6/6。证据与已知边界见 [refactor-plan](docs/planning/refactor-plan.md) M3 退出记录。
- M4 复核：2026-11-05。审批与通道落地后覆盖率为 99.85 / 98.12 / 100 / 100（改动行 496/496 = 100%），`pnpm e2e` 8/8；证据见 [refactor-plan](docs/planning/refactor-plan.md) M4 退出记录。
- M5 复核：2026-11-05。三动词 IPC + kernelStore + AppPlugin 落地后覆盖率为 99.89 / 98.18 / 100 / 100（改动行 565/565 = 100%）；证据见 [refactor-plan](docs/planning/refactor-plan.md) M5 退出记录。
- M6 复核：2026-11-05。自动化规则（规则事实/事件建任务/cron/规则页）落地后覆盖率为 99.91 / 98.34 / 100 / 100（改动行 523/523 = 100%），`pnpm e2e` 9/9；证据见 [refactor-plan](docs/planning/refactor-plan.md) M6 退出记录。
- M6.5 复核：2026-11-05。线程（threads 第 13 张投影表、事件归并、线程上下文、续接与并发）落地后覆盖率为 99.91 / 98.34 / 100 / 100（改动行 433/433 = 100%），`pnpm e2e` 10/10；基线不变。
- M7 复核：2026-11-05。外部插件运行时 / SDK net / webhook 来源与通道 / 跨工作流交接 / 远端 Worker 架构位 / 插件设置页落地后覆盖率为 **99.93 / 98.46 / 100 / 100**（改动行 1565/1565 = 100%），`pnpm e2e` **12/12**；基线随本次提升更新，证据与已知边界见 [refactor-plan](docs/planning/refactor-plan.md) M7 退出记录。
- 覆盖率补口复核：2026-11-05（M7 后）。补 kernel / host / plugins / protocol / renderer 的分支缺口（+44 用例，全量 1973 用例）后覆盖率为 **99.93 / 99.48 / 100 / 100**；剩余 24 条分支与 5 条语句均为不可达防御分支（理由见交付说明），未放松任何门禁。
- M7.5 复核：2026-11-06。任务上下文 / 反馈（`task_comments` 第 15 张投影表、`task.comment` 命令、提示词反馈段、任务详情页活动流与反馈框）落地后覆盖率为 **99.92 / 99.38 / 100 / 100**（改动行 160/160 = 100%；同一份用例在本次改动前的 HEAD 实测 99.92 / 99.37，分支略升），`pnpm e2e` 13/13；阈值与门禁强度不变。
- M8 复核：2026-11-06。任务派生（回执 `spawn[]`、父任务 id 内核推导、深度/幂等/`spawnPolicy` 护栏、`onChildrenSettled` rollup、`task.create` 人工挂子任务、`tasks.byParent` 与 UI）落地后覆盖率为 **99.86 / 99.2 / 99.83 / 99.94**（改动行 170/186 = 91.4% ≥90%），`pnpm check` exit 0、`pnpm e2e` 新增 `spawn.spec.ts` 通过；相对 M7.5 基线有 0.06–0.18 的微降，按 EX-001 记录，阈值与门禁强度不变。
- M10 复核：2026-11-07。项目维度（`projects` 第 16 张投影表、`task.create` 必须带项目、`RunRow.cwd` 取项目文件夹、`pickFolder` 原生选择器、项目弹窗与「未归属」入口）落地后覆盖率为 **99.74 / 98.9 / 99.79 / 99.83**（改动行 299/310 = 96.45% ≥90%），`pnpm check` exit 0、`pnpm vitest run` 147 文件 / 2144 用例全绿、`pnpm e2e` **14/14**；相对基线有下降，按 EX-002 记录，阈值与门禁强度不变。
