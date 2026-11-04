# M1 任务清单（账本）

> 计划说明见 [m1-plan.md](./m1-plan.md)。规则：每个任务结束跑 `pnpm check:fast`；里程碑检查点跑完整 `pnpm check` 与 `pnpm e2e`。
> 分支 `refactor/m1-ledger`，起点 `master` @ `2212a59`；回滚点 `%APPDATA%\workbench\backups\ai-workflow-2026-11-04T1940-pre-m1.db`。

## 阶段 1：基础设施

### T1 `host/db.ts` + `host/schema.ts`

**描述：** 把 `src/main/ai-workflow/db.ts` 迁成 `src/host/db.ts`，新增 `src/host/schema.ts`：facts、projection_meta、五张投影表 DDL（沿用现有列名与约束）、索引；提供事务助手与指纹函数。

**验收标准：**

- [ ] `openDb` 保留 PRAGMA（WAL / busy_timeout / integrity_check / foreign_keys）与错误关闭行为
- [ ] `facts(seq INTEGER PRIMARY KEY AUTOINCREMENT, type, actor_json, at, cause, hops, payload)`；`projection_meta(id, format, seq)`；索引覆盖 `facts(type)`、`facts(cause)`
- [ ] `withTx(db, fn)` 单事务；异常回滚
- [ ] 投影表 DDL 与现有 `schema.ts` 五表逐列一致（含唯一约束与外键），测试逐列断言
- [ ] `format` 指纹 = DDL 哈希 + `KERNEL_VERSION` 常量，变更即失配

**验证：** `pnpm test src/host`；迁移期 `src/main/ai-workflow/db.ts` 暂时 re-export `host/db.ts`，旧测试不动仍绿。

**依赖：** 无 ｜ **涉及文件：** `src/host/db.ts`、`src/host/schema.ts`、`src/host/db.test.ts`、`src/main/ai-workflow/db.ts` ｜ **规模：** M

### T2 protocol 契约

**描述：** 建 `src/protocol/{entities,commands,facts,views,validate}.ts`；`kernel` 只依赖这里；`shared/ai-workflow-api.ts` 改为从 protocol 派生类型（IPC 契约形状不变，renderer 零改动）；删除 `src/protocol/types.ts` 过渡桥接。

**验收标准：**

- [ ] `entities.ts` 定义任务/工作流/阶段/智能体/运行时行类型（与现有 `shared/ai-workflow-api.ts` 字段逐一对应，`shared` 侧改为 re-export）
- [ ] `facts.ts` 定义 M1 覆盖的事实名常量与 payload 类型
- [ ] `commands.ts` 定义 M1 覆盖的命令（配置三组 + task 四命令）
- [ ] `validate.ts` 校验命令形状（字符串长度、必填、数组上限），非法返回 `reason` + 文案，不抛
- [ ] `protocol/types.ts` 删除；kernel 的 stage-machine / stage-validation import 同步更新
- [ ] `pnpm typecheck`、`pnpm test src/kernel src/main` 全绿

**依赖：** T1 ｜ **涉及文件：** `src/protocol/*.ts`、`src/shared/ai-workflow-api.ts`、`src/kernel/workflow/*.ts` ｜ **规模：** M

### T3 `kernel/types.ts` + `view-spec.ts` + `decide.ts`（配置）

**描述：** 落内核类型契约（Actor、FactDraft、View、Environment、Decision、Change、Table）；实现 `viewSpec(input)` 与 `decide` 的配置命令：workflow / agent / runtime 的增删改与探测结论。

**验收标准：**

- [ ] `decide` 纯函数：不读时钟/随机/文件/DB，`now`、id 生成、`env` 全部由参数传入
- [ ] 工作流命令产出 `workflow.*` + `stage.*` 事实；阶段 id 由宿主传入的 id 生成器产生，更新不重建 id，删除用 tombstone 事实
- [ ] 引用校验：agent 的 runtime 必须存在；runtime 被 agent 引用时不可删；名称唯一；有活跃 run 的工作流拒绝改阶段（`decide` 读 View 判断，不查库）
- [ ] 非法输入返回 `reject { code, message }`，不抛异常
- [ ] `viewSpec` 为每个输入返回所需投影切片（M1 先按表粒度，禁止 `['tasks','workflows',...]` 全量）
- [ ] 黄金测试：每个命令 × 合法/非法状态，断言输出 `facts` 对象全等（含 `cause/hops` 不伪造）

