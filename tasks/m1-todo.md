# M1 任务清单（账本）

> 计划说明见 [m1-plan.md](./m1-plan.md)。规则：每个任务结束跑 `pnpm check:fast`；里程碑检查点跑完整 `pnpm check` 与 `pnpm e2e`。
> 分支 `refactor/m1-ledger`，起点 `master` @ `2212a59`；回滚点 `%APPDATA%\workbench\backups\ai-workflow-2026-11-04T1940-pre-m1.db`。

## 阶段 1：基础设施

### T1 `host/db.ts` + `host/schema.ts`

**描述：** 把 `src/main/ai-workflow/db.ts` 迁成 `src/host/db.ts`，新增 `src/host/schema.ts`：facts、projection_meta、五张投影表 DDL（沿用现有列名与约束）、索引；提供事务助手与指纹函数。

**验收标准：**

- [x] `openDb` 保留 PRAGMA（WAL / busy_timeout / integrity_check / foreign_keys）与错误关闭行为
- [x] `facts(seq INTEGER PRIMARY KEY AUTOINCREMENT, type, actor_json, at, cause, hops, payload)`；`projection_meta(id, format, seq)`；索引覆盖 `facts(type)`、`facts(cause)`
- [x] `withTx(db, fn)` 单事务；异常回滚
- [x] 投影表 DDL 与现有 `schema.ts` 五表逐列一致（含唯一约束与外键），测试逐列断言
- [x] `format` 指纹 = DDL 哈希 + `KERNEL_VERSION` 常量，变更即失配

**验证：** `pnpm test src/host`；迁移期 `src/main/ai-workflow/db.ts` 暂时 re-export `host/db.ts`，旧测试不动仍绿。

**依赖：** 无 ｜ **涉及文件：** `src/host/db.ts`、`src/host/schema.ts`、`src/host/db.test.ts`、`src/main/ai-workflow/db.ts` ｜ **规模：** M

### T2 protocol 契约

**描述：** 建 `src/protocol/{entities,commands,facts,views,validate}.ts`；`kernel` 只依赖这里；`shared/ai-workflow-api.ts` 改为从 protocol 派生类型（IPC 契约形状不变，renderer 零改动）；删除 `src/protocol/types.ts` 过渡桥接。

**验收标准：**

- [x] `entities.ts` 定义任务/工作流/阶段/智能体/运行时行类型（与现有 `shared/ai-workflow-api.ts` 字段逐一对应，`shared` 侧改为 re-export）
- [x] `facts.ts` 定义 M1 覆盖的事实名常量与 payload 类型
- [x] `commands.ts` 定义 M1 覆盖的命令（配置三组 + task 四命令）
- [x] `validate.ts` 校验命令形状（字符串长度、必填、数组上限），非法返回 `reason` + 文案，不抛
- [x] `protocol/types.ts` 删除；kernel 的 stage-machine / stage-validation import 同步更新
- [x] `pnpm typecheck`、`pnpm test src/kernel src/main` 全绿

**依赖：** T1 ｜ **涉及文件：** `src/protocol/*.ts`、`src/shared/ai-workflow-api.ts`、`src/kernel/workflow/*.ts` ｜ **规模：** M

### T3 `kernel/types.ts` + `view-spec.ts` + `decide.ts`（配置）

**描述：** 落内核类型契约（Actor、FactDraft、View、Environment、Decision、Change、Table）；实现 `viewSpec(input)` 与 `decide` 的配置命令：workflow / agent / runtime 的增删改与探测结论。

**验收标准：**

- [x] `decide` 纯函数：不读时钟/随机/文件/DB，`now`、id 生成、`env` 全部由参数传入
- [x] 工作流命令产出 `workflow.*` + `stage.*` 事实；阶段 id 由宿主传入的 id 生成器产生，更新不重建 id，删除用 tombstone 事实
- [x] 引用校验：agent 的 runtime 必须存在；runtime 被 agent 引用时不可删；名称唯一；有活跃 run 的工作流拒绝改阶段（`decide` 读 View 判断，不查库）
- [x] 非法输入返回 `reject { code, message }`，不抛异常
- [x] `viewSpec` 为每个输入返回所需投影切片（M1 先按表粒度，禁止 `['tasks','workflows',...]` 全量）
- [x] 黄金测试：每个命令 × 合法/非法状态，断言输出 `facts` 对象全等（含 `cause/hops` 不伪造）

