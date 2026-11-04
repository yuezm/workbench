# 实施计划：M1 账本（事实日志 + 投影）

> 依据 [refactor-plan](../docs/planning/refactor-plan.md) 的 M1 行、[SPEC-kernel.md](../docs/specs/SPEC-kernel.md)、[SPEC-host.md](../docs/specs/SPEC-host.md) 与 [ARCHITECTURE.md](../docs/ARCHITECTURE.md)。
> 起点：`master` @ `2212a59`（M0 退出）。工作分支 `refactor/m1-ledger`。
> 目标：让「事件 → 决策 → 事实 → 投影」成为唯一写路径；任务/工作流/阶段/智能体/运行时 五张业务表改为可重建投影，v2 存量数据一次性写成 `snapshot.imported`，旧 `repository` 写方法随之删除。

## 总原则

1. **一次只换一层。** 先立事实与投影基础设施，再把五张表切成投影，最后删旧写路径；不双写。
2. **切表即删写路径。** 某张表变成投影的同一个提交里，删除对应 `INSERT/UPDATE/DELETE`（含 `repository` 方法、`engine` 里的直写）；禁止「先双写、以后再删」。
3. **行为规格不重写。** `SPEC-ai-workflow.md` 的阶段语义、终态归一、取消时序、refresh 规则全部保留；测试跟着搬家，允许随 API 删除而删除测试，但必须先有等价覆盖。
4. **`runs` / `run_events` / 聊天表在 M1 保持直接写。** 运行生命周期（`run.queued/claimed/...`）是 M2 的范围；M1 的投影集只含 `tasks`、`workflows`、`stages`（`workflow_stages`）、`agents`、`runtimes`。重建只清这五张投影表，`run_events` 等不在投影集内的表不受影响，因此「重建后 `run_events` 可查」成立。
5. **`rules` 归属 M6。** SPEC 里「重建后 `rules` 可查」在本阶段不适用（表还不存在），M1 只保证投影集内五表的重建等价。

## 目标结构

```
src/
├── kernel/                 # 纯逻辑（只依赖 protocol 的类型）
│   ├── types.ts            # Seq/Id/Iso/Actor/FactDraft/Fact/View/Environment/Limits/Decision/Change/Table
│   ├── facts.ts            # 事实类型常量 + payload 类型映射（从 protocol/facts 转发）
│   ├── decide.ts           # decide(view, input, now, env): Decision（唯一决策入口）
│   ├── project.ts          # project(fact): Change[]（实时写入与重建共用）
│   ├── view-spec.ts        # viewSpec(input): Table[]（按输入装载投影切片）
│   ├── timeline.ts         # timeline(facts, scope, id)：why 链
│   ├── ids.ts              # 宿主注入的 id 生成器类型（不取随机）
│   └── workflow/           # 已有 stage-machine / stage-validation
├── protocol/
│   ├── entities.ts         # 五张投影表的行类型（Task/Workflow/WorkflowStage/Agent/Runtime）
│   ├── commands.ts         # 命令类型（workflow.* / agent.* / runtime.* / task.*；run/chat 暂留 main 侧）
│   ├── facts.ts            # 事实 payload 类型 + 事实名常量
│   ├── views.ts            # 视图 id 与参数（M1 只落内核侧需要的最小集）
│   └── validate.ts         # 命令形状校验（宿主入口调用）
├── host/
│   ├── db.ts               # 开库/PRAGMA/事务（从 main/ai-workflow/db.ts 迁入）
│   ├── schema.ts           # facts + projection_meta + 五张投影表 DDL（交给 host/store）
│   └── store/
│       ├── facts.ts        # 追加事实（seq 分配）、按 seq 读取、事实导出
│       ├── projection.ts   # 应用 Change[]、清空投影、指纹、重建
│       ├── views.ts        # 按 viewSpec 装载 View、query 读取视图
│       └── index.ts        # Store：dispatch / query / timeline / rebuild / importLegacy
└── main/ai-workflow/       # 过渡期：IPC 装配、runner、chat、runtime 插件适配
```

## 数据模型

### `facts`（只追加）

```sql
CREATE TABLE facts (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  at         TEXT NOT NULL,
  cause      INTEGER,          -- 触发本事实的输入或事实 seq
  hops       INTEGER,
  payload    TEXT NOT NULL
);
```

