# 任务清单：M6.5 Thread

> 计划见 [m65-plan.md](./m65-plan.md)。状态：`[ ]` 未做 / `[x]` 完成。

## T1 契约与清单（lead）

- [x] `src/protocol/thread.ts`：`ThreadStatus` / `ThreadCloseReason` / `ThreadNote` / `ThreadEventRef` / `ThreadRow` / 上限常量
- [x] `Task` 加 `threadId` / `parentTaskId`（`protocol/entities`）
- [x] `facts.ts`：7 条 `thread.*` + `event.merged` 的 payload 与 `FactPayloads`
- [x] `commands.ts`：`thread.note` / `thread.close` / `thread.bind`
- [x] `inputs.ts`：`Receipt.notes?: string[]`
- [x] `views.ts`：`thread.byId` 视图、`ThreadDetail`
- [x] `validate.ts`：新命令、`receipt.notes`、`thread.byId` 参数
- [x] `plugins/shared/receipt-block.ts`：第六键 `notes`（解析 + applyReceiptBlock）
- [x] `kernel/types.ts`：`View.threads`、`PROJECTION_TABLES` + `threads`、`KERNEL_VERSION=m6.5.0`、id kind
- [x] `kernel/view-spec.ts`：新输入切片 + 既有切片补 `threads` / `runs`

## T2 内核（lead）

- [x] `kernel/threads.ts`：归并 opener / attach / 复用 / 合并 / 隐式线程 / 绑定 / 生命周期（关闭/重开/14 天）
- [x] `kernel/thread-context.ts`：六段派生 + 6000 码点截断（确定性）
- [x] `kernel/prompt.ts`：线程上下文段；`taskPrompt` 带 context
- [x] `kernel/task-effects.ts`：run 写 `threadId`、`resumeSessionId`、`turn`
- [x] `kernel/rules.ts`：`eventTaskFacts` 走线程归并（含派生事件父任务解析）
- [x] `kernel/decide.ts`：`thread.*` 命令、`task.create` 隐式线程、回执 notes、任务完成/删除后的线程关闭、`clock.tick` inactivity
- [x] `kernel/project.ts`：`threads` 整行 upsert、`event.merged` → `runs.eventIds`
- [x] `kernel/run.ts`：`pickClaims` 线程并发闸门
- [x] 单测：threads / thread-context / prompt / task-effects / rules / decide / project / run

## T3 宿主（host-dev）

- [x] `host/schema.ts`：`threads` DDL + 索引 + 投影白名单/指纹；`tasks` 补 `thread_id` / `parent_task_id`
- [x] `host/db.ts`：旧库 `tasks` 补列扩展（复用 M6 机制）
- [x] `host/store/projection-apply.ts`：threads 整行 writer、tasks 新列、`event.merged` 更新 run 行
- [x] `host/store/views.ts`：threads 装载（`View.threads`）、`thread.byId` 查询、Task 新列映射
- [x] `host/store/import.ts`：v2 `tasks` 默认 `threadId=null` / `parentTaskId=null`
- [x] `host/commands.ts`：`thread.*` 命令返回值（可选，无则 null）
- [x] 单测：schema / db / projection-apply / views / import / 重建等价

## T4 renderer（ui-dev）

- [x] `TaskCard`：父子关系徽标 + 线程入口
- [x] `ThreadPanel`：元信息 / 任务树 / 笔记 / 绑定 / 关闭
- [x] `KanbanBoard` / `AiWorkflowPage`：线程面板接线
- [x] `kernelStore` 失效表：`thread.` / `event.` → `thread.byId`
- [x] 组件测试 + kernelStore 测试

## T5 集成与门禁（lead）

- [x] `pnpm check` exit 0；覆盖率不低于基线
- [x] `check:diffcov` 100%
- [x] `pnpm e2e`（新增线程用例）
- [x] 重建等价 / 真库用例

## T6 文档与收尾（lead）

- [x] SPEC-kernel：Thread 章节去 M6.5 标记、补充事实/命令/偏差
- [x] SPEC-host：`thread-context` 实现位置口径、启动顺序
- [x] SPEC-plugins：回执块六键、`notes`
- [x] CAPABILITY-MAP / TEST-CASES / refactor-plan 开工与退出记录
- [x] 提交、`pnpm check` 复核、fast-forward 合入 `master`
