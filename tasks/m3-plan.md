# 实施计划：M3 运行时与执行器插件（dsh 插件化 + executorKey 路由 + sdk）

> 依据 [refactor-plan](../docs/planning/refactor-plan.md) M3 行、[SPEC-plugins.md](../docs/specs/SPEC-plugins.md)（path/executor/manifest/registry）、[SPEC-kernel.md](../docs/specs/SPEC-kernel.md)（`executorKey` 派活口径）、[SPEC-host.md](../docs/specs/SPEC-host.md)（scheduler 按 `runtime.executorKey` 调执行器）、[ARCHITECTURE.md](../docs/ARCHITECTURE.md)（依赖方向）。
> 起点：`master` @ `831f2dd`（M2 退出 + 打包门禁复核后）。工作分支 `refactor/m3-executors`。
> 目标：**执行器变成插件，运行时靠 `executorKey` 选插件**。`dsh` 整文件搬 `src/plugins/executors/dsh/`；新增 `command` 插件；新增 `src/plugins/registry.ts` 与 `src/sdk`；`detect` 归插件；新增运行时协议 = 新增插件目录 + registry 一行，内核/宿主零改动。
> 本阶段不做：`card.*` 与通道（M4）、`kernelStore`/IPC 三动词（M5）、规则与线程（M6/M6.5）、外部插件子进程（M7）。
> 任务明细与验收见 [m3-todo.md](./m3-todo.md)。测绘证据见 `tasks/recon/m3-{dsh,runtime-config,gates}.md`。

## 开工前提（2026-11-05）

- 分支 `refactor/m3-executors` @ `831f2dd`；工作树干净。
- 回滚点：`%APPDATA%\workbench\backups\ai-workflow-2026-11-05T1055-pre-m3.db`（sha256 与源库一致 `8791DDDA…9AA48F8D`、`integrity_check=ok`、`user_version=2`、9 表 125 行）+ 同目录 JSON 导出。
- **注意：该实库是 M1 之前的 v2 格式（无 `facts` 表，仍有 `chat_*` 表）**。M3 首次启动仍会走 `host/store/import.ts` 的存量导入兼容层；因此本阶段**不删** M2 兼容层（见 D9）。
- 门禁前置：`tsconfig.node.json` 的 `include` 缺 `src/sdk/**`、`src/plugins/**`、`tests/{sdk,plugins}/**`；`eslint.config.mjs` 缺 plugins/sdk 两段。这两处必须与 T1 同批改，否则新目录不参与类型检查、`pnpm check` 直接红。
- `floor-guard` 对未跟踪文件整文件扫描（`.md` 无豁免）：本计划、`m3-todo.md`、复测笔记里不出现三类字样（抑制检查器 / 未完成标记 / 放松测试）。

## 现状（测绘结论，2026-11-05）

