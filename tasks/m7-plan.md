# 实施计划：M7 可选能力（外部插件 / webhook / 跨工作流交接 / 远端 Worker 架构位）

> 依据 [refactor-plan](../docs/planning/refactor-plan.md) M7 行、[SPEC-plugins](../docs/specs/SPEC-plugins.md)「外部插件」「source」「channel」「SDK 与能力」、[SPEC-host](../docs/specs/SPEC-host.md)「插件装载」「启动顺序」、[SPEC-kernel](../docs/specs/SPEC-kernel.md)「事实目录」「调度」、[调研](../docs/planning/ai-workflow-research.md)。
> 起点：`master` @ `1796a5b`（M6.5 退出；工作树干净）。工作分支 `refactor/m7-ext`。
> 目标：① 外部插件（用户目录发现 + 独立子进程 + 能力授权 + 环境白名单）；② 插件设置/授权页与 secret 存储；③ webhook 来源（仅 `127.0.0.1` + HMAC）与 webhook 通道（出站）；④ 跨工作流交接（阶段完成在目标工作流建关联任务）；⑤ 远端 Worker 执行器架构位（协议形状 + 传输端口 + 假传输测试，不监听网络）。
> 本阶段不做：外部 `executor` 插件（需要 probe/models/领取往返，协议面另立）；插件安装向导（外部插件 = 手工放入用户目录后被扫描）；远端 Worker 真实网络传输（不监听端口、不建 daemon）；交接任务完成后回写来源任务；子工作流/环检测以外的编排语义；M6 已知边界（回执块重写等）不变。

## 开工前提（2026-11-05）

- 分支 `refactor/m7-ext` @ `1796a5b`；工作树干净；`master` 与分支初始状态 `pnpm check` exit 0。
- 门禁基线：`pnpm check` exit 0；**115 文件 / 1550 用例**；覆盖率 **99.91 / 98.34 / 100 / 100**；`check:diffcov` 在当前分支无改动行（跳过）；`pnpm e2e` 10/10（M6.5 退出记录）。
- `floor-guard` 默认 base 是 `master`，必须在分支上工作；扫描未跟踪文件全文，本计划与任务清单不得出现关闭检查器 / 未完成标记 / 放松测试的写法。

## 测绘结论（2026-11-05）

| 事实                                                                                               | 证据                                                                                            |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 插件只有内置静态注册表；用户目录扫描、外部插件子进程、能力授权存储全部不存在                       | `src/plugins/registry.ts`、`grep -r "userData/plugins" src` 为空                                |
| `createSdk` 只门控 `spawn` / `notify`；没有 `net`；`SdkHost` 没有网络与 per-plugin 配置            | `src/sdk/index.ts:25-54`、`src/sdk/types.ts:70-104`、`src/host/sdk-host.ts:48-66`               |
| 通道 hub 与执行器注册表按静态清单启动；没有 source 类 hub，`SourcePlugin` 只存在于 SPEC            | `src/host/channels.ts:83-287`、`src/host/executor-registry.ts`、SPEC-plugins:148-171            |
| 插件设置/secret 没有表、事实、命令、视图；`rule_sets` 的单行整批替换是可照抄的先例                 | `src/host/schema.ts:236-242`、`src/kernel/decide.ts:1269-1283`、`src/kernel/types.ts:57-71`     |
| 阶段只有 8 列（无交接目标）；`tasks.origin` 的 CHECK 只有 `manual`/`rule`，扩展需物理重建          | `src/protocol/entities.ts:196-217`、`src/host/schema.ts:91,454`、`src/host/db.ts:175-183`       |
| 任务流转无统一出口：成功流转、拖拽、直接完成、打回分居四处；`workflow.update` 的删阶段重挂不是流转 | `src/kernel/decide.ts:372-402,846-892,973-1077,761-776`、`src/kernel/workflow/stage-machine.ts` |
| 任务建卡可照抄 `implicitThreadTaskFacts`（隐式线程 + 任务 + 入口 run）                             | `src/kernel/rules.ts:146-178`、`src/kernel/threads.ts:49-70,100-108,225-241`                    |
| 远端 Worker 只有 SPEC 措辞（`run.claim` 形状可复用），无契约/端口/插件                             | SPEC-kernel:182、`src/protocol/executor.ts`、`src/host/executor.ts:54-95`                       |
| 宿主 HTTP 能力不存在；ESLint 只允许 renderer 之外的分层按规则 import node                          | `grep -r "node:http" src` 为空、`eslint.config.mjs`                                             |
| 新增投影表要同批改 `PROJECTION_TABLES` / DDL / 指纹 / writer / 装载 / 导入                         | `src/kernel/types.ts:57-71`、`src/host/schema.ts:502-547`、`src/host/store/projection-apply.ts` |
| 阶段编辑器 `toDraft` 不回传 `stage.id`，每次保存会重建阶段 id —— 交接引用目标阶段前必须先修        | `WorkflowEditor.tsx:25-48`、`decide.ts:728-736`                                                 |
| e2e 有「种子库 + 起 app + 发命令 + 直读库」范式                                                    | `tests/e2e/rules.spec.ts:29-117`、`tests/e2e/helpers/seed-rules.ts:37-70`                       |