**依赖：** T2 ｜ **涉及文件：** `src/kernel/types.ts`、`src/kernel/decide.ts`、`src/kernel/view-spec.ts`、对应测试 ｜ **规模：** M

### T4 `kernel/decide.ts`（任务）+ `project.ts`

**描述：** 补任务命令的决策（复用 `stage-machine` 的阶段规则、入口效果只产「需要建 run」的描述而不建 run）、实现 `project(fact)` 对五张投影表的 Change[]、实现 `timeline`。

**验收标准：**

- [x] `task.create/move/complete/remove` 产出 `task.*` 事实；拖拽落点即目标；打回目标等于当前阶段时零效果；有活跃 run 时拒绝移动/完成（M1 的活跃 run 读 View 里 runs 表切片）
- [x] `project` 纯函数、可重放：同一事实序列重复 fold 结果全等；删除用 `row=null`
- [x] `timeline` 返回事实链，`snapshot.imported` 标注「迁移导入」，不对其伪造 `cause`
- [x] 单元测试覆盖五表的追加/更新/删除、tombstone、破坏性顺序（先建后删）
- [x] `decide` 输出的阶段流转规则与现有测试行为逐条一致（迁移清单第 1–5 条）

**依赖：** T3 ｜ **涉及文件：** `src/kernel/decide.ts`、`src/kernel/project.ts`、`src/kernel/timeline.ts`、对应测试 ｜ **规模：** M

### T5 `host/store/*`

**描述：** 实现 Store：`dispatch(input)`（校验 → 按 `viewSpec` 装载 View → `decide` → 单事务追加事实 + 应用投影 → 更新 `projection_meta`）、`query`（按视图 id 返回投影切片）、`rebuild()`、`timeline()`、`factsSince(seq)`。

**验收标准：**

- [x] dispatch 事务内：`facts` 追加、投影变更、`projection_meta.seq` 三者原子提交；失败全部回滚
- [x] 并发冲突：事务内 `facts.seq` 与 `view.seq` 不一致 → 重读视图重试一次，再冲突则报错
- [x] 启动 `ensureProjection()`：format 失配或 seq 落后 → 清空投影集白名单表 → 按 seq fold 重建 → 写回 meta
- [x] `query` 装载切片（不整表），task/workflow/agent/runtime 读取方法替代 `repository` 对应读
- [x] 测试：内存 SQLite 上「决策 → 事实 → 投影」原子性、回滚、重建等价、viewSpec 切片

**依赖：** T1、T2 ｜ **涉及文件：** `src/host/store/**`、对应测试 ｜ **规模：** L

### T6 存量导入

**描述：** 启动时若 `facts` 为空且旧五表有数据，按表分批写 `snapshot.imported`；`migrate.ts` 的手写 DDL 升级删除，改为指纹 + 重建。

**验收标准：**

- [x] 分批 ≤500 行、单事务、幂等（facts 非空即跳过）
- [x] 导入后五表行数/内容与导入前逐行相等（测试：造 v2 库 → 导入 → 查询逐行对比）
- [x] `timeline` 对导入根返回「迁移导入」；后续事实有完整 `cause`
- [x] 导入失败整体回滚，不留半套数据
- [x] `migrate.ts` 与 `migrate.test.ts` 删除（能力由 `snapshot.imported` + 指纹覆盖），`db.test.ts` 相应更新

**依赖：** T5 ｜ **涉及文件：** `src/host/store/import.ts`、`src/main/ai-workflow/migrate.ts`（删）、测试 ｜ **规模：** M

## 检查点 A：基础设施完成

- [x] T1–T6 完成；`pnpm check` 全绿（覆盖率不低于基线）
- [x] 五张投影表可由事实重建，导入幂等；旧 `migrate.ts` 删除
- [x] `src/kernel` 纯度测试仍绿；`decide/project` 无 IO/时钟/随机

## 阶段 2：收口与验收

### T7 IPC 与写路径切换

