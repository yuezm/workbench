# 任务清单：M7 可选能力（外部插件 / webhook / 跨工作流交接 / 远端 Worker 架构位）

> 计划见 [m7-plan.md](./m7-plan.md)。状态：`[ ]` 未做 / `[x]` 完成。写作用域见计划「任务拆分」；同一文件同一时刻只允许一个 owner 改。

## T1 契约与清单（lead）

- [ ] `src/protocol/plugin-host.ts`：外部插件 manifest 校验（`parseExternalManifest`）、宿主帧类型与上限（`PLUGIN_HOST_PROTOCOL_VERSION`）
- [ ] `src/protocol/plugins.ts`：`PluginSetting` / `PluginSettingsRow` / `PluginView` / 上限
- [ ] `src/protocol/sources.ts`：`SOURCE_PORT_VERSION` / `SourcePlugin` / `SourceContext` / `RawEvent` 再出口
- [ ] `src/protocol/worker.ts`：`WORKER_PROTOCOL_VERSION` / `WorkerFrame` / `WorkerClaim` / `WorkerDescriptor` / `RemoteTransport`
- [ ] `entities.ts`：`WorkflowStage` + 交接两列、`StageInput` + 两个可选字段；`Task` + 交接两列、`TASK_ORIGINS` + `handoff`
- [ ] `facts.ts`：`plugins.replaced` 与 payload；`commands.ts`：`plugins.replace` / `plugin.set`；`views.ts`：`plugins.settings`（DB）、`plugins.all`（宿主）；`ipc.ts`：`CommandResults`
- [ ] `validate.ts`：新命令 / 新视图 / 阶段交接字段 / 插件设置形状；命令与视图命名满足现成正则（无下划线）
- [ ] `kernel/types.ts`：`pluginSettings` 切片、`PROJECTION_TABLES` + `plugin_settings`、`ProjectionRow`、`KERNEL_VERSION=m7.0.0`
- [ ] `kernel/view-spec.ts`：新命令切片
- [ ] `kernel/timeline.ts`：新事实归 `[]`

## T2 账本、投影与宿主存储（lead）

- [ ] `host/schema.ts`：`plugin_settings` DDL + `plugin_secrets` 宿主私有 DDL、阶段交接两列、任务交接两列 + `origin` CHECK 扩展、`tableDdl` / `PROJECTION_TABLES` / `projectionTableDdl`
- [ ] `host/db.ts`：`stages` 补列、`tasks` 物理重建（临时表法，`PRAGMA foreign_keys=OFF`）、`plugin_secrets` 建表
- [ ] `host/store/projection-apply.ts`：`plugin_settings` upsert / 删除 / clear / writes；任务与阶段新列
- [ ] `host/store/views.ts`：`plugin_settings` 装载、`plugins.settings` 视图、阶段与任务新列映射
- [ ] `host/store/import.ts`：`emptyCounts` + 任务新列默认值
- [ ] `host/commands.ts`：`plugin.set` 编排（合并 → `plugins.replace` → secret 写入）、`valueOf`、`plugins.all` 宿主视图分流
- [ ] `kernel/plugins.ts` + `kernel/decide.ts`：`plugins.replace` 整批校验与版本 +1、`plugin.set` 直连拒绝
- [ ] `host/sdk-host.ts`：`SecretCipher` / `net` 注入位（与 T3 对齐）
- [ ] 单测：schema / db / projection-apply / views / import / commands / decide / project

## T3 插件运行时与 sdk（plugin-dev）

- [ ] `src/sdk/types.ts` / `index.ts`：`NetCapability`（fetch / listen / verifyHmacSha256）、`Sdk.net` 门控、`SdkHost.net`
- [ ] `src/host/net.ts`：http/https fetch、127.0.0.1 listen、HMAC 校验（node:crypto 只在这里）
- [ ] `src/host/plugins/discover.ts`：用户目录扫描 + manifest 校验 + 内置合并（用户优先）
- [ ] `src/host/plugins/env.ts`：子进程环境白名单
- [ ] `src/host/plugins/process.ts`：子进程 + JSONL 帧 + hello 超时 + 重启上限 + 优雅停止
- [ ] `src/host/plugins/settings.ts`：设置读取、授权判定、secret 存储（加密与解密接口）
- [ ] `tests/sdk/**`、`tests/host/plugins/**`、`tests/plugins/boundary.test.ts`（net 能力扫描规则）、`tests/plugins/registry.test.ts`（sources 目录）