| 事实                                                                                                                                   | 证据                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SPEC 已按 `executorKey` 写好，代码落后于 SPEC：`RunRow.executorKey` 已存在但是死数据（调度器不读），值由 `runtime.protocolFamily` 推导 | `docs/specs/SPEC-host.md:42`、`src/protocol/entities.ts:325-326`、`src/kernel/decide.ts:267,415`                                                                                                               |
| 协议族/产品名硬编码生产代码 14 处；DB CHECK 只有一处                                                                                   | `src/protocol/entities.ts:28`、`src/host/schema.ts:21-22`、`src/main/ai-workflow/runtime/{registry,detect}.ts`、`src/main/ai-workflow/ipc.ts:140-141`、renderer `RuntimeDialog.tsx:52`/`RuntimeManager.tsx:27` |
| dsh 适配层 894 行、自身零 node 内置 import，但 import `host/executable` 与 `host/process`（插件不允许）                                | `src/main/ai-workflow/runtime/dsh.ts:9-17`                                                                                                                                                                     |
| sdk 缺口：杀进程树、可执行解析/`.cmd` 包装、毫秒时钟、会话根注入；SPEC 草案的 `fs.read/write` 执行器用不上                             | `src/host/process.ts:54-84`、`src/host/executable.ts:98-133`、`docs/specs/SPEC-plugins.md:44-68`                                                                                                               |
| `timeout → failed` 归一与 `resume_rejected` 重试在 **host 适配器**，不在 dsh 里；插件直接实现 `ExecutorPort` 会丢这两段                | `src/host/executor.ts:72-102,138-163`                                                                                                                                                                          |
| 调度注入点唯一：`SchedulerExecutors.forRuntime(runtime)`；未知执行器只能落 catch → `executor_lost`                                     | `src/host/scheduler.ts:36-38,439-441,453-479`                                                                                                                                                                  |
| boot 装配顺序被 3 条断言钉死，改装配必须同提交改测试                                                                                   | `tests/host/boot.test.ts:348-350,366-379,401`                                                                                                                                                                  |
| `detect` 现状：宿主侧 10 条候选清单 + `SUPPORTED_COMMANDS={'dsh'}`，只 `statSync` 零副作用                                             | `src/main/ai-workflow/runtime/detect.ts:5-55`                                                                                                                                                                  |
| `runtimes` DDL 在投影指纹里；改列即首启全量重建，且重建 fold 的是历史 payload（只有 `protocolFamily`）                                 | `src/host/schema.ts:329`、`src/host/store/projection-apply.ts:111-152`                                                                                                                                         |
| 旧 `protocol_family` 列被 CHECK 引用，SQLite 不能 `DROP COLUMN` → 需照 `runs` 的 12-step 物理升级                                      | `src/host/db.ts:67-94`                                                                                                                                                                                         |
| E2E 不打真 CLI；M3 保绿条件是「能构建启动 + boot 不抛 + `runtime.create` 仍被接受 + UI 文案不动」                                      | `tests/e2e/ai-workflow.spec.ts:16-58`、`tests/e2e/helpers/seed-crash.ts:60-95`                                                                                                                                 |
| dsh 测试 59 例 / 1080 行，逐例清单与搬迁目标已测绘                                                                                     | `tests/main/ai-workflow/runtime/dsh.test.ts`；`tasks/recon/m3-dsh.md` §5                                                                                                                                       |

## 架构决议（M3 口径）