## 架构决议（M7 口径）

| #   | 缺口              | M7 口径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 外部插件发现      | 目录 `userData/plugins/<kind>/<id>/`（`manifest.json` + `plugin.mjs`）。启动扫描，`protocol/plugin-host.ts` 的纯函数校验 manifest（id slug、kind、version、capabilities 子集、入口文件存在）。**M7 只开放 `source` 与 `channel` 两类**外部插件；`executor` 外部插件需要 probe/models/领取往返，manifest 合法但装载时以 `kind_unsupported` 拒绝并显示原因。用户目录与内置同名（kind+id）时用户优先；非法 manifest 不静默降级：不装载、记日志、视图 `plugins.all` 的 `status='manifest_error'` 带原因。内置清单仍由 `plugins/registry.ts` 唯一静态导入。                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D2  | 外部插件运行      | 独立子进程：`process.execPath` + `ELECTRON_RUN_AS_NODE=1`，参数 `[plugin.mjs]`，cwd = 插件目录；stdio JSONL 帧 v1（`PLUGIN_HOST_PROTOCOL_VERSION=1`）。host→plugin：`welcome{pluginId,granted,config}` / `card` / `shutdown`；plugin→host：`hello{id,kind,version,capabilities}` / `log{line}` / `event{event}` / `delivered{cardId,version,ref}` / `answer{cardId,optionIndex}`。hello 超时 5 s、单帧 ≤64 KiB、非 0 退出或崩溃最多重拉 3 次（1 s 间隔）后 `status='error'`；`stopAll` 先 `shutdown` → SIGTERM → killTree。**环境白名单**：只给 `PATH` / `SystemRoot` / `SystemDrive` / `COMSPEC` / `PATHEXT` / `TEMP` / `TMP` / `USERPROFILE` / `APPDATA` / `LOCALAPPDATA` / `HOME` / `SHELL` / `LANG` / `LC_*` / `ELECTRON_RUN_AS_NODE`，其余 `process.env` 一律不继承；secret 只经 `welcome` 帧下发，不进命令行与日志。                                                                                                                                                    |
| D3  | 能力授权          | 外部插件默认未授权：manifest 声明的能力须**全部**被用户授权且 `enabled=true` 才启动，缺一即 `status='unauthorized'`（插件不启动）。内置插件可信：默认 `enabled=true`、`granted=declared`，不受授权门限制。授权是**信任门不是 OS 沙箱**（子进程仍受操作系统权限约束，SPEC 写明），宿主只按授权决定「启不启动 / 下发哪些 config 与 secret」。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D4  | 插件设置事实      | 第 14 张投影表 `plugin_settings` 单行 `id='current'`：`version` / `replaced_at` / `settings_json`（`PluginSetting[]` = `{id,kind,enabled,granted,config}`）。事实 `plugins.replaced`（整行 payload，版本 +1，照 `rules.replaced`）；命令 `plugins.replace{settings}`（内核整批校验：id 唯一且 slug、kind 在枚举内、granted ⊆ `CAPABILITIES`、config 只收字符串/数字/布尔且条数与长度有上限）。`KERNEL_VERSION=m7.0.0` 触发全量重建。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D5  | 命令与 secret     | UI 只发 `plugin.set{pluginId,enabled?,granted?,config?,secrets?}`：宿主命令路由读 DB 视图 `plugins.settings` 合并后转 `plugins.replace`（沿用原 `commandId`），`secrets` 写**非投影表** `plugin_secrets`（`plugin_id,key,value_cipher,updated_at`，`safeStorage` 经 `SecretCipher` 注入；不可用时 reject `unsupported`）。secret 不进事实、不进视图（视图只回 `secretKeys`），不进快照与日志。命名受 `tests/protocol` 正则约束：命令与视图 id 不能带下划线（`plugins.replace` / `plugin.set` / `plugins.settings` / `plugins.all`）。                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D6  | 插件视图与页      | 宿主视图 `plugins.all`（`HOST_VIEW_IDS`）：合并磁盘目录（内置注册表 + 用户目录）与设置行，返回 `PluginView[]`（`id/kind/name/version/description/builtin/enabled/declared/granted/config/configFields/secretKeys/status/error`）；status ∈ `ready`/`disabled`/`unauthorized`/`error`/`manifest_error`。设置页第五栏「插件」：列表 + 启停 + 逐项授权 + config 表单（secret 只写）+ 错误展示。UI 只读视图、只发 `plugin.set`，不自己推断装载规则。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D7  | SDK net 能力      | `Sdk` 增 `net`（`fetch` / `listen`），manifest 声明 `capabilities:['net']` 才可用（`createSdk` 门控）。宿主原件 `host/net.ts`：`fetch` 支持 http/https、超时 10 s、响应体 ≤1 MiB、只回 `{status,headers,body}`；`listen` **只绑 `127.0.0.1`**、端口 1–65535、请求体 ≤1 MiB、返回 `{port,close}`。测试注入假 `net`，不打真端口。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D8  | source 契约与 hub | 新增 `protocol/sources.ts`：`SOURCE_PORT_VERSION=1`、`SourcePlugin{start(ctx)}`、`SourceContext{sdk,signal,emit(event)}`、`RawEvent` 复用 M6 形状。新增 `host/sources.ts` hub：按清单启动启用的 source（内置 + 外部），`emit` → `effects.dispatch({type:'event.received',event,hops:1})`（**唯一事件入口不变**）；单来源启动失败只隔离该来源，`stopAll` abort + dispose；退出流程调用。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D9  | webhook 来源      | 内置 `plugins/sources/webhook`（id `webhook`，capabilities `['net']`）：config `port`（默认 47615）/ `path`（默认 `/webhook`）/ `secret`（secret）/ `toleranceSeconds`（默认 300）。只接受 POST 且路径匹配；签名头 `x-webhook-signature: sha256=<hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))>` + `x-webhook-timestamp`（RFC3339 或 epoch 秒）在容差内；body JSON `{source?,type,subject,summary?,detail?,link?,dedupeKey?}`，`source` 缺省 `webhook`、必须是 slug，`type` 必须 kebab-case。**HMAC 计算留在宿主**：`NetCapability` 增 `verifyHmacSha256(secret,message,signatureHex)`（`node:crypto` 只在 `host/net.ts`）；插件只做时间窗与请求形状判定，失败返回 4xx 且不产事件。ESLint 禁止插件 import node 内置，因此验签不能放 `plugins/shared`。                                                                                                                                                                                                                  |
| D10 | webhook 通道      | 内置 `plugins/channels/webhook-channel`（id `webhook-channel`，capabilities `['net']`）：config `url` / `secret`（可选）/ `timeoutMs`（默认 5000）。订阅卡片后 POST JSON（只含 `id/title/text/options/key/version/taskId/conversationId`，正文字段只作参数），可选 `x-workbench-signature`；2xx → `delivered(cardId,version,'webhook-channel')`，非 2xx/超时抛错由 hub 隔离。**单向**：不回收答案（答案仍走 in-app/desktop），文档写明。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D11 | 跨工作流交接      | 阶段两列 `handoff_workflow_id` / `handoff_stage_id`（可空；stageId 空 = 目标工作流首阶段）；`StageInput` 加 `handoffWorkflowId?` / `handoffStageId?`，形状校验在 `protocol/validate`，语义校验用视图：目标工作流存在且 ≠ 自身、目标阶段属于目标工作流（`decide` 的 workflow.create/update）。任务两列 `handoff_from_task_id` / `handoff_from_stage_id`，`TASK_ORIGINS` 增 `'handoff'`（`tasks.origin` 的 CHECK 扩展 → 旧库**一次性物理重建** `tasks`，照 M2 `runs` / M3 `runtimes` 的临时表法，全程 `PRAGMA foreign_keys=OFF`）。触发点三处：成功流转（`stageTransitionFacts` 前进/完成）、拖拽到更后阶段、直接完成；打回与删阶段重挂不触发。去重：扫 `view.tasks` 中 `(handoffFromTaskId, handoffFromStageId)` 已存在即跳过；链深上限 8（沿 `handoffFromTaskId` 回溯），超限零事实。产物 = 目标工作流一条 `task.created`（`origin='handoff'`）+ 新隐式线程（`source='handoff'`、`parentTaskId=null`）+ 入口 run（目标阶段是 agent 时）。不做「交接任务完成后回写来源任务」。 |
| D12 | 远端 Worker       | 新增 `protocol/worker.ts`（`WORKER_PROTOCOL_VERSION=1`、`WorkerFrame` = `hello`/`claim`/`heartbeat`/`event`/`receipt`/`cancel`、`WorkerClaim`、`WorkerDescriptor`）；`host/worker-transport.ts` 定义 `RemoteTransport{execute(turn,io,signal),cancel(runId)}` 与进程内 `createMemoryRemoteTransport()`（测试用，**不监听网络**）。`plugins/executors/remote`（id `remote`）：`createRemoteExecutor(transport                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | null)`；无传输时回执 `failed{errorCode:'runtime_missing'}`（文案「远端 Worker 传输未配置」），有传输时把事件/回执原样转发并遵守 `signal`。注册表以 `null`传输注入。**边界**：不开放监听端口、不实现 daemon、UI 不能建该运行时（无 probe，与`command` 插件同口径）。 |
| D13 | 装配与门禁        | `main` 装配顺序：插件目录扫描 → 设置/secret 存储 → sdkHost（含 net）→ 执行器/通道/来源清单（内置 + 外部）→ channels.startAll → sources.startAll → clock/scheduler；退出先停 sources 再停 channels。清单断言（COMMAND_NAMES / VIEW_IDS / HOST_VIEW_IDS / PROJECTION_TABLES / SCHEMA 表数 / KERNEL_VERSION）同批更新；SPEC-plugins / SPEC-host / SPEC-kernel / CAPABILITY-MAP / TEST-CASES / refactor-plan 同步；`pnpm check` / `check:diffcov` / `pnpm e2e` 全绿，覆盖率不低于基线。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 目标结构

