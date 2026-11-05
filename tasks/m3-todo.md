# M3 任务清单（运行时与执行器插件）

> 进度（2026-11-05，M3 退出）：T1–T13 已全部交付。M3a 证据见 `68ce59c` 与上文；M3b/M3c 提交链 `c45b3ff`（detect 归插件 + 只读执行器清单）→ `be0bba6`（`command` 插件与 `argsTemplate`）→ `1da37c4`（运行时表单执行器选择 + 参数模板）→ `8413248`（detect 汇总分支用例）→ `e84bb5b`（SPEC/架构修订）。门禁：`pnpm check` exit 0、`pnpm e2e` 6/6、覆盖率 99.81/97.92/100/100、改动行 693/695 = 99.71%；真 CLI 阶段/聊天/取消三轮回执见文末「M3 退出记录」。下文勾选框保留为原始验收项。

> 计划说明见 [m3-plan.md](./m3-plan.md)。规则：每个任务结束跑 `pnpm check:fast`；检查点跑完整 `pnpm check` 与 `pnpm e2e`。
> 本阶段把执行器从 `src/main/ai-workflow/runtime/**` 搬到 `src/plugins/executors/**`，新增 `src/sdk` 与 `src/plugins/registry.ts`，运行时改用 `executorKey` 选插件。契约与迁移口径以 m3-plan「架构决议 D1–D14」为准。
> 前置约束：先开分支（已开 `refactor/m3-executors`）；`tsconfig.node.json`、`eslint.config.mjs` 与 `pnpm check` 的门禁接线必须早于新目录落地；`floor-guard` 扫描 `.md`，本文件不得出现三类字样。

## 阶段 1：契约、结构升级与内核去产品化

### T1 契约面：executorKey / 插件契约 / manifest / sdk 类型

**描述：** `protocol/entities.ts` 删 `PROTOCOL_FAMILIES`/`RuntimeProtocolFamily`，`Runtime.executorKey: string`、`RuntimeInput.executorKey?: string`、`RunRow.executorKey` 注释改口径；`protocol/executor.ts` 增 `ExecutorContext`/`ExecutorPlugin`（`probe?/models?/detect?/run`）并保留 `Turn`/`ExecutorIO`/`Receipt`；新增 `src/plugins/manifest.ts`（`PluginManifest`/`PluginKind`/`Capability`/`ConfigField`）与 `src/sdk/types.ts`（`Sdk`/`SdkHost`/能力枚举）；`shared/ai-workflow-api.ts` 去 `RuntimeProtocolFamily` re-export、`RuntimeInput`/`DetectedRuntime` 形状同步；`protocol/validate.ts` 把 `protocolFamily` 换成 `executorKey` 形状校验（非空、`^[a-z][a-z0-9-]{0,63}$`）；`tsconfig.node.json` include 补 `src/sdk/**`、`src/plugins/**`、`tests/{sdk,plugins}/**`。

**验收标准：**

- [ ] 契约里不再出现 `protocolFamily`/`PROTOCOL_FAMILIES`/`RuntimeProtocolFamily`
- [ ] `RuntimeInput.executorKey` 非法形状被 `validate` 拒绝并可读报错；合法 key 不做取值枚举
- [ ] `ExecutorPlugin`/`ExecutorContext` 与 `Sdk` 类型可被 `src/plugins/**` 与 `src/host/**` 同时引用（依赖方向允许）
- [ ] `tsc -p tsconfig.node.json --noEmit` 覆盖新目录（故意写错类型能报错）

**验证：**

- [ ] `pnpm typecheck`、`pnpm lint` 绿；`pnpm test tests/protocol` 绿（断言改名不改语义）

**依赖：** 无　**涉及文件：** `src/protocol/{entities,executor,validate}.ts`、`src/shared/ai-workflow-api.ts`、`src/plugins/manifest.ts`、`src/sdk/types.ts`、`tsconfig.node.json`、`tests/protocol/*`　**规模：** M