| #   | 缺口                                     | M3 口径                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `executorKey` 与 `protocolFamily` 的关系 | **方案 A：`executorKey` 取代 `protocolFamily`**。删 `PROTOCOL_FAMILIES`/`RuntimeProtocolFamily`；`Runtime.executorKey: string`、`RuntimeInput.executorKey?: string`。`runtimes` 表 12-step 升级为 `executor_key TEXT NOT NULL`（无 CHECK、无 DEFAULT）；老 payload/旧行由 `normalizeRuntime`（缺 `executorKey` → 按旧 `protocolFamily` 映射，目前只有 `dsh`）归一。不保留兼容字段。                                     |
| D2  | 内核里的产品默认值                       | 内核只校验形状（非空、`^[a-z][a-z0-9-]{0,63}$`），不校验归属、不写默认值。`command`/`profile`/`executorKey` 缺省由 **IPC 入口**按 registry 的 manifest 补齐后再 dispatch；绕过 IPC 写入的未知 key 由调度器兜底终态（D7）。内核零产品名。                                                                                                                                                                                |
| D3  | DB CHECK 是否保留                        | **去掉**。若 CHECK 取值来自插件清单，加一行插件就改 DDL → 全库重建，与「只改插件目录 + registry 一行」冲突。合法性在 IPC 入口校验；`host/executor-registry` 的未知 key 分支作最后防线。                                                                                                                                                                                                                                 |
| D4  | sdk 能力面                               | 最小面：`log` / `now`（毫秒）/ `paths.sessionRoot` / `config<T>` / `process.{spawn, resolve, killTree, scanDirs}`。**不给** `fs.read/write`、`net`、`emit`（执行器只能经 `io.emit`）。env：宿主构造完整基线交给 `process.spawn`，插件拿不到 `process.env` 本身；白名单收紧随外部插件（M7）另立任务并在 SPEC 标注。                                                                                                      |
| D5  | 插件契约与注册表                         | `ExecutorPlugin { probe?, models?, detect?, run(turn, io) }`，`ExecutorContext { runtime, sdk }`；`src/plugins/registry.ts` 导出 `executors: ReadonlyArray<{ key, label, manifest, create(sdk) }>`，**数组顺序即 UI 与 detect 顺序**，`key === manifest.id`。宿主只认 `protocol` 的端口类型，不 import 具体插件；`main` 是唯一 import `plugins/registry` 的装配根。                                                     |
| D6  | 归一与续接重试归属                       | 留宿主：`src/host/executor.ts` 从「`ExecutorBackend` 适配器」改为「`ExecutorPlugin` → `ExecutorPort` 包装」：`timeout → failed + errorCode='timeout'` 由插件内部完成；包装层保留 `resume_rejected` 换新会话 + 完整历史重试一次、以及 chat 失败补「执行失败」文案。`ExecutorBackend` 接口删除。                                                                                                                          |
| D7  | 未知执行器归类                           | `SchedulerExecutors.forRuntime(runtime)` 返回 `ExecutorPort                                                                                                                                                                                                                                                                                                                                                             | null`；`scheduler.start`取不到端口时`settleFailed(run, 'runtime_missing', '执行器插件未注册: <key>')`。**不新增 errorCode**（10 个取值不变）。 |
| D8  | `detect` 归插件                          | 候选目录清单搬 `src/plugins/shared/cli-catalog.ts`（纯数据，仍是 10 条，顺序即输出顺序）；各插件 `detect()` 只报自己能接入的命中；`registry.detectAll()` 按 registry 顺序**串行**、单插件 2 s 超时与失败隔离、同 `command` 先到先得并 warn；`DetectedRuntime` 增 `executorKey`，**保留 `supported`**（语义改为「registry 里存在该执行器」），UI 三态与文案不动。`runtimes.detect` 走 registry，仍不写库、不发 changed。 |
| D9  | M2 兼容层去留                            | **M3 不删**。实库仍是 v2 格式，首启必须靠 `host/store/import.ts` 导入；删除条件（真实库首启一次、facts 非空、再删并复测）写入退出记录，作为 M3 之后的独立清理任务。                                                                                                                                                                                                                                                     |
| D10 | `Turn.cwd` 与 `runtime.workdir` 优先级   | 插件 spawn 与 execute 帧统一取 `ctx.runtime.workdir ?? (turn.cwd                                                                                                                                                                                                                                                                                                                                                        |                                                                                                                                                | undefined)`；`run.cwd` 的空串语义不变，补一条「workdir 为空时回落进程默认目录」的用例。 |
| D11 | UI 拿执行器清单的通道                    | 新增只读 IPC 方法 `runtimes.executors()`（返回 `[{ key, label, command, profile }]`，来自 registry）。三动词收敛留 M5，不新增视图 id；在 SPEC-host/SPEC-ai-workflow 的 IPC 契约登记。                                                                                                                                                                                                                                   |
| D12 | `command` 插件范围                       | M3b 实现：运行时配置增 `argsTemplate`（JSON 数组文本，≤20 项，占位符白名单 `{model}/{effort}/{cwd}/{context}/{prompt}`）；`{prompt}` 出现在模板内 → 独立 argv 元素，否则走 stdin；Windows `.cmd/.bat` 经固定包装（`cmd /c` + 单个脚本参数），**禁止 prompt 拼进命令行字符串**。`command` 不提供 `detect`（避免与 dsh 抢 `dsh` 命令）。列在 T2 预留，避免二次结构升级。                                                  |
| D13 | 插件边界如何守                           | 三层：ESLint 新段（`plugins` 禁 node/electron/host/main/renderer/shared，`sdk` 只允许 `protocol`，`host` 禁具体插件实现）；`tests/plugins/boundary.test.ts` 源码扫描（跨插件 import、capability 声明 ↔ 用法双向一致）；`createSdk` 运行期门控（未声明能力抛 `capability_not_declared`）。                                                                                                                               |
| D14 | 测试搬家与门禁                           | 先补 `tsconfig`/ESLint/vitest 接线，再搬测试；`floor-guard` 加 6 条 `RELOCATED_TESTS` 映射；源码删除与测试新增同一提交；dsh 59 例逐例等价（只换 import 与夹具，禁止改断言语义）。                                                                                                                                                                                                                                       |