**描述：** `src/main/ai-workflow/ipc.ts` 的配置/任务 handler 改为 `store.dispatch`；`engine.ts` 的决策部分并入 `kernel/decide`，只保留宿主侧「提交后建 run」的效果执行（`host/task-effects.ts`）。删除 `repository` 的配置与任务写方法。

**验收标准：**

- [x] IPC 行为不变（现有 `ipc.test.ts` 断言全绿，仅装配方式变化）
- [x] `repository` 中 `runtimeCreate/Update/Remove/SetProbe`、`agent*`、`workflow*`、`taskCreate/Update/Remove` 删除；对应写 SQL 只在 `host/store`
- [x] `engine.ts` 不再含阶段规则（规则只在 kernel），仅执行「建 run + 回调调度」
- [x] 全局搜索确认无第二处写五表（`INSERT INTO tasks|workflows|workflow_stages|agents|runtimes` 只在 store）

**依赖：** T4、T5、T6 ｜ **涉及文件：** `src/main/ai-workflow/{ipc,engine}.ts`、`src/main/ai-workflow/repository.ts`、`src/host/task-effects.ts` ｜ **规模：** L

### T8 读取路径与测试迁移

**描述：** `runner`/`chat`/IPC 对五表的读取改走 store 查询；删除 `repository` 剩余五表读方法；`repository.*.test.ts` 按新入口迁移（读取断言保留，写断言跟 `decide` 黄金用例搬家）。

**验收标准：**

- [x] `repository.ts` 处理 runs/run_events/chat 之外不再有五表 SQL；最终 `repository.ts` 可删除（runs/chat 部分后续 M2 再迁）
- [x] runner/chat 行为不变（`runner.test.ts`、`chat.test.ts` 全绿）
- [x] 测试迁移过程中不删断言、不改预期；被删 API 的覆盖由等价用例承担

**依赖：** T7 ｜ **涉及文件：** `src/main/ai-workflow/{runner,chat,repository}.ts`、测试 ｜ **规模：** M

### T9 账本测试

**描述：** 补 M1 的账本专项测试：决策黄金用例、投影单测、重建等价、导入幂等、强杀重启一致、`timeline`。

**验收标准：**

- [x] 随机事件序列（≥200 条）→ 实时投影 vs 重建投影逐表全等（含五表与 `run_events` 保留）
- [x] 强杀模拟：写完事实不应用投影即关闭 → 重启 `ensureProjection` 后与实时投影全等
- [x] `timeline(taskId)` 能还原创建/移动/完成的事实链；导入根标注正确
- [x] 投影集白名单外的表（`run_events`、聊天表）在重建后原样保留

**依赖：** T4、T5、T6 ｜ **涉及文件：** `src/host/store/*.test.ts`、`src/kernel/*.test.ts` ｜ **规模：** L

### T10 验收与收尾

**描述：** 跑完整门禁与性能基准；更新文档与基线；提交并合并。

**验收标准：**

- [x] 1 万事实重建 < 1 s（脚本或测试内计时，失败给可重复命令）
- [x] `pnpm check` 全绿、覆盖率不低于 99.60/96.71/99.39/99.79、改动行 ≥90%
- [x] `pnpm e2e` 全绿；真实 `pnpm dev` 启动后旧库直接可用（导入路径手动验收）
- [x] 备份进 M1 后恢复演练：把回滚点库复制回去 → 启动 → 五表数据完整
- [x] 更新 [refactor-plan](../docs/planning/refactor-plan.md)、[CAPABILITY-MAP](../docs/CAPABILITY-MAP.md)、`CONSTRAINTS.md` 基线

**依赖：** T7、T8、T9 ｜ **涉及文件：** `docs/`、`tasks/` ｜ **规模：** S

## 进度记录（2026-11-04，分支 `refactor/m1-ledger`）