### T2 结构升级与投影归一（与 T1 同一提交）

**描述：** `host/schema.ts` 的 `runtimes` 表改 `executor_key TEXT NOT NULL` + `args_template TEXT NOT NULL DEFAULT ''`（D12 预留），删 `protocol_family` 及 CHECK；新增 `RUNTIMES_M3_ADDED_COLUMNS` 与 `legacyRuntimesCopySql`；`host/db.ts` 增 `needsRuntimesUpgrade`/`upgradeRuntimes`（照 `upgradeLegacyRuns` 的 12-step：临时表 → 拷贝并回填 `executor_key` → 删表改名 → 外键 OFF/ON），插在 `upgradeLegacyRuns` 之后、补索引之前；`host/store/projection-apply.ts` 列清单加 `executor_key`/`args_template`，新增 `normalizeRuntime`（缺 `executorKey` → 按旧 `protocolFamily` 映射 `dsh`）；`host/store/views.ts` 行接口/`mapRuntime`/SELECT 同步；`host/store/import.ts` 旧行映射同规则；`kernel/types.ts` 的 `KERNEL_VERSION = 'm3.0.0'`。

**验收标准：**

- [ ] 新库直接建 `executor_key` 列；旧库（v2、M2）打开后 12-step 成功且 `runtimes` 行数不变、`last_probe` 保留
- [ ] 重建 fold 老 `runtime.created/updated` payload（无 `executorKey`）不崩，`executor_key` 回填为 `dsh`
- [ ] `import.ts` 导入 v2 存量时 `runtimes` 行带 `executorKey`；幂等，重复启动不重复导入
- [ ] 指纹变化触发一次全量重建，重建后各投影表逐行与重建前一致

**验证：**

- [ ] `pnpm test tests/host/{schema,db,store}` 绿；新增「老 payload 归一」「12-step 升级」用例；用两份真实库副本各启动一次并逐表比对

**依赖：** T1　**涉及文件：** `src/host/{schema,db}.ts`、`src/host/store/{projection-apply,views,import}.ts`、`src/kernel/types.ts`、`tests/host/**`　**规模：** L

### T3 内核去产品化与 executorKey 路由

**描述：** `kernel/decide.ts` 删运行期 `PROTOCOL_FAMILIES` 副本与 `protocolFamilyOf`，改为读取并原样透传 `executorKey`（形状已由 validate 保证）；`run` 行 `executorKey` 取 `runtime.executorKey`（`:267,:415` 两处）；删内核里的 `'dsh'`/`'multica'` 默认值（`:479-480,:522-523`），`runtime.create` 缺省值改由 IPC 按 manifest 补齐后 dispatch（T7 接线，本任务先让缺省输入被拒绝并给可读原因，避免行为悬空）；`runtime.update` 同样的取值逻辑。

**验收标准：**

- [ ] 内核源码零产品名（`dsh`/`multica`/`claude`）；`grep -R` 可复核
- [ ] `runtime.create` 带合法 `executorKey` 落事实与投影；非法形状被 validate 拒；缺省 `executorKey` 由 IPC 补齐（T7 完成后生效）
- [ ] `run.executorKey` 与运行时配置一致；旧测试夹具改名后断言不变
- [ ] `decide` 仍纯函数（无时钟/随机/IO）

**验证：**

- [ ] `pnpm test tests/kernel` 绿；`tests/kernel/purity.test.ts` 绿

**依赖：** T1,T2　**涉及文件：** `src/kernel/decide.ts`、`tests/kernel/**`　**规模：** M

### 检查点 A（T1–T3）

- [ ] `pnpm check:fast` 绿
- [ ] v2 真库副本与 M2 库副本各启动一次，`runtimes.executor_key` 正确、数据逐行一致、重建等价
- [ ] 应用行为零变化（执行链仍是旧 dsh 适配层，T7 才切）
- [ ] 人工复核 D1/D2/D3 的落地位置