## 目标结构

```
src/
├── sdk/
│   ├── types.ts            # Sdk / SdkHost / PluginManifest / Capability / ExecutorPlugin（纯类型，diffcov 只认 types.ts）
│   └── index.ts            # createSdk(host, manifest)：能力门控 + 缺省值
├── plugins/
│   ├── manifest.ts         # manifest 类型与校验（id/kind/version/capabilities）
│   ├── registry.ts         # 内置插件静态清单（唯一 import 具体插件处；executors 顺序即 UI/detect 顺序）
│   ├── shared/             # 仅纯函数：jsonl 切行、tail、argv 模板展开、cli-catalog
│   └── executors/
│       ├── dsh/{manifest.ts,index.ts,probe.ts,models.ts,run.ts}
│       └── command/{manifest.ts,index.ts}
├── host/
│   ├── sdk-host.ts         # 宿主能力原件（spawn/killTree/resolve/scanDirs/now/log/paths）
│   ├── executor.ts         # ExecutorPlugin → ExecutorPort 包装（归一 + resume 重试）
│   └── executor-registry.ts# 按 executorKey 取插件，构造 SchedulerExecutors
├── protocol/               # entities 去 protocolFamily；executor.ts 改为插件端口契约
├── kernel/                 # decide 只校验 executorKey 形状、run 行取 runtime.executorKey
└── main/                   # 装配根：唯一 import plugins/registry；ai-workflow/ 只剩 ipc.ts
```

依赖红线：`plugins → sdk + protocol`（`plugins/shared` 只纯函数）；`sdk → protocol`；`host → kernel + protocol + sdk + plugins/registry`（禁具体插件实现）；`main` 装配根可 import `plugins/registry`；`renderer` 不 import `sdk`/`plugins`。

## 任务拆分

**M3a 骨架与 dsh 插件（必须串行收口）**

| 编号 | 任务                                                                                                                                                                                                               | 依赖  | 规模 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ---- |
| T1   | 契约面：`Runtime.executorKey` 取代 `protocolFamily`；`protocol/executor.ts` 增插件契约（`ExecutorPlugin`/`ExecutorContext`）；`src/plugins/manifest.ts`；`src/sdk/types.ts`；shared re-export；`validate` 形状校验 | 无    | M    |
| T2   | 结构升级与归一：`runtimes` 12-step 升级（`executor_key`、`args_template`）+ `normalizeRuntime` + `projection-apply/views/import` 列映射 + `KERNEL_VERSION=m3.0.0`（**与 T1 同一提交**）                            | T1    | L    |
| T3   | 内核去产品化：`decide` 删运行期白名单与 `protocolFamilyOf`，`run.executorKey` 取运行时值；默认 `command/profile/executorKey` 下沉到 IPC（registry 补齐）                                                           | T1,T2 | M    |
| T4   | sdk 实现：`src/sdk/index.ts` 的 `createSdk` + `host/sdk-host.ts` + 能力门控测试                                                                                                                                    | T1    | M    |
| T5   | 注册表与门禁接线：`plugins/registry.ts`、ESLint 三段、`tsconfig` include、`floor-guard` 映射、`tests/plugins/{registry,boundary}.test.ts`                                                                          | T1,T4 | M    |
| T6   | dsh 插件搬迁：`plugins/shared/**` 纯函数 + `plugins/executors/dsh/**` + `timeout→failed` 归一；59 例测试搬家并逐例等价                                                                                             | T4,T5 | L    |
| T7   | 调度与 boot 接线：`host/executor.ts` 改为插件包装、`host/executor-registry.ts`、scheduler `forRuntime` 空值分支、`main/index.ts` 装配、删 `main/ai-workflow/runtime/**` 与 `executor-port.ts`、boot/ipc 测试同批改 | T3–T6 | L    |
| T8   | 假协议端到端验收：`tests/plugins/support/fake-plugin.ts` + `tests/plugins/acceptance.test.ts`（真 registry + 真 scheduler + 内存库）                                                                               | T7    | M    |

