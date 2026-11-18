# Constraints

Last reviewed: 2026-11-18（lead）。适用于 workbench（个人工作台）。

> 每次交付前读本文件。**改代码不得为过关而放松本文件**；放松门槛必须显式、可追溯（走 Exceptions，附 owner 与到期日）。
>
> 本文件只放**规则**（有命令、可判定）。复核记录、例外理由、实测值演进在 [CONSTRAINTS-HISTORY](docs/testing/CONSTRAINTS-HISTORY.md)，新的叙述不要写回这里。

## Floor（永久底线，始终强制，无需额外配置）

- 不新增抑制检查器的注释：`@ts-ignore` / `@ts-nocheck` / `eslint-disable` / `istanbul ignore` / `nosemgrep` 等。
- 不留未实现桩：`throw new Error('Not implemented')`、空 `catch {}`、用 `TODO` 顶替实现。
- 不用 `.skip` / 删除测试 / 删除断言来掩盖失败。
- 源码不含密钥、令牌、私有密钥。
- 本文件不为了过关而放松。

## Enforced with numbers

| 维度               | 规则                                                                                                                                               | 检查命令                                   | 何时                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------- |
| 类型               | 零类型错误                                                                                                                                         | `pnpm typecheck`                           | 每次编辑 / pre-commit |
| Lint（含架构边界） | 零 error                                                                                                                                           | `pnpm lint`                                | 每次编辑 / pre-commit |
| 覆盖率（项目）     | 全局阈值 statements≥98 / branches≥93 / functions≥95 / lines≥98，且不得低于基线                                                                     | `pnpm test:coverage`                       | 任务结束 / CI         |
| 覆盖率（改动行）   | 改动的可执行源码行 ≥ **90%**                                                                                                                       | `pnpm test:coverage && pnpm check:diffcov` | 任务结束              |
| 密钥               | diff 内零命中                                                                                                                                      | `pnpm check:secrets`                       | 每次编辑 / pre-commit |
| 依赖漏洞           | 生产依赖无 high 及以上                                                                                                                             | `pnpm audit`                               | 任务结束 / CI         |
| Floor              | 零违规                                                                                                                                             | `pnpm check:floor`                         | 每次编辑 / pre-commit |
| UI 规则            | shadcn 基线零违规：只用语义 token 类名、零调色板外色值、无重玻璃；前景对比度 foreground≥12 / muted-foreground≥8 / faint-foreground≥4.5 / brand≥4.5 | `pnpm check:ui`                            | 每次编辑 / pre-commit |
| 变异分数（试点）   | `src/kernel/cron.ts` 变异评分 ≥ **80**（killed+timeout 占总变异体比例；基线 2026-11-13 实测 85.61）                                                | `pnpm mutation:cron`                       | 合并前 / CI 定时      |

每一行都写出产生判定的命令；没有命令的维度只是愿望，不是约束。

> 当前基线（2026-11-18 实测，**不得低于**）：st 98.28 / br 96.15 / fn 97.40 / ln 98.58。基线演进与每次下降的归因见 [CONSTRAINTS-HISTORY](docs/testing/CONSTRAINTS-HISTORY.md)。

### 架构边界（由 ESLint `no-restricted-imports` 强制）

- `src/renderer/**` 禁止 import Node 内置（`node:*`）与 `src/server/**`；浏览器侧只有 `shared/bridge.ts` 一个传输实现（`window.workbench`）。
- `src/server/**` 禁止 import `renderer`，也不得直接 import 具体插件实现（只经 `plugins/registry`；依赖方向 server → host + 注册表单向）。
- 测试同层同规：`tests/renderer/**` 禁 Node 内置与服务端 import，`tests/server/**` 禁 import `renderer`（ESLint 按同一规则集执行，门禁强度不因测试目录搬家而下降）。
- app 之间不互相 import、app 只依赖 shell（`AppDefinition` 契约 + 桥接）——**暂无自动检查，靠 code review**。

## Measured, not yet enforced（只记录，不动）