**依赖：** T2 ｜ **涉及文件：** `src/kernel/types.ts`、`src/kernel/decide.ts`、`src/kernel/view-spec.ts`、对应测试 ｜ **规模：** M

### T4 `kernel/decide.ts`（任务）+ `project.ts`

**描述：** 补任务命令的决策（复用 `stage-machine` 的阶段规则、入口效果只产「需要建 run」的描述而不建 run）、实现 `project(fact)` 对五张投影表的 Change[]、实现 `timeline`。

**验收标准：**

- [ ] `task.create/move/complete/remove` 产出 `task.*` 事实；拖拽落点即目标；打回目标等于当前阶段时零效果；有活跃 run 时拒绝移动/完成（M1 的活跃 run 读 View 里 runs 表切片）
- [ ] `project` 纯函数、可重放：同一事实序列重复 fold 结果全等；删除用 `row=null`
- [ ] `timeline` 返回事实链，`snapshot.imported` 标注「迁移导入」，不对其伪造 `cause`
- [ ] 单元测试覆盖五表的追加/更新/删除、tombstone、破坏性顺序（先建后删）
- [ ] `decide` 输出的阶段流转规则与现有测试行为逐条一致（迁移清单第 1–5 条）

**依赖：** T3 ｜ **涉及文件：** `src/kernel/decide.ts`、`src/kernel/project.ts`、`src/kernel/timeline.ts`、对应测试 ｜ **规模：** M

### T5 `host/store/*`

**描述：** 实现 Store：`dispatch(input)`（校验 → 按 `viewSpec` 装载 View → `decide` → 单事务追加事实 + 应用投影 → 更新 `projection_meta`）、`query`（按视图 id 返回投影切片）、`rebuild()`、`timeline()`、`factsSince(seq)`。

**验收标准：**

- [ ] dispatch 事务内：`facts` 追加、投影变更、`projection_meta.seq` 三者原子提交；失败全部回滚
- [ ] 并发冲突：事务内 `facts.seq` 与 `view.seq` 不一致 → 重读视图重试一次，再冲突则报错
- [ ] 启动 `ensureProjection()`：format 失配或 seq 落后 → 清空投影集白名单表 → 按 seq fold 重建 → 写回 meta
- [ ] `query` 装载切片（不整表），task/workflow/agent/runtime 读取方法替代 `repository` 对应读
- [ ] 测试：内存 SQLite 上「决策 → 事实 → 投影」原子性、回滚、重建等价、viewSpec 切片

**依赖：** T1、T2 ｜ **涉及文件：** `src/host/store/**`、对应测试 ｜ **规模：** L

### T6 存量导入

**描述：** 启动时若 `facts` 为空且旧五表有数据，按表分批写 `snapshot.imported`；`migrate.ts` 的手写 DDL 升级删除，改为指纹 + 重建。

**验收标准：**

- [ ] 分批 ≤500 行、单事务、幂等（facts 非空即跳过）
- [ ] 导入后五表行数/内容与导入前逐行相等（测试：造 v2 库 → 导入 → 查询逐行对比）
- [ ] `timeline` 对导入根返回「迁移导入」；后续事实有完整 `cause`
- [ ] 导入失败整体回滚，不留半套数据
- [ ] `migrate.ts` 与 `migrate.test.ts` 删除（能力由 `snapshot.imported` + 指纹覆盖），`db.test.ts` 相应更新

**依赖：** T5 ｜ **涉及文件：** `src/host/store/import.ts`、`src/main/ai-workflow/migrate.ts`（删）、测试 ｜ **规模：** M

## 检查点 A：基础设施完成