**M3b detect / UI / command（可与 M3a 尾段并行，T9 依赖 T7）**

| 编号 | 任务                                                                                                                                                                       | 依赖      | 规模 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| T9   | `detect` 归插件：`plugins/shared/cli-catalog.ts`、各插件 `detect`、`registry.detectAll`（顺序/去重/超时/隔离）、IPC 改走 registry、`DetectedRuntime` 形状、detect 测试搬家 | T5,T7     | M    |
| T10  | renderer：`runtimes.executors()` 通道、运行时表单「执行器」选择、角标改 `executorKey`、默认值来源改 manifest                                                               | T9        | M    |
| T11  | `command` 插件：`argsTemplate` 契约/校验/表单、模板展开、argv/stdin、`.cmd` 包装、prompt 不进 argv 的用例                                                                  | T2,T9,T10 | M    |

**M3c 收尾**

| 编号 | 任务                                                                                                                                  | 依赖   | 规模 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| T12  | 测试搬家收口与覆盖率：floor-guard 六条映射生效、搬迁清单全绿、新分支用例补足、`check:diffcov`                                         | T6–T11 | M    |
| T13  | 验收与退出记录：`pnpm check`/`pnpm e2e`、老库两份副本冒烟、真 CLI 跑阶段 + 聊天、SPEC 修订清单、CAPABILITY-MAP/refactor-plan 退出记录 | T12    | M    |

T1/T2 同一提交；T3 与 T4/T5 可并行（写作用域 `kernel` vs `sdk/plugins`）；T6 依赖 sdk 与 registry 落地；T7 是唯一删除旧执行链的提交，必须与 boot/ipc 断言、floor-guard 映射同批。

## 检查点

- **A（T1–T3）**：`pnpm typecheck && pnpm lint` 绿；`tests/protocol`、`tests/kernel`、`tests/host/{schema,store}` 全绿；v2 真库副本与 M2 库副本各启动一次：`runtimes.executor_key` 正确、`agents/runs/run_events` 行数与内容逐行一致、重建等价。
- **B（T4–T6）**：`tests/sdk`、`tests/plugins`、`tests/plugins/executors/dsh` 全绿；dsh 59 例与旧断言逐例等价（帧/终态/取消/探测/模型/续接）；`detect` 零副作用；ESLint 边界与 boundary 扫描绿。
- **C（T7–T9）**：boot 启动顺序断言同批更新后绿；调度器经注册表取端口；未知 key 落 `runtime_missing` 终态；`pnpm e2e` 6/6；`runtimes.detect` 走 registry。
- **D（T10–T13）**：renderer 组件测试绿；假协议验收用例绿（真 registry 端到端）；`pnpm check` exit 0；真 CLI 阶段 + 聊天各跑一轮；SPEC 与文档修订完成。

## 文件去向