```
src/
├── protocol/
│   ├── plugin-host.ts     # 外部插件 manifest 校验 + 宿主帧 + 上限（新）
│   ├── plugins.ts         # PluginSetting / PluginSettingsRow / PluginView（新）
│   ├── sources.ts         # SourcePlugin / SourceContext / RawEvent 端口（新）
│   ├── worker.ts          # Worker 协议形状（新）
│   ├── entities.ts        # WorkflowStage/StageInput + 交接两列；Task + 交接两列、origin='handoff'
│   ├── facts.ts           # + plugins.replaced
│   ├── commands.ts        # + plugins.replace / plugin.set
│   ├── views.ts           # + plugins.settings（DB）、plugins.all（宿主）
│   └── validate.ts        # 新命令 / 视图 / 阶段交接 / 插件设置校验
├── kernel/
│   ├── plugins.ts         # 插件设置整批替换与校验（新）
│   ├── handoff.ts         # 交接判定 + 建任务事实（新）
│   ├── decide.ts          # plugins.replace / plugin.set / 交接钩子
│   ├── project.ts         # plugin_settings 投影
│   ├── types.ts           # View.pluginSettings / 第 14 张表 / KERNEL_VERSION
│   └── view-spec.ts       # 新输入切片
├── sdk/
│   ├── types.ts           # net 能力、SdkHost.net
│   └── index.ts           # net 门控
├── host/
│   ├── net.ts             # fetch / listen 原件（新）
│   ├── plugins/
│   │   ├── discover.ts    # 用户目录扫描 + manifest 校验（新）
│   │   ├── catalog.ts     # 内置 + 外部合并、状态计算（新）
│   │   ├── env.ts         # 子进程环境白名单（新）
│   │   ├── process.ts     # 子进程 + JSONL 帧（新）
│   │   └── settings.ts    # 设置/授权读取、secret 存储（新）
│   ├── sources.ts         # source hub（新）
│   ├── channels.ts        # 通道清单可注入 configOf / 启用门
│   ├── commands.ts        # plugin.set 编排
│   ├── schema.ts          # plugin_settings / plugin_secrets / 阶段列 / 任务列 + tasks 重建 DDL
│   ├── db.ts              # tasks 物理重建 + stages 补列
│   ├── store/*            # 投影 writer / 装载 / 导入
│   └── worker-transport.ts # RemoteTransport + memory（新）
├── plugins/
│   ├── sources/webhook/   # 内置 webhook 来源（新）
│   ├── channels/webhook-channel/ # 内置 webhook 通道（新）
│   ├── executors/remote/  # 远端 Worker 执行器架构位（新）
│   └── registry.ts        # + sources / webhook 通道 / remote 执行器
├── main/index.ts          # 装配：插件目录、设置/secret、sources、net、plugins.all
└── renderer/src/apps/ai-workflow/
    ├── components/PluginsManager.tsx   # 设置页「插件」栏（新）
    ├── components/WorkflowEditor.tsx   # 阶段交接选择 + stage.id 回传
    ├── components/TaskCard.tsx         # 交接徽标
    └── shell/kernelStore.ts            # 失效表
```