## 阶段 2：sdk、注册表与 dsh 插件

### T4 sdk 实现与能力门控

**描述：** 新增 `src/sdk/index.ts` 的 `createSdk(host, manifest)`：`log`（带插件 id 前缀）、`now`（毫秒）、`paths.sessionRoot`、`config<T>()`（缺省值）、`process.{spawn, resolve, killTree, scanDirs}`；`process` 用 getter 做能力门控，未声明 `spawn`/`fs.read` 时抛 `capability_not_declared`。新增 `src/host/sdk-host.ts`：用 `host/process.ts` 与 `host/executable.ts` 的现有实现组装 `SdkHost`（两文件零改动），`sessionRoot` 由装配根注入。`src/host/process.ts`、`src/host/executable.ts` 一行不改。

**验收标准：**

- [ ] 未声明 `spawn` 的插件拿 `sdk.process` 抛错，声明后透传 `cwd/env/shell`
- [ ] `resolve` 找不到命令返回 `{path:null,error}` 而非抛错；`scanDirs` 缺 PATH 时有兜底
- [ ] `killTree` 返回布尔且不抛；`now` 为毫秒；`log` 前缀含插件 id
- [ ] `sdk` 不 import host/main/renderer/plugins（ESLint 绿）

**验证：**

- [ ] `pnpm test tests/sdk tests/host/sdk-host.test.ts` 绿

**依赖：** T1　**涉及文件：** `src/sdk/{types,index}.ts`、`src/host/sdk-host.ts`、`tests/sdk/**`、`tests/host/sdk-host.test.ts`　**规模：** M

### T5 注册表、manifest 校验与门禁接线

**描述：** 新增 `src/plugins/registry.ts`：`executors: ReadonlyArray<{ key, label, manifest, create(sdk) }>`（先只放 `dsh`，顺序即 UI/detect 顺序）、`executorById(key)`（未知 key 抛可读错误）、`detectAll(sdk)` 的骨架；新增 `src/plugins/executors/dsh/manifest.ts`（检出 T6 实现）。`eslint.config.mjs` 加三段（`src/plugins/**` 禁 node/electron/host/main/renderer/shared；`src/sdk/**` 只允许 protocol；`src/host/**` 注释与规则改为「允许 sdk 与 plugins/registry，禁具体插件实现」）；`scripts/floor-guard.mjs` 加 6 条 `RELOCATED_TESTS` 映射（见 T12）。新增 `tests/plugins/registry.test.ts`（manifest 契约、id 唯一、目录 ↔ 清单双向一致、未知 key）与 `tests/plugins/boundary.test.ts`（跨插件 import、capability 声明 ↔ 用法双向一致；用 purity.test 的 `strip()` 范式）。

**验收标准：**

- [ ] 注册表 id/kind/capabilities 校验拒绝非法 manifest；重复 key 抛错；`executorById('nope')` 可读报错
- [ ] `src/plugins/executors/*` 目录与 registry 清单双向一致（漏注册/幽灵注册都失败）
- [ ] boundary 扫描能抓住「插件 import host」「插件 import 另一个插件」「声明 spawn 但没调」三类违规
- [ ] `src/host` 里的具体插件 import 被 ESLint 拦住；`src/plugins` 里的 `node:fs` 被拦住

**验证：**

- [ ] `pnpm test tests/plugins` 绿；`pnpm lint` 绿；三条门禁各用违规样本验证一次（护栏自检）

**依赖：** T1,T4　**涉及文件：** `src/plugins/{registry,manifest}.ts`、`src/plugins/executors/dsh/manifest.ts`、`eslint.config.mjs`、`scripts/floor-guard.mjs`、`tests/plugins/**`　**规模：** M

### T6 dsh 插件搬迁

