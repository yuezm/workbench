---
type: plan
status: archived
---

# 计划：阶段出口表（Stage Exits）

> **M34 起 `retry` 作废**：出口只剩 `goto` / `await` / `close`，`tasks.stage_fails` 与 `stage:failed` 一并删除。见 [plan-acceptance-ownership](../../plan-acceptance-ownership.md)。

> 状态：**S1a / S1b / S2 / 来源工单段 / `retry` / S4 旧列清理全部落地（M29 – M34，2026-11-12）**。
> 关联：[SPEC-ai-workflow](../../../specs/SPEC-ai-workflow.md)（阶段状态机、闸门）、[SPEC-review-handoff](../../../specs/SPEC-review-handoff.md)、[ARCHITECTURE](../../../ARCHITECTURE.md)。

## 不做

- 不新增任务状态：`active` / `completed` 不动，"完成 / 出错 / 成功 / 失败"由 guard + 最近 run 派生，不落列。
- 不新增内置阶段（不加"已失败"列）：收口走 `close` + `stage:failed` 标签，避免动 `STAGE_KINDS` 与看板配色。
- 不做条件表达式（`if: a && b`）：guard 是枚举，不是表达式语言。
- 不把 `exits` 拆成独立投影表：阶段是整行演进，JSON 列与 `acceptance_json` / `options_json` 同口径。