| 现状                                              | 行数       | 去向                                                                                                                       |
| ------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `main/ai-workflow/runtime/dsh.ts`                 | 894        | `plugins/executors/dsh/**`（协议专属）+ `plugins/shared/**`（JSONL/argv/tail 纯函数）                                      |
| `main/ai-workflow/runtime/{registry,detect}.ts`   | 47+55      | 删除；`plugins/registry.ts` + 各插件 `detect()` + `plugins/shared/cli-catalog.ts`                                          |
| `main/ai-workflow/executor-port.ts`               | 95         | 删除；`host/executor-registry.ts`（按 key 找插件）+ `host/executor.ts`（包装）                                             |
| `host/executor.ts` 的 `ExecutorBackend`           | 165        | 保留包装职责，删 `ExecutorBackend`/`ExecutorBackendOutcome`，改为包装 `ExecutorPlugin`                                     |
| `main/ai-workflow/ipc.ts` 的 `backendFor`         | 330        | 改按 `executorKey` 取端口；`runtimes.create` 默认值来自 manifest；`runtimes.detect` 走 registry；新增 `runtimes.executors` |
| `host/process.ts`、`host/executable.ts`           | 117+133    | 原位保留（宿主能力），由 `host/sdk-host.ts` 组装后经 sdk 暴露                                                              |
| `protocol/entities.ts` 的 `PROTOCOL_FAMILIES`     | —          | 删除；`RunRow.executorKey` 改由运行时配置来                                                                                |
| `renderer/.../{RuntimeManager,RuntimeDialog}.tsx` | —          | 角标/表单/默认值改 `executorKey`；三态 detect UI 不动                                                                      |
| `tests/main/ai-workflow/runtime/*.test.ts`        | 约 1.4k 行 | 按 m3-todo T12 的映射表搬家；`process/executable` 测试归 `tests/host/`                                                     |

## 必须保住的行为（M3 相关，逐条验收）

1. 取消时序：`cancel` 帧 → 3 s → SIGTERM → 2 s → SIGKILL；Windows `taskkill /T /F`；30 分钟超时同流程。
2. 探测：`ready` 需 `v=1` / `protocol_version=1` / `runtime=dsh`；`create` 先探测失败不落库；`update` 保存后重探；`detect` 只读、零副作用、不写库。
3. 聊天：续接只发新消息；`resume_rejected` 用完整历史重试一次；同一对话只跑一轮；失败轮次补「执行失败」文案。
4. 终态归一表与 10 个 `errorCode` 语义不变；`timeout` 折成 `failed` + `errorCode='timeout'`。
5. `run_events` 的 `seq` 按 run 全局单调、`output` = text 汇总、重建后仍在；插件只经 `io.emit`，不能自己写 seq。
6. 子进程 pid 立即上报（崩溃对账用），stderr 截尾 4000 进诊断。
7. 提示词不进命令行拼接：`{prompt}` 只能是独立 argv 元素或 stdin。
8. 同运行时 `maxConcurrent` 限流、全局 FIFO、多运行时并行；「执行中」仍由内核算。
9. 派活始终经智能体：运行时的 `executorKey` 只决定「怎么调起」，不决定「派给谁」。
10. 依赖边界：renderer 禁 electron/Node；main 禁 renderer；host 禁具体插件实现；kernel 禁 IO/时钟/随机。
11. 质量门禁不放松：覆盖率阈值、`stage-machine` 分支 100%、改动行 ≥90%。

## 验收（退出条件）

