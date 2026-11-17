# 实施计划：A2 授权（Mandate）

> 规格：[SPEC-authority](../docs/specs/SPEC-authority.md) §授权生命周期 §重校验条件 §事实 §投影；[docs/SPEC.md](../docs/SPEC.md) §3–§5。
> 目标：任务带着「凭什么、做到哪、哪版策略、撤没撤」执行；恢复新一轮前重校验；换版只通知不中止。
> 本阶段不做：研判（A3）、注意力与提权闸门（A4）。

## 任务

| #     | 任务               | 落点                                                                                                                                                                                                                   | RED                                                                                                                                                     | 完成判定                              |
| ----- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| A2-T1 | 契约 + 事实 + 投影 | `protocol/authority.ts`（`Mandate`/`MandateScope`/`MandateBy`）、`protocol/facts.ts`（`mandate.granted`·`revoked`·`revalidated`）、`kernel/types.ts`（第 20 张表）、`host/store`（列形状 / DDL / 写读 / 任务删除联删） | `tests/kernel/scopes/mandate-projection.test.ts`：整行投影、撤销覆盖同键、重校验零投影                                                                  | **完成**（`54949ae`）                 |
| A2-T2 | 纯函数             | `kernel/scopes/mandate.ts`：`grantMandate` / `revokeMandate` / `revalidateMandate` / `narrowAccess`                                                                                                                    | `tests/kernel/scopes/mandate.test.ts`：范围折算、闸门恒 full、五种 basis 的成立条件、幂等撤销                                                           | **完成**（本次提交）                  |
| A2-T3 | 接线               | `scopes/commands/task.ts`（建任务时授予）、`scopes/cards.ts`/`task.stop`（撤销）、`run.claim` 前重校验、`task-effects.runAccessOf` 取交集、`viewSpec` 装 `mandates`                                                    | `tests/kernel/task-mandate.test.ts`：建任务产 `mandate.granted`；停止产 `mandate.revoked{stop}`；重校验失败拒领并产 revalidated+revoked；权限被上限收紧 | 现有任务/运行用例不改仍过；新用例全绿 |
| A2-T4 | 视图               | `protocol/views.ts`（`mandates.byTask`）、`host/store/src/views.ts`、`View.mandates`                                                                                                                                   | `tests/host/store/mandates-view.test.ts`                                                                                                                | 视图用例全绿                          |
| A2-T5 | 面板               | 任务详情「授权」区（范围 / 强度 / 依据 / 版本 / 撤销状态 / 失败原因）                                                                                                                                                  | `tests/renderer/.../MandateSection.test.tsx`                                                                                                            | 组件用例全绿；`check:ui` 过           |

## 执行纪律

- 每个任务：RED → GREEN → 全量回归（`pnpm test`）→ `pnpm build` → 单独 commit，不 `git add -A`。
- 权限只收紧不放宽：`narrowAccess(agent 原意, mandate.scope.access)`，闸门阶段恒 `full`（M27 语义）。
- 存量任务不补发授权（`legacy=true` 不参与重校验），换版不中止在跑的 run。
- `check:diffcov` 目前对 `main` 自身比对会跳过，A2-T3 之后建议单独确认覆盖率不降。