## T4 webhook（webhook-dev）

- [ ] `src/plugins/sources/webhook/`：manifest + `start`（`sdk.net.listen`、POST/路径校验、时戳窗口、签验、JSON → `emit`）
- [ ] `src/plugins/channels/webhook-channel/`：manifest + `start`（onCard → POST → delivered）
- [ ] `src/host/sources.ts`：source hub（启停 / 失败隔离 / `event.received` 入口）
- [ ] `src/plugins/registry.ts`：`sources` 清单 + webhook 通道一行
- [ ] 单测：source hub / webhook 来源（合法签名、坏签名、超窗、方法/路径错、body 非法）/ webhook 通道（2xx、非 2xx、超时、未配置）

## T5 跨工作流交接（handoff-dev）

- [ ] `src/kernel/handoff.ts`：触发判定（成功流转 / 前进拖拽 / 直接完成）、目标解析、去重、链深上限、建任务事实
- [ ] `src/kernel/decide.ts`：workflow.create/update 阶段交接语义校验；task.move / task.complete / stageTransitionFacts 三处钩子
- [ ] `src/kernel/workflow/stage-machine.ts`：交接判定所需纯函数（如 `exitedForward`）
- [ ] 单测：交接建任务 / 去重 / 打回不触发 / 链深 / 目标阶段缺失 / 自指与跨工作流校验

## T6 远端 Worker 架构位（worker-dev）

- [ ] `src/host/worker-transport.ts`：`RemoteTransport` 端口与内存实现（不监听网络）
- [ ] `src/plugins/executors/remote/`：manifest + `createRemoteExecutor(transport|null)`（无传输 → `failed{runtime_missing}`，有传输 → 事件/回执透传与 abort）
- [ ] `src/plugins/registry.ts`：remote 执行器一行
- [ ] 单测：假传输事件与回执、abort、无传输失败、协议形状

## T7 renderer（ui-dev）

- [ ] `SettingsNav.tsx` + `AiWorkflowPage.tsx`：第五栏「插件」
- [ ] `PluginsManager.tsx`：列表 / 启停 / 授权 / config / secret / 状态与错误
- [ ] `WorkflowEditor.tsx`：阶段交接选择（工作流 + 阶段）+ `toDraft` 回传 `stage.id`
- [ ] `TaskCard.tsx`：交接徽标；`kernelStore.ts`：`plugins.replaced` 失效
- [ ] 组件测试 + `SettingsNav` 五栏断言

## T8 装配、e2e 与门禁（lead）

- [ ] `src/main/index.ts`：插件目录扫描 / 设置与 secret / net / sources startAll / 退出停 sources / `plugins.all` 视图
- [ ] `tests/e2e/webhook.spec.ts` + helper（种子库 + 起 app + 真实 POST 回环）
- [ ] `tests/e2e/handoff.spec.ts` + helper（两工作流 + 直读库断言）
- [ ] `pnpm check` exit 0；覆盖率不低于基线；`check:diffcov` ≥90%（目标 100%）；`pnpm e2e` 全绿

## T9 文档与收尾（lead）

- [ ] SPEC-plugins：外部插件 v1 只开 source/channel、能力授权口径、环境白名单、net、source hub、webhook 来源/通道
- [ ] SPEC-host：启动/退出顺序（sources）、插件设置与 secret、plugins.all、交付边界
- [ ] SPEC-kernel：`plugins.replaced` / `plugins.replace` / `plugin.set`、交接事实与触发点、tasks/stages 新列
- [ ] CAPABILITY-MAP / TEST-CASES / refactor-plan 开工与退出记录、CONSTRAINTS 复核行
- [ ] 提交、`pnpm check` 复核、fast-forward 合入 `master`
