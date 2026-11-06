# Implementation Plan: ai-workflow（个人AI工作流 MVP）

> 依据：[SPEC-ai-workflow.md](../specs/SPEC-ai-workflow.md)（已确认）、[CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。
> 任务详情（验收标准/验证/依赖/涉及文件）见 [ai-workflow-todo.md](./ai-workflow-todo.md)，本文件为顺序索引与决策记录。
> v1 的 [plan.md](./plan.md) / [todo.md](./todo.md) 保持不动。
>
> **2026-11-03 运行时 v2 重做**：运行时改为「协议族后端 + 探测健康 + 事件流」——`dsh --profile <p> --stdio` 版本化 JSONL 协议 v1 执行，`--probe` 帧 + `--version` 产出健康结论并落库；`runs` 增 `runtime_id`/`session_id`/`error_code`/`exit_code`/`duration_ms`/`usage`，事件另存 `run_events`；聊天按会话续接（`resume_rejected` 自动重试一次）。旧 `command + args_template + prompt_mode + 通用 spawn` 与「探测真跑一次 prompt」已删除，DB 迁移到 `user_version=2`（数据保留）。历史计划（T1–T14）保留为 v1 记录，不再逐条回填。

## Overview

在既有工作台外壳内新增第二个 app `ai-workflow`，把「运行时 → 智能体 → 多阶段工作流 → 看板任务」串成可在本地跑通的最小闭环：配置一个 DeepSeek Harness 运行时、建智能体、建带阶段状态机的工作流、在看板上推进任务，进入 agent 阶段时经 `RuntimeAdapter` 真实调用本机 CLI 执行，数据持久化到本地 SQLite。远端 Worker 只留架构位。

按**垂直切片**推进：先立数据与契约地基，再实现最高风险的核心（阶段状态机），随后按「运行时/智能体 → 工作流/阶段 → 看板/任务 → 执行」逐片打通，每片端到端可用后再下一片。

## Architecture Decisions

- **存储：SQLite（`node:sqlite`），主进程持有**。单文件 `app.getPath('userData')/ai-workflow.db`，`schema.sql` + 顺序执行的 migration；`PRAGMA foreign_keys = ON`。不引原生模块。（若确认 Electron 45 运行时不支持 `node:sqlite`，T1 停下来汇报再定退路，不擅自引 better-sqlite3。）
- **阶段流转 = 纯函数 reducer**，集中在 `model/stage-machine.ts`，对齐 pomodoro：输入「任务状态 + 阶段事件 + 工作流定义」，输出「新任务状态 + 待执行 effects」。主进程 runner 与 UI 只负责执行 effects（建 run、写库、spawn、send 事件），业务规则不落组件。
- **跨进程：新增 `window.aiWorkflow` 命名空间**，契约定义在 `src/shared/ai-workflow-api.ts`，preload 透传，handler 在 `src/main/ai-workflow/ipc.ts`。**不改**既有 `window.workbench.notify` / `AppDefinition`。变更经 `webContents.send('ai-workflow:changed')` 通知 renderer 失效重取（对齐 Multica 的事件失效缓存）。
- **执行：可注入 `RuntimeAdapter`**，MVP 唯一实现 `deepseek-harness.ts`（`spawn` 本机 CLI，按运行时配置的 `command`/`args_template`/`prompt_mode`/`workdir`）。runner 负责单并发 FIFO 队列、写 `runs`、取消。测试用假 adapter，不启真进程。
- **UI：Tailwind 4 + `components/ui/`**（复用 `lib/cn.ts`），不照抄旧 spec 的 CSS Modules 说法。
- **注册：registry 加一行** `aiWorkflowApp`，外壳零改动；registry 契约测试自动覆盖新 app。
- **测试纪律**：repository 用临时 SQLite；`stage-machine.ts` 分支覆盖 100%；覆盖率沿用 `pnpm check` 全局阈值（st/98, br/93, fn/95, ln/98）——新代码必须边写边测，避免收尾时被门禁反噬。

## Implementation Order（依赖自底向上）

```
T1 DB 基座 ─┐
            ├─→ T3 repository ─┐
T2 契约/preload ─→ T4 阶段状态机 ┘
                              ├─→ T5 app 骨架/registry
                              ├─→ T6 运行时/智能体 IPC ─→ T7 运行时/智能体 UI
                              ├─→ T8 工作流/阶段 IPC ─→ T9 工作流编辑 UI
                              ├─→ T10 任务/看板 IPC ─→ T11 看板 UI
                              └─→ T12 DSH adapter + runner ─→ T13 运行记录 UI
                                                                  └─→ T14 整体验收
```

## Task List

### Phase 1: 地基（数据 + 契约）

- [x] T1: SQLite 基座（`db.ts` + `schema.sql` + migration + 建表/外键测试）
- [x] T2: 共享契约与 preload 暴露（`ai-workflow-api.ts` + `window.aiWorkflow` + 全局声明 + preload 测试）
- [x] T3: repository 全实体 CRUD（约束/级联/被引用拒绝 + 临时 SQLite 测试）

### Checkpoint A（T1–T3）

- [x] `pnpm test` 全绿；`pnpm typecheck` 通过；临时库建表与外键约束符合 spec。

### Phase 2: 核心逻辑（最高风险先做）

- [x] T4: 阶段状态机 `stage-machine.ts`（进入效果 + 默认目标解析 + 事件转移；分支覆盖 100%）
- [x] T5: app 骨架与注册（`index.tsx` + `AiWorkflowPage.tsx` 骨架 + `api.ts` + registry 一行）

### Checkpoint B（T4–T5）

- [x] 阶段状态机单测分支 100%；侧边栏出现「AI 工作流」并可切换。

### Phase 3: 运行时与智能体（垂直切片 1）

- [x] T6: runtimes/agents IPC handlers + main 注册 + 契约测试
- [x] T7: RuntimeManager + AgentManager UI + 挂载（增删改、绑定运行时/System Prompt）

### Checkpoint C（T6–T7）

- [x] 能增删改运行时与智能体，重启后仍在。

### Phase 4: 工作流与阶段（垂直切片 2）

- [x] T8: workflows/stages IPC（含有序 stages 读取、阶段三项目标校验）
- [x] T9: WorkflowSwitcher + WorkflowEditor UI（阶段增删改、进入时/完成后进入/打回退回到）

### Checkpoint D（T8–T9）

- [x] 能建 ≥3 阶段工作流并正确保存阶段配置。

### Phase 5: 看板与任务（垂直切片 3）

- [x] T10: tasks IPC + move 动作（接 stage-machine 产出流转）+ 契约/流转测试
- [x] T11: KanbanBoard + TaskCard UI（按阶段分列、user 阶段通过/打回、none 阶段推进）
- [x] T11b: TaskDialog（任务新建/编辑）

### Checkpoint E（T10–T11）

- [x] 新建任务入首阶段；不接真实执行的前提下，可手动把任务推过 none/user 阶段（agent 阶段待 Phase 6）。

### Phase 6: 执行（垂直切片 4）

- [x] T12: `RuntimeAdapter` + `deepseek-harness.ts` + `runner.ts`（单并发队列、成功/失败/取消、changed 事件；假 adapter 测试）
- [x] T13: RunLog UI + `onChanged` 订阅接线（运行中/完成/失败展示输出）

### Checkpoint F（T12–T13）

- [x] 用假 adapter 跑通「agent 阶段自动执行 → 成功推进 / 失败退回」；DSH 真跑留手动验收。

### Phase 7: 收尾

- [x] T14: 整体验收与门禁（`pnpm check` 全绿；手动：加 DSH 运行时 → 建智能体 → 建含 agent 阶段的工作流 → 任务真跑全流程 → 重启数据仍在）

### Checkpoint G（完成）

- [x] 满足 SPEC 全部 Success Criteria（DSH 真跑为手动验收项）；覆盖率门禁通过。

## Risks and Mitigations

| 风险                                          | 影响 | 缓解                                                                                     |
| --------------------------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| Electron 45 运行时对 `node:sqlite` 支持不确定 | 高   | T1 先做最小 `:memory:`/临时文件冒烟确认；不支持则停下汇报，不擅自加原生依赖              |
| DSH CLI headless 调用方式未知                 | 高   | 抽成配置化 `command/args_template/prompt_mode`；T12 先做一次真跑 spike，命令确认前不写死 |
| 覆盖率门禁严格（98/93/95/98）                 | 中   | 边写边测；repository/adapter 用注入与临时库保持可测；最后 T14 兜底                       |
| 跨进程契约漂移                                | 中   | 契约单点定义 + preload/main 双侧契约测试（沿用现有模式）                                 |
| 长时间子进程/输出累积占用内存                 | 中   | 输出分段累积到 `runs.output`，MVP 不做超大日志裁剪，Spec 已注明                          |
| 覆盖 v1 计划文件                              | 低   | 新建 `ai-workflow-*` 文件，不改 v1 `plan.md`/`todo.md`                                   |

## Open Questions（沿用 SPEC，待实现前确认）

1. DSH CLI 的确切命令/参数与 prompt 传递方式——实现前需给出或 spike 确认。
2. 打回未配置默认「不指定」= 原地不动（不流转）。
3. `none` 阶段由用户手动「推进」。
4. 末阶段完成即 `completed` 移出看板。
5. 运行时 `workdir` 默认用户主目录。