- `pnpm check` exit 0；覆盖率不低于基线（99.74/97.79/100/≈100）；改动行 ≥ 90%。
- `pnpm e2e` 6/6；`tests/e2e-packaged` 打包冒烟结论沿用 M2 已知问题记录（工具链未恢复则单独标注）。
- 老库两份副本（v2 真库副本 + M2 库副本）各启动一次：导入/升级后 `runtimes` 行数与 `lastProbe` 不丢、`runs`/`run_events`/聊天数据逐行一致、重建等价。
- 假协议验收：只改 `src/plugins/**` + registry 一行，`acceptance.test.ts` 用真 registry 端到端跑通；`git diff` 证明 kernel/host 未因新增协议改动。
- 真 CLI（dsh）跑一轮阶段执行 + 一轮聊天；取消一条执行中 run 验证终止时序。
- `pnpm check:floor` 通过（含 M3 文档）。
- SPEC 修订完成（清单见 `tasks/recon/m3-runtime-config.md` §6）：`SPEC-kernel`（类型契约、事实归一、重建规则）、`SPEC-plugins`（registry 形状、executor/detect/sdk 面、测试）、`SPEC-host`（启动序列、未知执行器、IPC 登记）、`SPEC-ai-workflow`（数据模型、迁移、运行时模型、检测、IPC、边界）；`CAPABILITY-MAP` 状态行与 `refactor-plan` 退出记录同步。

## 风险与对策

| 风险                                                        | 影响 | 对策                                                                                         |
| ----------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------- |
| 实库仍是 v2 格式，首启同时经历「导入 + 12-step + 指纹重建」 | 高   | 先在副本上演练两遍；正式库只在验收时开一次；回滚靠开工备份                                   |
| `normalizeRuntime` 缺失或晚于指纹变化                       | 高   | T1/T2 同一提交；老 payload 缺 `executorKey` 的用例先进 `tests/host/store/rebuild.test.ts`    |
| 约 28 个测试文件被契约改名波及                              | 中   | 只改夹具字段名，不改断言语义；`floor-guard` 的断言净减少规则兜底                             |
| dsh 59 例搬家后被削弱                                       | 高   | 逐例对照 `tasks/recon/m3-dsh.md` §5.1；只允许换 import 与 sdk 夹具；6 类失效断言先给等价替代 |
| 插件偷偷 import host/node                                   | 高   | ESLint 三段 + boundary 扫描 + `createSdk` 门控；评审 diff 对照边界守则                       |
| sdk 能力面过大（fs/net）或过小（缺 killTree）               | 中   | 最小面（D4），杀树/解析必须进；其它能力随 M4/M6 另开                                         |
| env 白名单未收紧                                            | 中   | 记录为 M7 外部插件前置条件；M3 只保证「插件拿不到 process.env 本身」                         |
| `command` 插件范围扩散                                      | 中   | 归 M3b，可整体后置；列在 T2 预留，不再触发二次结构升级                                       |
| 兼容层误删导致 v2 用户历史丢失                              | 高   | D9：M3 不删，退出记录写明删除条件与顺序                                                      |
| 覆盖率弱势区（scheduler 分支 87.97%、dsh 分支 94.67%）      | 中   | T7/T12 补未知执行器、空注册表、detect 失败隔离等分支用例                                     |
| 新增 RPC 方法破坏 M5 收敛                                   | 低   | 只在现有单通道加只读方法，登记 SPEC；三动词统一仍留 M5                                       |

## 开放问题（需拍板）

1. **D1 方案 A 确认**：接受「`executorKey` 取代 `protocolFamily`」并做一次 `runtimes` 12-step 升级 + 首启重建？（推荐；否则只能选 B 的双字段，与「禁止两套真相源」冲突。）
2. **D8 `supported` 语义**：保留字段、语义改为「registry 里存在该执行器」，UI 三态不动（推荐）；还是删字段、UI 改两态（省代码但行为回退）。
3. **D12 `command` 插件**：接受 M3b 纳入 `argsTemplate`（运行时新增一个配置字段 + 表单输入），还是整体后置到 M4？
4. **D9 兼容层**：确认 M3 不删（实库仍 v2，首启必需），删除作为 M3 之后独立任务。
5. **D11 新 RPC**：接受新增只读 `runtimes.executors()`（在 SPEC 登记），还是把执行器清单塞进 `runtimes.detect` 返回（形状破坏更大）。