## 任务拆分（写作用域）

| 任务 | 内容                                                                                                                                              | 写作用域                                                                                                                                                                                       | 依赖   | 负责        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- |
| T1   | 契约与清单：plugin-host / plugins / sources / worker、entities/facts/commands/views/validate、kernel types/view-spec、KERNEL_VERSION=m7.0.0       | `src/protocol/**`、`src/kernel/{types,view-spec}.ts`、`tests/protocol/**`                                                                                                                      | —      | lead        |
| T2   | 账本、投影与宿主存储：plugin_settings / plugin_secrets / 阶段列 / 任务列（tasks 物理重建）/ views / import / 命令路由与 plugins.all 宿主视图骨架  | `src/host/{schema,db,commands}.ts`、`src/host/store/**`、`src/host/sdk-host.ts`、`tests/host/{schema,db}/**`、`tests/host/store/**`、`tests/host/commands.test.ts`                             | T1     | lead        |
| T3   | 插件运行时：外部插件发现 / 合并清单 / 环境白名单 / 子进程帧 / 设置与 secret 存储；sdk `net` 与 `host/net.ts`                                      | `src/host/plugins/**`、`src/host/net.ts`、`src/sdk/**`、`tests/host/plugins/**`、`tests/sdk/**`、`tests/plugins/boundary.test.ts`                                                              | T1、T2 | plugin-dev  |
| T4   | webhook：source 契约落地 / source hub / webhook 来源 / webhook 通道 / HMAC 纯函数 / registry 两行                                                 | `src/plugins/sources/**`、`src/plugins/channels/webhook-channel/**`、`src/plugins/shared/webhook-signature.ts`、`src/host/sources.ts`、`tests/plugins/sources/**`、`tests/plugins/channels/**` | T1、T3 | webhook-dev |
| T5   | 跨工作流交接：阶段语义校验 / 任务流转三处钩子 / 交接建任务 / 去重与链深 / phase 校验 / stage-machine 纯函数                                       | `src/kernel/handoff.ts`、`src/kernel/decide.ts`、`src/kernel/workflow/stage-machine.ts`、`tests/kernel/**`                                                                                     | T1、T2 | handoff-dev |
| T6   | 远端 Worker 架构位：协议形状 / 传输端口与内存实现 / remote 执行器插件 / registry 一行                                                             | `src/protocol/worker.ts`、`src/host/worker-transport.ts`、`src/plugins/executors/remote/**`、`tests/host/worker-transport.test.ts`、`tests/plugins/executors/remote.test.ts`                   | T1     | worker-dev  |
| T7   | renderer：设置页「插件」栏（列表 / 启停 / 授权 / config / secret / 错误）、阶段编辑器交接选择 + `stage.id` 回传、任务卡交接徽标、kernelStore 失效 | `src/renderer/src/apps/ai-workflow/**`、`src/renderer/src/shell/kernelStore.ts`、`tests/renderer/**`                                                                                           | T1、T2 | ui-dev      |
| T8   | 装配、e2e 与门禁：main 装配/退出、plugins.all 完成、webhook e2e、交接 e2e、覆盖率 / diffcov / e2e 全绿                                            | `src/main/**`、`tests/e2e/**`                                                                                                                                                                  | T3–T7  | lead        |
| T9   | 文档：SPEC-plugins / SPEC-host / SPEC-kernel / CAPABILITY-MAP / TEST-CASES / refactor-plan 开工与退出记录                                         | `docs/**`                                                                                                                                                                                      | T8     | lead        |