只记录、不拦的维度（覆盖率实测四元组、开发依赖漏洞数、SAST 状态、打包体积）与逐轮数值演进见 [CONSTRAINTS-HISTORY](docs/testing/CONSTRAINTS-HISTORY.md) 的「只记录不拦的实测值」；方向仍是「不得下降」。

## Exceptions（放松门槛的唯一通道）

每条例外必须带 owner 与到期时点；理由、实测数字与关闭结论见 [CONSTRAINTS-HISTORY](docs/testing/CONSTRAINTS-HISTORY.md) 的「Exceptions 明细」。

| ID     | 规则                         | 路径          | Owner | 到期 / 复核时点       |
| ------ | ---------------------------- | ------------- | ----- | --------------------- |
| EX-001 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | M9 开工前 （已关闭）  |
| EX-002 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | M11 开工前 （已关闭） |
| EX-003 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | M11 开工前 （已关闭） |
| EX-004 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | M11 开工前 （已关闭） |
| EX-005 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | M13 开工前 （已关闭） |
| EX-006 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | M15 开工前            |
| EX-007 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | M15 开工前            |
| EX-008 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | 下一阶段开工前        |
| EX-009 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | 下一阶段开工前        |
| EX-010 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | 下一阶段开工前        |
| EX-011 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | 下一阶段开工前        |
| EX-012 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | M37 开工前            |
| EX-013 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | M37 开工前            |
| EX-014 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | 下次基线复核时重测    |
| EX-015 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | 下次基线复核时重测    |
| EX-016 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | 下次基线复核时重测    |
| EX-017 | 覆盖率基线（“不得低于基线”） | `src/**`      | lead  | 下一阶段开工前        |
| EX-018 | 覆盖率基线（“不得低于基线”） | `packages/**` | lead  | 下次基线复核时重测    |
| EX-019 | 覆盖率基线（“不得低于基线”） | `packages/**` | lead  | 下次基线复核时重测    |
| EX-020 | 覆盖率基线（“不得低于基线”） | `packages/**` | lead  | 下次基线复核时重测    |

## 检查链（生命周期）

| 阶段        | 命令                                    | 内容                                                                              | 预算   |
| ----------- | --------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| 编辑后      | `pnpm check:fast`                       | 类型 + lint(含架构边界) + floor + secrets                                         | 秒级   |
| 任务结束    | `pnpm check`                            | `check:fast` + 项目覆盖率 + 改动行覆盖率 + 依赖审计                               | ≤ ~90s |
| 交付 / 推送 | `pnpm e2e`                              | 真实服务进程 + Chromium 关键路径（先 build 再跑；每条用例独立临时数据目录与端口） | 分钟级 |
| 服务冒烟    | `node out/server/index.js`              | 构建产物起真服务：启动行、`/api/health`、`/api/info`、静态首页都通                | 分钟级 |
| 数据备份    | `pnpm db:export --db <库> --out <文件>` | 只读导出全表 JSON，确定性输出（M1 前回滚点）                                      | 秒级   |
| 合并前      | `pnpm mutation:changed`（MR 层）        | Stryker 变异评分（假绿自检；`pnpm mutation:scan` 为定期全量层）                   | 分钟级 |

## 维护须知

- 改本文件的**规则行**时，保留原行、另起一行补充，不要就地改写措辞：`floor-guard` 按行文本匹配规则，措辞改写会被判成 `rule-removed`（收紧也会误报）。
- 表格的**首列宽度不能变**：`floor-guard` 用表格首格当规则键，Prettier 对齐表格时会改分隔行的破折号——首列一变宽，分隔行首格就变 → 判 `rule-removed`。改本文件表格时保持首列文字宽度不变（新增行可以加长后面的列）。
- 新的复核记录、例外理由、基线演进一律追加到 [CONSTRAINTS-HISTORY](docs/testing/CONSTRAINTS-HISTORY.md)，不再写进本文件：本文件是每次交付前必读的规则页，只放「有命令、可判定」的条目。
- 规则行从本文件迁到详情页时，`floor-guard` 认「同一行文本在详情页逐字出现」为等价迁移；迁走即消失（详情页里也没有）照样判 `rule-removed`。