**描述：** `plugins/shared/` 收纯函数：JSONL 切行与 `parseFrame`、`tail`、`withStderr`、semver 提取、`parseModelId`、状态映射、终态归一骨架、取消两阶段骨架。`plugins/executors/dsh/{manifest,index,probe,models,run}.ts` 由 `runtime/dsh.ts` 整文件拆出：只经 `sdk` 拿 spawn/killTree/resolve/now/sessionRoot，不再 import `host/**`；`io.emit/io.session/io.process` 三通道保持不变；`result=timeout` 在插件内折成 `Receipt{failed,errorCode:'timeout'}`。测试搬 `tests/plugins/executors/dsh/{probe,models,run,frames}.test.ts`：只换 import 与 `fakeSdk` 夹具，逐例保留断言；6 类失效断言按 `tasks/recon/m3-dsh.md` §5.3 给等价替代。

**验收标准：**

- [ ] 59 例断言逐例可对上（帧解析/ready 三判据/终态归一/取消 3 段时序/会话续接/usage/stderr 截尾）
- [ ] 插件内零 `host`/`node:child_process`/`node:fs` import；spawn cwd 取 `runtime.workdir ?? (turn.cwd || undefined)`（D10）
- [ ] `probe/models` 仍经 `sdk.process`；`runtime='dsh'`、`protocol_version=1` 判据不删
- [ ] 取消时序常量与 Windows 杀树路径不变

**验证：**

- [ ] `pnpm test tests/plugins/executors/dsh` 绿；`pnpm lint` 绿

**依赖：** T4,T5　**涉及文件：** `src/plugins/shared/**`、`src/plugins/executors/dsh/**`、`tests/plugins/executors/dsh/**`　**规模：** L

### T7 调度与 boot 接线、删除旧执行链

**描述：** `src/host/executor.ts` 删 `ExecutorBackend`/`ExecutorBackendOutcome`，改为「`ExecutorPlugin` → `ExecutorPort` 包装」：`resume_rejected` 换新会话 + `fallbackPrompt` 重试一次、chat 失败补「执行失败」仍留本层；`src/host/executor-registry.ts` 新增：`createExecutorRegistry(plugins, sdkHost)` → `SchedulerExecutors`，`forRuntime` 按 `runtime.executorKey` 查插件，未知 key 返回 `null`；`src/host/scheduler.ts` 的 `SchedulerExecutors.forRuntime` 返回 `ExecutorPort | null`，`start` 判空 → `settleFailed(run,'runtime_missing','执行器插件未注册: <key>')`；`src/main/index.ts` 改为「建 sdk-host → 从 registry 建 executors → 注入 scheduler/IPC」，IPC `backendFor(family)` 改 `forRuntime(runtime)`；删 `src/main/ai-workflow/runtime/{dsh,registry,detect}.ts` 与 `executor-port.ts`；同批改 `tests/host/boot.test.ts` 的 3 条顺序/实例断言与 `ipc.test.ts` 假后端。

**验收标准：**

- [ ] boot 顺序、executors 实例、sessionRoot 断言同批更新且绿
- [ ] 未知 `executorKey` 的运行时 → run 终态 `failed`/`errorCode='runtime_missing'`，文案含 key，进程不启动
- [ ] `resume_rejected` 重试补测试：首次拒 → 二次用新会话 + 完整历史；两次都拒 → failed；取消优先于 failed
- [ ] 生产代码不再 import `main/ai-workflow/runtime/**`；`src/main/ai-workflow` 只剩 `ipc.ts`

**验证：**

- [ ] `pnpm test tests/host` 绿；`pnpm test` 全量绿；`pnpm e2e` 6/6

**依赖：** T3–T6　**涉及文件：** `src/host/{executor,executor-registry,scheduler}.ts`、`src/main/index.ts`、`src/main/ai-workflow/ipc.ts`、`tests/host/**`、`tests/main/**`　**规模：** L