### `projection_meta`

```sql
CREATE TABLE projection_meta (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  format TEXT NOT NULL,
  seq    INTEGER NOT NULL
);
```

`format` = 投影 DDL 文本哈希 + `KERNEL_VERSION`。启动时 `format` 不匹配或 `seq < max(facts.seq)` → 同一事务内清空投影 → 按 seq 顺序 fold `project()` → 写回 `projection_meta`。

### 投影表

五张表保持现有列名与约束（`tasks`、`workflows`、`workflow_stages`、`agents`、`runtimes`），这样 UI/契约零改动；行类型搬到 `protocol/entities.ts`，`repository` 的读取 SQL 迁移到 `host/store/views.ts`。

### 存量导入

启动时若 `facts` 为空且旧五表有数据：按表分批（每批 ≤500 行）写 `snapshot.imported { table, rows, importedFrom: 'v2' }`，同一事务；导入根无 `cause`，`timeline` 显示「迁移导入」。幂等：`facts` 非空则跳过。导入后不再读写旧表逻辑；旧迁移脚本（`migrate.ts`）删除，改为格式指纹 + 重建。

## 决策面（M1 覆盖的命令）

| 命令                                  | 事实                                                                 | 备注                                                                            |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `workflow.create/update/remove`       | `workflow.created/updated/removed` + `stage.created/updated/deleted` | 阶段 id 稳定、删除用 tombstone                                                  |
| `agent.create/update/remove`          | `agent.created/updated/removed`                                      | 引用校验（运行时存在、名称唯一）                                                |
| `runtime.create/update/remove/probed` | `runtime.created/updated/removed/probed`                             | 凭据/探测结论不进事实                                                           |
| `task.create/move/complete/remove`    | `task.created/moved/completed/removed`                               | 阶段流转规则复用 `kernel/workflow/stage-machine.ts`；有活跃 run 时拒绝移动/完成 |
| `snapshot.imported`                   | 同上（导入根）                                                       | 仅迁移用                                                                        |

**M1 不覆盖**：`event.*`、`run.*`、`card.*`、`thread.*`、`conversation.*`、`rules.replace`、`clock.tick`。这些在 M2/M4/M6 按 SPEC 落地；M1 的 `decide` 对未覆盖输入返回 `reject { code: 'unsupported' }`（宿主暂存旧路径）。

### 过渡缝：任务进入阶段后的 run 效果

`task.created/moved` 之后「agent 阶段要入队一条 run」仍由宿主 `host/task-effects.ts`（从 `engine.applyEffects` 迁入，M2 再入内核）在提交成功后执行：读完新视图 → 建 run（直接写 `runs` 表）→ 回调调度器。M1 结束时 `engine.ts` 的决策部分并入 `kernel/decide`，效果部分留在宿主。

## 任务拆分

| 编号 | 任务                                                                                          | 依赖     | 规模 |
| ---- | --------------------------------------------------------------------------------------------- | -------- | ---- |
| T1   | `host/db.ts` + `host/schema.ts`：facts / projection_meta / 事务 / 指纹                        | 无       | M    |
| T2   | `protocol/entities.ts`、`commands.ts`、`facts.ts`、`validate.ts`；删 `protocol/types.ts` 桥接 | T1       | M    |
| T3   | `kernel/types.ts` + `view-spec.ts` + `decide.ts`（配置三组）                                  | T2       | M    |
| T4   | `kernel/decide.ts` 任务命令 + 阶段流转 + `project.ts`（五表）                                 | T3       | M    |
| T5   | `host/store/*`：追加事实、应用投影、重建、视图装载、`timeline`                                | T1,T2    | L    |
| T6   | 存量导入：v2 五表 → `snapshot.imported`（分批、幂等、导入根）                                 | T5       | M    |
| T7   | IPC/engine 改走 `store.dispatch/query`；`repository` 配置与任务写方法删除                     | T4,T5,T6 | L    |
| T8   | 删 `repository` 读方法（tasks/workflows/stages/agents/runtimes），runner/chat 改走 store 查询 | T7       | M    |
| T9   | 测试：决策黄金用例、project 单测、重建等价、导入幂等、强杀重启一致                            | T4,T5,T6 | L    |
| T10  | 验收：1 万事实重建 < 1 s、`pnpm check`/`pnpm e2e` 全绿、文档与基线更新                        | T7,T8,T9 | S    |