| 任务                          | 状态 | commit    | 备注                                                                                          |
| ----------------------------- | ---- | --------- | --------------------------------------------------------------------------------------------- |
| T1 host/db + schema           | ✅   | `af85c38` | facts / projection_meta / 指纹 / withTx；DDL 逐列与改前一致                                   |
| T2 protocol 契约              | ✅   | `7f12784` | entities/commands/facts/views/validate；shared 改为派生；`protocol/types.ts` 删除             |
| T3/T4 kernel decide + project | ✅   | `ca56322` | 14 条命令、黄金用例 29 条；阶段规则只复用 stage-machine                                       |
| T5 host/store                 | ✅   | `ab449a3` | dispatch/query/ensureProjection/rebuild；假 kernel 可测；defer FK + stage position 兜底       |
| T6 存量导入                   | ✅   | `075edfc` | 五表分批 500 行 → `snapshot.imported`；幂等/回滚/重建等价；`migrate.ts` 删除                  |
| T7/T8 写路径切换              | ✅   | `7865ba6` | IPC→dispatch/query；engine→`host/task-effects`；repository 旧写方法删除；测试种子改真实 store |
| T9 账本测试                   | ⏳   | —         | 重建等价/强杀重启/时间线（部分已由 T5/T6 覆盖），待补 10k 重建基准                            |
| T10 验收与收尾                | ⏳   | —         | `pnpm check` 覆盖率收口中；e2e、文档、合并待做                                                |

### 实现偏差（执行中确认，均已写进 m1-plan）

1. `View` 只含五张投影表 + `activeTaskIds`；`runs` 不在投影集（M2 入账），「执行中」判定用 `activeTaskIds`。
2. 事实 payload 携带完整实体行（含 `Runtime.lastProbe`），保证 `project(fact)` 纯函数、增量与重建等价；凭据类字段不进事实。
3. `workflow.update` 用可选 `StageInput.id` 差量；UI 暂不发 id，等价旧「重建阶段 + 按 position 回挂」；新增「有活跃 run 拒绝改阶段」（SPEC-kernel:200，旧实现缺失）。
4. 删除不存在的实体沿用旧行为：静默成功、不产事实；create/update 的 not_found 仍 reject。
5. FK 口径：增量写 FK ON（保留旧级联语义），重建临时 FK OFF 只清白名单五表；重建后 `runs` 可能残留，属 M1 已知边界（M2 消除）。
6. `timeline()` 只在内核提供（有单测），不进 `KernelPort`/store；M5 视图再暴露。
7. 启动顺序：`importLegacyIfNeeded` → `ensureProjection`（先导入更安全，避免空事实时把存量当投影清掉）。
8. `agents.remove` 被对话引用时错误文案退化为 SQLite FK 原文（删除仍被拒绝、数据不丢），M2 扩 View 后恢复可读文案。

## M1 退出记录（2026-11-04，分支 `refactor/m1-ledger`）

- 提交链：`af85c38`（host 基础设施）→ `7f12784`（protocol）→ `ca56322`（kernel decide/project）→ `ab449a3`（store）→ `075edfc`（存量导入，删 migrate）→ `7865ba6`（写路径切换）→ `5a23f60`（覆盖率收口）→ `f01240b`（账本专项测试）→ `6d043ed`（启动顺序 + 进度记录）。
- 门禁：`pnpm check` 全绿——78 文件 / 772 用例，覆盖率 **99.71 / 97.59 / 99.52 / 99.85**（基线 99.60/96.71/99.39/99.79），改动行 **948/948 = 100%**；`pnpm e2e` 5/5。
- 账本专项：`src/host/store/rebuild.test.ts` 覆盖 206 条混合命令的增量 vs 重建逐表全等、文件库强杀重启后 `ensureProjection` 追平、白名单外表保留、timeline 链；`rebuild.perf.test.ts` 1 万事实重建实测 **82.5–152.2 ms**（< 1 s 预算，8–12× 余量）。
- 真实库导入验收：用 M0 备份库（`ai-workflow-2026-11-04T1940-pre-m1.db`）以临时 userData 启动 M1 应用，写入 5 条 `snapshot.imported`（facts seq 1–5，meta seq=5），投影五表与运行/聊天表行数与备份完全一致（tasks 1 / runs 15 / workflows 1 / stages 3 / agents 1 / runtimes 1 / chat 1+4 / run_events 98）。
- 已知边界：`runs` 在重建后可能残留（不在投影集，M2 入账后消除）；`agents.remove` 被对话引用时错误文案退化为 SQLite FK 原文；`decide.ts` 3 处公共入口不可达的防御分支未覆盖（不为覆盖率放松实现）。