### T8 假协议端到端验收

**描述：** 新增夹具 `tests/plugins/support/fake-plugin.ts`（`manifest{id:'fake',kind:'executor',capabilities:['spawn']}`，`run` 发两帧后返回成功回执，`probe/models` 返回常量，`detect` 返回固定候选）；新增 `tests/plugins/acceptance.test.ts`：内存库 + 真 store + 真 scheduler + **真 registry（含 fake）**，走 `runtime.create{executorKey:'fake'}` → 智能体 → 工作流 → 任务 → `wake()`。

**验收标准：**

- [ ] `runs.executorKey='fake'`；`run_events` 两帧 seq 从 1 单调；`run.receipt` 在帧之后
- [ ] 另一条 `executorKey:'dsh'` 的运行时不被 fake 插件处理（调用次数 0/1 可断言）
- [ ] 全程零 `main/**` import（「只写插件」的判定）；`git diff` 仅新增 `plugins/**` 与 registry 一行即可跑通（在验收记录里附 diff 证据）
- [ ] 用例不依赖 electron/窗口

**验证：**

- [ ] `pnpm test tests/plugins/acceptance.test.ts` 绿

**依赖：** T7　**涉及文件：** `tests/plugins/support/fake-plugin.ts`、`tests/plugins/acceptance.test.ts`　**规模：** M

### 检查点 B（T4–T8）

- [ ] `pnpm check:fast` 绿；`tests/sdk`、`tests/plugins` 全绿
- [ ] dsh 59 例等价清单逐条打勾
- [ ] boundary 扫描与 ESLint 边界绿
- [ ] 假协议端到端用例绿

## 阶段 3：detect、UI 与 command 插件

### T9 detect 归插件

**描述：** 新增 `src/plugins/shared/cli-catalog.ts`（10 条候选，顺序即输出顺序）；`ExecutorPlugin.detect?()` 返回本插件可接入的命中（dsh 只报 `dsh`）；`registry.detectAll(sdk)` 串行按 registry 顺序、单插件 2 s 超时、失败隔离（跳过并记日志，整体不抛）、同 `command` 先到先得 + warn；`DetectedRuntime` 增 `executorKey` 并保留 `supported`（= registry 内是否存在该 key）；`src/main/ai-workflow/ipc.ts` 的 `runtimes.detect` 改走 registry；`tests/main/ai-workflow/runtime/detect.test.ts` 搬 `tests/plugins/executors/dsh/detect.test.ts`，`statSync` mock 方式保留。

**验收标准：**

- [ ] detect 仍零副作用（不 spawn、不写库、不发 changed），只读文件系统
- [ ] 输出顺序稳定；重复 command 去重；单插件抛错不影响其它插件结果
- [ ] 「装了但无插件」的 CLI 仍以 `supported:false` 出现（三态 UI 行为不变）
- [ ] 未知/缺失 registry 时 detect 返回空数组而不是抛错

**验证：**

- [ ] `pnpm test tests/plugins/executors/dsh/detect.test.ts tests/host/ipc.test.ts` 绿

**依赖：** T5,T7　**涉及文件：** `src/plugins/{registry,shared/cli-catalog}.ts`、`src/plugins/executors/dsh/**`、`src/main/ai-workflow/ipc.ts`、`src/shared/ai-workflow-api.ts`、`tests/**`　**规模：** M

### T10 renderer：执行器选择与展示

**描述：** IPC 新增只读 `runtimes.executors()`（`[{key,label,command,profile}]`，来自 registry）；`RuntimeDialog` 表单加「执行器」下拉（选项来自该方法），新建默认值取首项 manifest 的 `command`/`profile`；`RuntimeManager` 角标显示 `executorKey`（或 label）；`newRuntimeInput` 默认值不再写死 `dsh`/`multica`。

**验收标准：**

