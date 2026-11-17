# 实施计划：A1 准入（身份 / 准入表 / 模式 / 判定落事实）

> 规格：[docs/SPEC.md](../docs/SPEC.md)、[SPEC-authority](../docs/specs/SPEC-authority.md) §类型契约 §事实 §模式矩阵 §准入表。
> 起点：`master` @ `ead3aca`（工作树只有本计划的文档提交）。目标：外部事件先过准入再建任务，兼容模式零行为变化。
> 本阶段不做：Mandate（A2）、研判 run（A3）、注意力面板与提权闸门（A4）。

## 任务

| #   | 任务         | 改哪些文件                                                                                                                                                                                                                          | RED（先失败的测试）                                                                                                                                                         | 完成判定                                                  |
| --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| T1  | 契约与归一   | `protocol/src/authority.ts`（新）、`protocol/src/index.ts`（如导出）                                                                                                                                                                | `tests/protocol/authority.test.ts`：默认准入表五格值、`AUTHORITY_LIMITS` 边界、`compatAuthority()` 形状、`normalizeAuthority(undefined)` 与缺字段归一                       | 测试全绿；无消费方改动；`pnpm build` 过                   |
| T2  | 事实与校验   | `protocol/src/facts.ts`、`protocol/src/inputs.ts`（`identity` 白名单）、`protocol/src/validate.ts`                                                                                                                                  | `tests/protocol/facts.test.ts` 扩：`FACT_TYPES` 含 `event.admitted`/`event.denied`；非法 `identity.kind` 被拒；`reason` 枚举拒收未知值                                      | 协议用例全绿；老 payload 不传 `identity` 仍可校验（兼容） |
| T3  | 判定纯函数   | `kernel/src/scopes/admission.ts`（新）                                                                                                                                                                                              | `tests/kernel/admission.test.ts`：7 类事件 × 3 模式 = 21 格 + 兼容模式退化 + `receiveAll=false` 时未点名格不生效                                                            | 21 格断言全绿；纯函数（无 IO）；`check:kernel` 打印行数   |
| T4  | 接线         | `kernel/src/scopes/commands/common.ts`、`kernel/src/scopes/view-spec.ts`、`kernel/src/core/types.ts`（`View.authority`）、`host/store/src/{schema,projection-apply,views,db}.ts`、`protocol/src/rules.ts`（`RuleSetRow.authority`） | `tests/kernel/event-admission.test.ts`：denied 不建任务、admitted 建任务且带 `policyVersion`；`tests/host/store-rules.test.ts` 扩：`authority_json` 往返、老行归一 `compat` | 兼容模式现有命令测试不改仍过；新用例全绿                  |
| T5  | 视图         | `protocol/src/views.ts`（`authority.current`）、`host/store/src/views.ts`、`kernel/src/scopes/view-spec.ts`                                                                                                                         | `tests/host/views.test.ts` 扩：无 `authority` 时报 `mode='compat'`；有则回显名单与模式                                                                                      | 视图用例全绿；`VIEW_IDS` 45 → 46                          |
| T6  | 规则页授权区 | `client/app-ai-workflow/src/components/RulesManager.tsx`、`RuleDialog.tsx`、`model/*`                                                                                                                                               | `tests/renderer/rules-authority.test.tsx`：模式下拉、名单编辑、保存走 `rules.replace`                                                                                       | 组件测试全绿；`pnpm check:ui` 过                          |

## 执行纪律

- 每个任务：RED → GREEN → 全量回归（`pnpm test`）→ `pnpm build` → 单独 commit（`feat(authority): ...`），不 `git add -A`。
- 任务边界外的问题只记录不改（例如顺带发现的注释过期），留给后续任务。
- 遇到矩阵语义歧义（例如 `receiveAll=false` 时未点名事件是否算「未点名格」）先按 §准入表 的既有口径实现，并在 commit message 里写明取舍。

## 进度（2026-11-17）

| 任务                                                                                 | 状态 | 提交                 |
| ------------------------------------------------------------------------------------ | ---- | -------------------- |
| T1 契约与归一                                                                        | 完成 | `8fc1041`            |
| T2 事实与校验                                                                        | 完成 | `8ecb2aa`            |
| T3 判定纯函数（含模式矩阵 26 用例）                                                  | 完成 | `6891af8`            |
| T4 接线（`View.authority` / `rule_sets.authority_json` / `event.admitted`·`denied`） | 完成 | `35a83b4`、`5c4c138` |
| T5 `authority.current` 视图                                                          | 待做 | —                    |
| T6 规则页授权区                                                                      | 待做 | —                    |

实现记录（与计划的差异）：

- `View.authority` 定为 `Authority | null` **可选**：宿主恒装，测试替身可省；缺省按兼容模式。
- `rules.replace` 的 `authority` 三态：省略 = 保持现值、`null` = 清除、对象 = 整块替换（避免老界面保存规则时静默清空准入）。
- `receiveAll=false` 时未点名事件一律 `denied{not-listed}`；SPEC-authority §准入表 已同步改写。