## 验收口径

- 外部插件：用户目录放一个合法 source 插件 → 出现在 `plugins.all`（`status='unauthorized'`）→ 授权并启用后子进程启动、发 `event` 帧后规则建任务；manifest 非法时 `status='manifest_error'` 且不启动；未授权启动数为 0；子进程环境不含 `process.env` 的其他键与任何 secret 明文。
- 插件设置：`plugin.set` 改启停/授权/config 产一条 `plugins.replaced` 且版本 +1；非法整批 reject 且旧版继续生效；secret 写入后视图只回 `secretKeys`、事实与快照里查不到明文；重建后 `plugin_settings` 与增量写入全等、`plugin_secrets` 不被清空。
- webhook 来源：带合法签名与时戳的 POST 产一条 `event.received`（`source` 缺省 `webhook`）并命中规则建任务；签名错误 / 时戳超窗 / 方法或路径不符 → 4xx 且零事实；只监听 `127.0.0.1`（非回环地址连不上）。
- webhook 通道：有 `url` 配置时收到卡片即 POST 且 2xx 后记 `card.delivered{ref:'webhook-channel'}`；非 2xx / 超时不影响其它通道与内核；未配置时通道不投递。
- 交接：配置 `A.stage1 → B` 后任务在 A 完成 stage1 → B 出现一条 `origin='handoff'` 任务（`handoffFromTaskId/handoffFromStageId` 正确、`threadId` 为新线程、目标阶段为 agent 时有 queued run）；同一 `(任务, 阶段)` 重复完成不重复建；打回不触发；链深 > 8 不建；自指 / 目标阶段不属于目标工作流在保存时 reject。
- 远端 Worker：有假传输时 `remote` 执行器透传事件与回执并遵守 abort；无传输时回执 `failed{runtime_missing}` 且不 spawn；`WORKER_PROTOCOL_VERSION` 与帧类型契约测试全绿；进程不监听任何端口。
- 门禁：`pnpm check` exit 0；覆盖率不低于 99.91 / 98.34 / 100 / 100；`check:diffcov` ≥90%（目标 100%）；`pnpm e2e` 全绿；无关闭检查器 / 跳过测试。