- [ ] 新建运行时可选执行器；选 `dsh` 后 command/profile 预填来自 manifest，可改
- [ ] 列表页角标显示执行器而非协议族；已添加/未注册三态文案不变
- [ ] 组件测试只改字段来源，不改交互断言；`aria` 与文案保持（E2E 依赖）

**验证：**

- [ ] `pnpm test tests/renderer/src/apps/ai-workflow` 绿；`pnpm typecheck` 绿

**依赖：** T9　**涉及文件：** `src/main/ai-workflow/ipc.ts`、`src/shared/ai-workflow-api.ts`、`src/renderer/src/apps/ai-workflow/{api.ts,components/Runtime{Dialog,Manager}.tsx}`、`tests/renderer/**`　**规模：** M

### T11 `command` 插件与 `argsTemplate`

**描述：** `Runtime`/`RuntimeInput` 增 `argsTemplate: string`（JSON 数组文本，NULL/空 = 无参数），`runtime.create/update` 校验：≤20 项、占位符白名单 `{model}/{effort}/{cwd}/{context}/{prompt}`、未知占位符拒绝；`plugins/executors/command/` 实现 `run`：展开模板为 argv（每项独立元素），`{prompt}` 出现 → 该元素替换为 prompt，否则 prompt 走 stdin；`resolve` 后 `.cmd/.bat` 经 `cmd /c` 固定包装；不给 `detect`、不给 `probe` 判据（仅校验可执行文件可解析）；`argsTemplate` 表单字段落在运行时表单（文本域）。**可整体后置**（不阻塞 M3a 验收）。

**验收标准：**

- [ ] 模板 `["--print","{prompt}"]` 时 prompt 是独立 argv 元素，不出现在任何拼接字符串里
- [ ] 无 `{prompt}` 时 prompt 走 stdin；`{model}`/`{effort}`/`{cwd}`/`{context}` 正确替换
- [ ] 非法占位符/超长模板被内核或 IPC 拒绝并给可读错误
- [ ] Windows `.cmd` 场景经固定包装启动，参数不被 shell 二次解释

**验证：**

- [ ] `pnpm test tests/plugins/executors/command` 绿；`tests/protocol`、`tests/kernel` 相应用例绿

**依赖：** T2,T9,T10　**涉及文件：** `src/protocol/{entities,validate}.ts`、`src/kernel/decide.ts`、`src/plugins/{registry,executors/command/**,shared/argv.ts}`、`src/renderer/.../RuntimeDialog.tsx`、`tests/**`　**规模：** M

### 检查点 C（T9–T11）

- [ ] `pnpm check:fast` 绿
- [ ] detect 用例与三态 UI 行为保持
- [ ] `command` 插件（若纳入）端到端可用；不纳入则记录后置理由

## 阶段 4：收尾与验收

### T12 测试搬家收口与覆盖率

**描述：** 按下表完成搬家（floor-guard 六条映射生效）；删 `tests/main/ai-workflow/runtime/**` 的旧文件；补新代码分支用例（空注册表、未知 key、sdk 门控拒绝、registry detect 失败隔离、scheduler 端口为 null、argsTemplate 非法）；`pnpm check:diffcov` 确认新文件被测试加载。

| 源                                                     | 目标                                         | 备注                    |
| ------------------------------------------------------ | -------------------------------------------- | ----------------------- |
| `tests/main/ai-workflow/runtime/dsh.test.ts`           | `tests/plugins/executors/dsh/dsh.test.ts`    | 59 例，只换 import/夹具 |
| `tests/main/ai-workflow/runtime/detect.test.ts`        | `tests/plugins/executors/dsh/detect.test.ts` | 三态断言改来源          |
| `tests/main/ai-workflow/runtime/registry.test.ts`      | `tests/plugins/registry.test.ts`             | 合并为注册表用例        |
| `tests/main/ai-workflow/runtime/executor-port.test.ts` | `tests/plugins/executors/dsh/port.test.ts`   | 4 例                    |
| `tests/main/ai-workflow/runtime/process.test.ts`       | `tests/host/process.test.ts`                 | 与源码同层              |
| `tests/main/ai-workflow/runtime/executable.test.ts`    | `tests/host/executable.test.ts`              | 与源码同层              |
| `tests/host/executor.test.ts`                          | 原位改测插件包装                             | 12 例断言保留           |

