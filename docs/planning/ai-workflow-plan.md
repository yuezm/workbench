# Implementation Plan: ai-workflow（个人AI工作流 MVP）

> 依据：[SPEC-ai-workflow.md](../specs/SPEC-ai-workflow.md)（已确认）、[CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。
> 任务详情（验收标准/验证/依赖/涉及文件）见 [ai-workflow-todo.md](./ai-workflow-todo.md)，本文件为顺序索引与决策记录。
> v1 的 [plan.md](./plan.md) / [todo.md](./todo.md) 保持不动。
>
> **2026-11-03 运行时 v2 重做**：运行时改为「协议族后端 + 探测健康 + 事件流」——`dsh --profile <p> --stdio` 版本化 JSONL 协议 v1 执行，`--probe` 帧 + `--version` 产出健康结论并落库；`runs` 增 `runtime_id`/`session_id`/`error_code`/`exit_code`/`duration_ms`/`usage`，事件另存 `run_events`；聊天按会话续接（`resume_rejected` 自动重试一次）。旧 `command + args_template + prompt_mode + 通用 spawn` 与「探测真跑一次 prompt」已删除，DB 迁移到 `user_version=2`（数据保留）。历史计划（T1–T14）保留为 v1 记录，不再逐条回填。