- [ ] T1–T6 完成；`pnpm check` 全绿（覆盖率不低于基线）
- [ ] 五张投影表可由事实重建，导入幂等；旧 `migrate.ts` 删除
- [ ] `src/kernel` 纯度测试仍绿；`decide/project` 无 IO/时钟/随机

## 阶段 2：收口与验收

### T7 IPC 与写路径切换

**描述：** `src/main/ai-workflow/ipc.ts` 的配置/任务 handler 改为 `store.dispatch`；`engine.ts` 的决策部分并入 `kernel/decide`，只保留宿主侧「提交后建 run」的效果执行（`host/task-effects.ts`）。删除 `repository` 的配置与任务写方法。

**验收标准：**

- [ ] IPC 行为不变（现有 `ipc.test.ts` 断言全绿，仅装配方式变化）
- [ ] `repository` 中 `runtimeCreate/Update/Remove/SetProbe`、`agent*`、`workflow*`、`taskCreate/Update/Remove` 删除；对应写 SQL 只在 `host/store`
- [ ] `engine.ts` 不再含阶段规则（规则只在 kernel），仅执行「建 run + 回调调度」
- [ ] 全局搜索确认无第二处写五表（`INSERT INTO tasks|workflows|workflow_stages|agents|runtimes` 只在 store）

**依赖：** T4、T5、T6 ｜ **涉及文件：** `src/main/ai-workflow/{ipc,engine}.ts`、`src/main/ai-workflow/repository.ts`、`src/host/task-effects.ts` ｜ **规模：** L

### T8 读取路径与测试迁移

**描述：** `runner`/`chat`/IPC 对五表的读取改走 store 查询；删除 `repository` 剩余五表读方法；`repository.*.test.ts` 按新入口迁移（读取断言保留，写断言跟 `decide` 黄金用例搬家）。

**验收标准：**

- [ ] `repository.ts` 处理 runs/run_events/chat 之外不再有五表 SQL；最终 `repository.ts` 可删除（runs/chat 部分后续 M2 再迁）
- [ ] runner/chat 行为不变（`runner.test.ts`、`chat.test.ts` 全绿）
- [ ] 测试迁移过程中不删断言、不改预期；被删 API 的覆盖由等价用例承担

**依赖：** T7 ｜ **涉及文件：** `src/main/ai-workflow/{runner,chat,repository}.ts`、测试 ｜ **规模：** M

### T9 账本测试

**描述：** 补 M1 的账本专项测试：决策黄金用例、投影单测、重建等价、导入幂等、强杀重启一致、`timeline`。

**验收标准：**

- [ ] 随机事件序列（≥200 条）→ 实时投影 vs 重建投影逐表全等（含五表与 `run_events` 保留）
- [ ] 强杀模拟：写完事实不应用投影即关闭 → 重启 `ensureProjection` 后与实时投影全等
- [ ] `timeline(taskId)` 能还原创建/移动/完成的事实链；导入根标注正确
- [ ] 投影集白名单外的表（`run_events`、聊天表）在重建后原样保留

**依赖：** T4、T5、T6 ｜ **涉及文件：** `src/host/store/*.test.ts`、`src/kernel/*.test.ts` ｜ **规模：** L

### T10 验收与收尾

**描述：** 跑完整门禁与性能基准；更新文档与基线；提交并合并。

**验收标准：**

- [ ] 1 万事实重建 < 1 s（脚本或测试内计时，失败给可重复命令）
- [ ] `pnpm check` 全绿、覆盖率不低于 99.60/96.71/99.39/99.79、改动行 ≥90%
- [ ] `pnpm e2e` 全绿；真实 `pnpm dev` 启动后旧库直接可用（导入路径手动验收）
- [ ] 备份进 M1 后恢复演练：把回滚点库复制回去 → 启动 → 五表数据完整
- [ ] 更新 [refactor-plan](../docs/planning/refactor-plan.md)、[CAPABILITY-MAP](../docs/CAPABILITY-MAP.md)、`CONSTRAINTS.md` 基线

**依赖：** T7、T8、T9 ｜ **涉及文件：** `docs/`、`tasks/` ｜ **规模：** S