**验收标准：**

- [ ] 搬迁后断言总数不减少（floor-guard 的断言净减少规则通过）
- [ ] `node scripts/floor-guard.mjs` 通过；无测试文件被误判删除
- [ ] `pnpm check:diffcov` 通过（改动行 ≥90%，新文件均被加载）

**验证：**

- [ ] `pnpm check` exit 0

**依赖：** T6–T11　**涉及文件：** `tests/**`、`scripts/floor-guard.mjs`　**规模：** M

### T13 验收与退出记录

**描述：** 跑 `pnpm check`、`pnpm e2e`；老库两份副本（v2 真库副本、M2 库副本）各启动一次并逐表比对；真 dsh CLI 跑一轮阶段 + 一轮聊天 + 一次取消；按 `tasks/recon/m3-runtime-config.md` §6 修订四份 SPEC 与 CAPABILITY-MAP/ARCHITECTURE；refactor-plan 增 M3 退出记录（提交链、证据、已知边界、兼容层删除条件）。

**验收标准：**

- [ ] `pnpm check` exit 0，覆盖率不低于基线，改动行 ≥90%
- [ ] `pnpm e2e` 6/6；打包冒烟结论单独记录（沿用 M2 已知问题）
- [ ] 老库数据逐行一致；`runtimes.lastProbe` 保留
- [ ] 真 CLI 验收三条（阶段/聊天/取消）有耗时与输出证据
- [ ] SPEC/文档修订完成；退出记录含回滚点与「下一步 M4」

**验证：**

- [ ] 上述命令与手工验收记录写入 `tasks/m3-todo.md` 与 refactor-plan

**依赖：** T12　**涉及文件：** `docs/specs/**`、`docs/{ARCHITECTURE,CAPABILITY-MAP}.md`、`docs/planning/refactor-plan.md`、`tasks/m3-todo.md`　**规模：** M

## 门禁与回滚

- 开工备份：`%APPDATA%\workbench\backups\ai-workflow-2026-11-05T1055-pre-m3.db`（+ JSON）；M3 期间数据层变更不可逆，回滚需恢复该备份并重建投影。
- 每任务 `pnpm check:fast`；检查点 A–C 跑完整 `pnpm check`；退出前跑 `pnpm e2e`。
- `floor-guard` / `diffcov` 必须用 `CONSTRAINTS_BASE=831f2dd` 或固定分支基准，避免 master 上假绿；门禁脚本在非受限终端执行。
- 任何新 `src/**` 文件都要被测试加载；纯类型入口命名 `types.ts`。

## M3 退出记录（2026-11-05）