T1/T2 串行做；T3/T4 与 T5 可并行（写作用域不重叠：`kernel/**` vs `host/**`）；T7 之后串行收口。

## 验收

- 现有任务/阶段/工作流/运行时/智能体测试全绿（断言不放松）。
- 强杀进程后重启：`projection_meta.seq` 落后 → 重建 → 与事实一致；无残留 `running`（M2 前 `runs` 直写，只验证投影五表）。
- 1 万事实重建 < 1 s（本机实测进测试或基准脚本）。
- 旧 `repository` 的任务/配置写方法删除，代码里只剩 `host/store` 一处 SQL 写入口。
- 重建后投影五表与 `run_events` 均可查；`timeline` 能还原 task/workflow 的 `why`。
- `pnpm check` 全绿、覆盖率不低于 `99.60/96.71/99.39/99.79`、改动行 ≥90%；`pnpm e2e` 全绿。

## 风险与对策

| 风险                                     | 影响 | 对策                                                                                       |
| ---------------------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| 五表切投影时双写导致分叉                 | 高   | 同一提交删旧写路径；`grep` 检查 `INSERT INTO tasks` 类 SQL 只剩 store                      |
| 9k 行测试与 mock 面重写                  | 高   | 先改协议与 store，再逐文件改测试；`repository.*.test.ts` 先保留读取断言、写断言随 API 搬家 |
| 重建性能不达标                           | 中   | `project` 只产 Change[] 不查库；重建单事务 prepared statement；先测 1 万事实基准           |
| 过渡期 `engine` 与 `decide` 两套阶段规则 | 高   | 阶段流转只保留 `kernel/workflow/stage-machine.ts` 一份，`engine` 只做效果执行              |
| 存量导入重复或丢行                       | 高   | `facts` 空才导入、单事务、分批 500、导入后校验五表行数与原表一致                           |
| `run_events`/聊天表被误清                | 高   | 投影集白名单常量唯一；重建事务只清白名单表                                                 |

## 实施偏差（M1 执行中确认）

1. **View 只含五表 + `activeTaskIds`**：`runs` 不在投影集（M2 入账），「执行中」由 store 装载活跃 run 的 taskId 集合给出，内核不查库。
2. **事实 payload 携带完整实体行**（含 `Runtime.lastProbe`）：保证 `project(fact)` 纯函数、增量与重建逐行等价；凭据类字段仍不进事实。
3. **`workflow.update` 用可选 `StageInput.id` 差量**：有 id 且存在 → `stage.updated`；无 id → 新阶段；缺失旧阶段 → tombstone；删除阶段上的任务按 position 重挂。UI 暂不发 id，行为等价旧「重建阶段 + 按 position 回挂」。另新增「有活跃 run 拒绝改阶段」（SPEC-kernel:200，旧实现缺失）。
4. **删除不存在的实体**沿用旧行为：静默成功、0 事实；create/update 的 not_found 仍 reject。
5. **FK 口径**：增量写 `foreign_keys=ON`（保留旧级联：workflow.remove → task 删除 → runs 级联）；重建临时 `foreign_keys=OFF`，只清白名单五表，`runs`/`run_events`/聊天不动。因此重建后 `runs` 可能残留，属 M1 已知边界，M2 入账后消除。
6. **`timeline()` 只在内核**（有单测），不进 `KernelPort`/store；M5 视图层再暴露。
7. **启动顺序**：`importLegacyIfNeeded` → `ensureProjection`（先导入更安全：空事实 + 存量投影时不会因指纹失配把存量当投影清掉）。
8. **`agents.remove` 被对话引用**时错误文案退化为 SQLite FK 原文（删除仍被拒绝、数据不丢）；M2 把会话纳入 View 后恢复可读文案。

## 不在本次范围

`events/threads/cards/rules` 事实、运行生命周期入账（M2）、执行器插件拆分（M3）、IPC 三动词重构（M5）、UI 改造。M1 只换账本与五张业务表。
