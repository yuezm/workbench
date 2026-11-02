# Constraints

Last reviewed: 2026-11-03（lead）。适用于 workbench（个人工作台）。

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
- app 之间不互相 import、app 只依赖 shell（`AppDefinition` 契约 + 桥接）——**暂无自动检查，靠 code review**。

## Measured, not yet enforced（只记录，不动）

| 指标                      | 当前                                            | 方向                     |
| ------------------------- | ----------------------------------------------- | ------------------------ |
| 项目覆盖率（st/br/fn/ln） | 99.27 / 95.5 / 97.87 / 99.18                    | 不得下降                 |
| 开发依赖 high 漏洞数      | 3（electron-builder → semver 链等；生产依赖 0） | 不得增加                 |
| SAST（semgrep）           | 未安装                                          | 接入 CI 后启用，本地不跑 |
| 打包产物大小              | 待测                                            | 后续补基线               |

## Exceptions

| ID       | 规则 | 路径 | 原因 | Owner | 到期 |
| -------- | ---- | ---- | ---- | ----- | ---- |
| （暂无） |      |      |      |       |      |

## 检查链（生命周期）

| 阶段        | 命令              | 内容                                                | 预算   |
| ----------- | ----------------- | --------------------------------------------------- | ------ |
| 编辑后      | `pnpm check:fast` | 类型 + lint(含架构边界) + floor + secrets           | 秒级   |
| 任务结束    | `pnpm check`      | `check:fast` + 项目覆盖率 + 改动行覆盖率 + 依赖审计 | ≤ ~90s |
| 交付 / 推送 | `pnpm e2e`        | 真实 Electron 关键路径（先 build 再跑）             | 分钟级 |

## 备注

- 安全工具现状：`gitleaks` / `osv-scanner` / `semgrep` **均未安装**。密钥用 `scripts/check-secrets.mjs`（diff 范围、值已隐去）近似 gitleaks 规则；依赖漏洞用 `pnpm audit` 指向 npmjs（默认 npmmirror 无 audit 端点）；SAST 暂缺，见上表。
- 基线记录日期：2026-11-03。覆盖率提升后更新本文件基线；下降即为 finding。