- 提交链：M3a `d8ca5fe` → `8d135f3` → `8c75e6c` → `1a1666f` → `97ecd6e` → `1859883` → `ca7644f` → `68ce59c`；M3b/M3c `c45b3ff`（detect 归插件 + 只读执行器清单 + IPC/preload/shared 接线 + detect 测试搬家）→ `be0bba6`（`command` 插件与 `argsTemplate` 展开；同批带入 `SPEC-plugins.md` 的部分在途文档改动）→ `1da37c4`（运行时表单执行器选择 + 参数模板 + 角标 label）→ `8413248`（detect 汇总分支用例收口）→ `e84bb5b`（SPEC / ARCHITECTURE / CAPABILITY-MAP 修订）→ 本记录提交。
- 门禁证据：`pnpm check` exit 0（typecheck / lint / floor / secrets / 覆盖率 / 改动行 / audit 全绿）；`pnpm test` 91 文件 / 1097 用例；覆盖率 **99.81 / 97.92 / 100 / 100**（基线 99.73 / 97.78 / 100 / 100）；`check:diffcov` **693/695 = 99.71%**（门槛 90%）；`pnpm e2e` **6/6**；`check:floor`、`check:secrets` clean；`pnpm audit` 生产依赖 0 漏洞。
- 真 CLI 验收（dsh 0.2.1-rc.5 / profile `multica`，v2 真库副本、未写真实数据）：阶段执行 `succeeded` / 输出 `PONG` / **4.0 s**（复跑 7.0 s，首轮含进程冷启动）；聊天一轮 `succeeded` / `PONG` / **5.5 s**（复跑 4.0 s）；执行中取消 → `cancelled` / `errorCode=cancelled`，取消请求到终态 **2.0 s**（cancel 帧后进程退出，未触发 SIGKILL 兜底）。
- 老库两份副本：① v2 真库副本升级后 `facts=9`、`runs=15`、`run_events=98`、旧聊天 1 对话 + 4 消息逐行保留、`runtimes.executor_key='dsh'`、`last_probe_json` 原样、`integrity_check=ok`；② M2 格式副本（用 M2 代码把同一 v2 副本导入/重建生成）由 M3 打开：`import=false`、`rebuild=true`（`KERNEL_VERSION=m3.0.0`）、`executor_key='dsh'`、`lastProbe` 保留、facts / runs / run_events 不变、旧 `chat_*` 表 0 张。
- 结构：`src/main/ai-workflow/runtime/**` 与 `tests/main/ai-workflow/runtime/**` 删除；detect 用例搬 `tests/plugins/executors/dsh/detect.test.ts`（14 例，原 14 例语义逐条保留）；新增 `src/plugins/shared/cli-catalog.ts`、`src/plugins/executors/command/**`、`src/plugins/shared/argv.ts`；IPC 新增只读 `runtimes.executors`；运行时表单新增执行器下拉与 `argsTemplate` 文本域。
- 兼容层（D9）：M3 **不删** M2 的 `host/store/import.ts`（实库仍是 v2，首启必须靠它导入）。删除条件：真实库（非副本）首启一次、`facts` 非空、删后复测重建等价；作为 M3 之后独立清理任务登记。
- 已知边界与偏差：`card.*` 投递与回答闭环在 M4；`commandId` 幂等与 IPC 三动词在 M5；`command` 插件只有单测，真 CLI 验收只覆盖 dsh；`supported:false` 的提示文案仍是「当前版本仅接入 DSH」（三态行为不变，文案随 M4 通道统一调整）；打包冒烟沿用 M2 已知问题（electron-builder 产物启动崩溃，工具链排查中，未纳入本轮门禁）；`SPEC-plugins.md` 部分改动随功能提交 `be0bba6` 而非独立文档提交；M2 格式库由 M2 代码生成（历史备份只有 v2 格式，没有 M2 快照）。
- 实现偏差：`command` 插件按「resolve 返回路径是 Windows 形态（盘符/UNC）+ `.cmd/.bat` 后缀」判定固定包装，不读 `process.platform`（插件拿不到 Node 全局）；`detect` 汇总拆成 `detectAllWith(entries, sdkHost, options)` 以便测空注册表 / 顺序 / 去重，`detectAll` 只是内置清单的薄封装；`DetectedRuntime` 保留 `supported`，语义改为「注册表里存在该执行器」（D8 选项 2）。
- 回滚点：`%APPDATA%\workbench\backups\ai-workflow-2026-11-05T1055-pre-m3.db`（sha256 与源库一致、`integrity_check=ok`、9 表 125 行）+ 同目录 JSON；回滚需恢复该库并重建投影。
- 下一步：M4 卡片投递与回答闭环（`card.*` + 通道）；之后 M5 IPC 三动词与 `kernelStore`。