## 风险

| 风险                                     | 对策                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `tasks.origin` CHECK 扩展需重建表        | 照 M2 `runs` / M3 `runtimes` 的临时表法：`PRAGMA foreign_keys=OFF` + 事务内建表/拷贝/改名，失败整体回滚；真库迁移用例兜底 |
| 子进程不可测（无宿主环境）               | 帧层与进程层分离：帧编解码与状态机纯函数化，测试注入假 spawn / 假流；真 `process.execPath` 只在装配根出现                 |
| webhook 监听端口与「纯本地」张力         | 默认关闭、仅 `127.0.0.1`、必须显式配置端口与 secret；SPEC 写明「回环监听」边界与关闭方式                                  |
| 外部插件能力授权被误当沙箱               | SPEC 与 UI 文案写明「信任门不是 OS 沙箱」；环境白名单与 secret 不回显作为可验证的收口                                     |
| 交接触发点分散（成功流转/拖拽/直接完成） | 交接判定收敛为 `kernel/handoff.ts` 一个纯函数，三处只做「旧阶段 → 新状态」调用；打回与删阶段重挂显式排除                  |
| 多个并行写作用域交叉 `decide.ts`         | `decide.ts` 的插件设置分支由 lead 先落，交接钩子由 handoff-dev 在 T2 合入后改；两段写作用域不同批次                       |
| 新增事实/表后清单断言与指纹漏改          | T1/T2 同批改 `PROJECTION_TABLES` / `COMMAND_NAMES` / `VIEW_IDS` / SCHEMA 表数 / KERNEL_VERSION；`pnpm check` 首轮即暴露   |
