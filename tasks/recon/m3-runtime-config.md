# M3 测绘：运行时配置面与 executorKey 迁移

> 只读测绘（未改 `src/**`、`tests/**`、`docs/**`）。证据格式 `相对路径:行号`。
> 结论口径：M3 目标 = dsh 搬 `src/plugins/executors/dsh/`、新增 command 插件、`src/plugins/registry.ts`、运行时配置新增 `executorKey`、detect 归插件、新增协议只改插件目录 + registry 一行。

## 0. 先看这几条

1. **SPEC 已经是 M3 口径，代码落后于 SPEC。** `SPEC-kernel.md:20`、`SPEC-kernel.md:185`、`SPEC-plugins.md:15`、`SPEC-plugins.md:107`、`SPEC-host.md:42` 都写「运行时按 `executorKey` 选执行器插件」；代码里没有 `executorKey` 列，只有 `protocol_family`。所以 M3 主体是「代码追 SPEC」，SPEC 只需补三件 SPEC 现在没写的：默认值归属、校验归属、detect 汇总契约（见 §6）。
2. **`RunRow.executorKey` 已存在但是死数据。** 类型在 `src/protocol/entities.ts:325-326`（注释就写着「M2 仍按协议族推导；M3 换成运行时配置的 executorKey」），由 `src/kernel/decide.ts:267`、`src/kernel/decide.ts:415` 从 `runtime.protocolFamily` 填；调度器从不读它——派发走 `executors.forRuntime(runtime)`（`src/main/ai-workflow/executor-port.ts:82-93`）。M3 要让它成为唯一派发依据。
3. **`protocol_family` / `'dsh'` 在生产代码 14 处，`'multica'` 默认 5 处**（§1）。DB 侧只有一处 CHECK：`src/host/schema.ts:21`。
4. **新增列的真实成本不在契约，在「指纹 → 重建 → 老事实」这条链。** `runtimes` DDL 进投影指纹（`src/host/schema.ts:329`、`src/host/schema.ts:332-339`），改 DDL 即触发老库首启全量重建；重建 fold 的是**已存在的旧 fact payload**（`src/host/store/facts.ts:20-28` 直接 `JSON.parse as Fact['payload']`，无校验），老 `runtime.*` payload 里只有 `protocolFamily`，新列 `executor_key NOT NULL` 会拿到 `undefined`。必须像 `normalizeRun`（`src/host/store/projection-apply.ts:111-152`）那样先加 `normalizeRuntime`，否则老库升级直接炸。
5. **`runtimes` 表不能只 `ALTER TABLE ADD COLUMN` 了事（若删 `protocol_family`）**：旧列带 CHECK，SQLite 不允许 DROP 被 CHECK 引用的列，得走 `runs` 那次同样的 12-step 物理重建（`src/host/db.ts:61-94`，注释里已写清「建临时表 + 改名」而不是 `RENAME` 的原因）。
6. **`src/plugins/`、`src/sdk/` 目录都还不存在**（M3 全新创建），`src/main/ai-workflow/runtime/{registry,detect}.ts` 是待删对象（`docs/planning/refactor-plan.md:86-88`）。

## 1. 硬编码点全表

### 1.1 契约枚举与类型（4 处 + 1 re-export）

| 位置                                             | 内容                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `src/protocol/entities.ts:28`                    | `export const PROTOCOL_FAMILIES = ['dsh'] as const`                       |
| `src/protocol/entities.ts:30`                    | `export type RuntimeProtocolFamily`（字面量联合，全仓唯一取值来源）       |
| `src/protocol/entities.ts:67`                    | `Runtime.protocolFamily: RuntimeProtocolFamily`（必填列）                 |
| `src/protocol/entities.ts:90`                    | `RuntimeInput.protocolFamily?: RuntimeProtocolFamily`（可选，省略取默认） |
| `src/shared/ai-workflow-api.ts:40`               | re-export `RuntimeProtocolFamily` 给 preload / renderer                   |
| `src/protocol/entities.ts:27-28` / `:68` / `:70` | 注释里写死「新增协议 = 新增后端实现」「默认 dsh」「默认 multica」         |

### 1.2 输入校验

| 位置                             | 内容                                                                                                                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/protocol/validate.ts:14`    | `import { ..., PROTOCOL_FAMILIES, ... } from './entities'`                                                                                                                               |
| `src/protocol/validate.ts:212`   | `optionalEnum(input.protocolFamily, 'input.protocolFamily', PROTOCOL_FAMILIES)` → 错误文案被测试锁定为 `input.protocolFamily取值必须是 dsh`（`tests/protocol/validate.test.ts:305-306`） |
| `src/protocol/commands.ts:11-26` | 命令白名单 `COMMAND_NAMES`：`runtime.create` / `runtime.update` / `runtime.remove` / `runtime.probed`（新协议不动这里，但 `RuntimeInput` 变了要回归）                                    |
| `src/protocol/inputs.ts:20-37`   | `HOST_INPUT_NAMES` + `INPUT_NAMES`（`run.claim` 等；新协议不动）                                                                                                                         |

### 1.3 内核决策（内核不能 import 运行期常量，所以手抄了一份白名单）

| 位置                            | 内容                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/kernel/decide.ts:60`       | `const PROTOCOL_FAMILIES: readonly Runtime['protocolFamily'][] = ['dsh']`（运行期副本，唯一真相源在 protocol） |
| `src/kernel/decide.ts:191-195`  | `protocolFamilyOf()` 取值校验                                                                                  |
| `src/kernel/decide.ts:267`      | `executorKey: runtime.protocolFamily`（chat run 行）                                                           |
| `src/kernel/decide.ts:415`      | `executorKey: runtime.protocolFamily`（stage run 行）                                                          |
| `src/kernel/decide.ts:464-466`  | `form.protocolFamily ?? 'dsh'` + `reject('invalid_input', '不支持的协议族: ...')`                              |
| `src/kernel/decide.ts:479`      | `command: form.command?.trim() \|\| 'dsh'`（**产品默认值写在内核里**）                                         |
| `src/kernel/decide.ts:480`      | `profile: form.profile?.trim() \|\| 'multica'`（同上）                                                         |
| `src/kernel/decide.ts:497-503`  | update 分支的协议族取值/拒绝                                                                                   |
| `src/kernel/decide.ts:517-530`  | update 组装（`protocolFamily`）、`command`/`profile` 兜底（`:522-523`）                                        |
| `src/kernel/decide.ts:375-379`  | `ACCESS_BY_PERMISSION`（权限枚举 → access，与协议族正交，M3 不动）                                             |
| `src/kernel/view-spec.ts:32-40` | `runtime.create/update/probed/remove` 的视图切片（全是 `['runtimes']`，新列不改变切片）                        |
| `src/kernel/types.ts:86`        | `View.runtimes: Map<Id, Runtime>`（类型跟随 entities，无需改投影清单）                                         |

### 1.4 DB DDL / CHECK / 指纹

| 位置                         | 内容                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/host/schema.ts:21`      | **唯一的 DB CHECK**：`protocol_family TEXT NOT NULL DEFAULT 'dsh' CHECK (protocol_family IN ('dsh'))`（同一行含默认值 + 枚举约束）                                |
| `src/host/schema.ts:22`      | `command TEXT NOT NULL DEFAULT 'dsh'`                                                                                                                             |
| `src/host/schema.ts:23`      | `profile TEXT NOT NULL DEFAULT 'multica'`                                                                                                                         |
| `src/host/schema.ts:17-33`   | `runtimesTable()` 全 DDL（也用于 `tableDdl.runtimes()`，`src/host/schema.ts:210`）                                                                                |
| `src/host/schema.ts:302-312` | `PROJECTION_TABLES` 含 `runtimes`                                                                                                                                 |
| `src/host/schema.ts:316-329` | `PROJECTION_DDL` = 九表 DDL 拼接 → **runtimes DDL 一字符变化即换指纹**                                                                                            |
| `src/host/schema.ts:332-339` | `formatOfProjection` / `projectionFormat` = `sha256(DDL + KERNEL_VERSION)`                                                                                        |
| `src/kernel/types.ts:32`     | `KERNEL_VERSION = 'm2.0.0'`（M3 需递增，见 §3.2 S5）                                                                                                              |
| `src/host/db.ts:96-142`      | `openDatabase`：先 `SCHEMA_SQL`（`CREATE TABLE IF NOT EXISTS` **不会补列**）→ `upgradeLegacyRuns`（`:126`）→ 补索引/`FACTS_SQL`/`process_registry`/`user_version` |
| `src/host/db.ts:61-65`       | `needsRunsUpgrade`：用 `RUN_M2_ADDED_COLUMNS`（`src/host/schema.ts:227-251`）对 `PRAGMA table_info` 做差集 → M3 的 `runtimes` 升级照抄这个形状                    |
| `src/host/db.ts:67-94`       | `upgradeLegacyRuns`：外键 OFF + 临时表 + `legacyRunsCopySql`（`src/host/schema.ts:259-274`）+ 删旧 + 改名                                                         |

### 1.5 投影写读（列映射，三处独立列清单必须同步改）

| 位置                                         | 内容                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/host/store/projection-apply.ts:226-244` | `runtimes` upsert 的 13 列 INSERT + `ON CONFLICT DO UPDATE`                                                         |
| `src/host/store/projection-apply.ts:357-374` | `writes.runtimes` 绑定（`runtime.protocolFamily` 在 `:362`，`lastProbe` JSON 在 `:371`）                            |
| `src/host/store/projection-apply.ts:111-152` | `normalizeRun`（**M3 要复制这个模式做 `normalizeRuntime`**）                                                        |
| `src/host/store/views.ts:69-83`              | `RuntimeRow`（snake_case）接口                                                                                      |
| `src/host/store/views.ts:193-208`            | `mapRuntime`（`protocol_family as RuntimeProtocolFamily` 在 `:196`）                                                |
| `src/host/store/views.ts:311-320`            | `readRuntimes` 的显式 SELECT 列清单                                                                                 |
| `src/host/store/import.ts:110-124`           | 旧库 `RuntimeRow` 接口                                                                                              |
| `src/host/store/import.ts:286-309`           | 首次迁移读旧 `runtimes` 表 + 逐列映射（`:297` 强转协议族）                                                          |
| `src/protocol/facts.ts:116-132`              | `runtime.created/updated/removed/probed` payload 都是「完整 `Runtime` 行」；字段随 entities 变，facts.ts 本身不用改 |
| `src/kernel/project.ts:55-56`、`:86-91`      | `snapshot.imported('runtimes')` 与 `runtime.*` → `put('runtimes', row)`（纯搬运，不改逻辑）                         |

### 1.6 命令 / 视图白名单

| 位置                                                      | 内容                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/ai-workflow/ipc.ts:135-198`                     | IPC 方法表：`runtimes.list/create/update/remove/detect/probe/statuses/models`                                                                |
| `src/main/ai-workflow/ipc.ts:138-160`                     | `runtimes.create`：`backendFor(input.protocolFamily ?? 'dsh')`（`:140`）+ `command \|\| 'dsh'`（`:141`）+ `profile \|\| 'multica'`（`:142`） |
| `src/main/ai-workflow/ipc.ts:178`                         | `runtimes.detect` → `detectInstalledRuntimes()`（**无参调用 = 真实 PATH**）                                                                  |
| `src/main/ai-workflow/ipc.ts:124-133`、`:180`、`:195-198` | `probeAndSave` / `runtimes.probe` / `runtimes.models` 都经 `backendFor(runtime.protocolFamily)`                                              |
| `src/protocol/views.ts:21-37`                             | `VIEW_IDS` 含 `runtimes.all`、`runtimes.workloads`（**没有** `runtimes.detected`，尽管 `SPEC-host.md:76` 写了它）                            |
| `src/protocol/views.ts:84`、`:95`                         | `'runtimes.all': Runtime[]`、`'runtimes.workloads': RuntimeWorkload[]`                                                                       |
| `src/host/store/views.ts:606-607`、`:628-629`             | `queryView` 的两个 runtimes 分支                                                                                                             |
| `src/shared/ai-workflow-api.ts:116-132`                   | `AiWorkflowApi.runtimes` 的 8 个方法签名（IPC 形状外露点）                                                                                   |
| `src/preload/index.ts:22-32`                              | preload 透传（形状变了要跟着）                                                                                                               |
| `tests/preload/index.test.ts:72-81`                       | 锁定了 runtimes 的 8 个方法名（新增方法会失败）                                                                                              |

### 1.7 detect 白名单

| 位置                                          | 内容                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `src/main/ai-workflow/runtime/detect.ts:5-16` | `RUNTIME_CANDIDATES` 10 条固定顺序（顺序即输出顺序，`:52-54`）              |
| `src/main/ai-workflow/runtime/detect.ts:22`   | `SUPPORTED_COMMANDS = new Set(['dsh'])`                                     |
| `src/main/ai-workflow/runtime/detect.ts:47`   | `supported: SUPPORTED_COMMANDS.has(command)`                                |
| `src/main/ai-workflow/runtime/detect.ts:37`   | `dirs ?? defaultScanDirs(platform)`                                         |
| `src/host/executable.ts:33-39`                | `defaultScanDirs` = `process.env.PATH` 分段 + 全局目录                      |
| `src/host/executable.ts:9-30`                 | `commonGlobalDirs`（Windows/POSIX 两套写死目录）                            |
| `src/host/executable.ts:65-83`、`:98-126`     | `findInDirs` / `resolveExecutable`（detect 与 probe 共用；detect 只用前者） |
| `src/shared/ai-workflow-api.ts:64-73`         | `DetectedRuntime{command,label,path,supported}`（外部契约）                 |

### 1.8 后端 / 执行器选择

| 位置                                             | 内容                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `src/main/ai-workflow/runtime/registry.ts:32-46` | `createRuntimeBackend(family)`：`switch (family) { case 'dsh': ... default: throw '不支持的协议族' }`               |
| `src/main/ai-workflow/runtime/dsh.ts:22`         | `DSH_RUNTIME_ID = 'dsh'`（probe 帧校验用，`:417`、`:568`）                                                          |
| `src/main/ai-workflow/executor-port.ts:72-79`    | 按协议族缓存 backend 的 `Map<RuntimeProtocolFamily, RuntimeBackend>`                                                |
| `src/main/ai-workflow/executor-port.ts:82-93`    | `forRuntime(runtime)` → `backendFor(runtime.protocolFamily)`                                                        |
| `src/main/ai-workflow/executor-port.ts:40-63`    | `bindBackend`：Runtime → `DshRunRequest`（命令/profile/权限/模型/workdir 透传，`:45-52`）                           |
| `src/main/index.ts:100-106`                      | 装配根：`sessionsDir` → `runtimeDeps` → `backendFor(family)` → `createRuntimeExecutors`                             |
| `src/main/index.ts:24`                           | `import type { ..., RuntimeProtocolFamily }`                                                                        |
| `src/protocol/executor.ts:13`、`:22`             | `ExecutorPort` 用 `Runtime`；`EXECUTOR_PORT_VERSION = 1`（注释说 M3 的 manifest 按它兼容判断 → 端口形状若变要递增） |
| `src/host/scheduler.ts:485-501`                  | `start()`：只依赖 `runtime` 行，不读 `run.executorKey`；`run.runtimeId` → `executors.forRuntime`（`:439-441`）      |

### 1.9 UI 选项与默认值

| 位置                                                                                  | 内容                                                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/renderer/src/apps/ai-workflow/components/RuntimeDialog.tsx:52`                   | `command` 初值 `?? 'dsh'`                                                                              |
| `src/renderer/src/apps/ai-workflow/components/RuntimeDialog.tsx:53`                   | `profile` 初值 `?? 'multica'`                                                                          |
| `src/renderer/src/apps/ai-workflow/components/RuntimeDialog.tsx:20-24`                | `PERMISSION_OPTIONS` 三项写死（与 `PERMISSION_MODES` 重复）                                            |
| `src/renderer/src/apps/ai-workflow/components/RuntimeDialog.tsx:137-147`              | 提交的 `RuntimeInput` 字段清单（**没有 `protocolFamily`** → 表单里根本没有「协议族」选项，全靠默认值） |
| `src/renderer/src/apps/ai-workflow/components/RuntimeManager.tsx:24-32`               | `newRuntimeInput()` 写死 `command:'dsh'` / `profile:'multica'`                                         |
| `src/renderer/src/apps/ai-workflow/components/RuntimeManager.tsx:330`                 | 列表里的协议族角标 `{r.protocolFamily}`                                                                |
| `src/renderer/src/apps/ai-workflow/components/RuntimeManager.tsx:249-266`             | `supported` 分支：「暂不支持」+ 文案「当前版本仅接入 DSH」                                             |
| `src/renderer/src/apps/ai-workflow/components/RuntimeManager.tsx:216-218`、`:192-202` | 「重新扫描」与「使用」预填（`label`/`command`）                                                        |
| `src/renderer/src/apps/ai-workflow/components/RuntimeStatusBadge.tsx:39`              | 健康 pill 只看 `probe.state`（与协议族无关，M3 不动）                                                  |

## 2. runtimes 的完整写读路径

### 2.1 写：一条配置从 UI 到事实

```
UI RuntimeManager.submit              src/renderer/.../RuntimeManager.tsx:157-162
  → wfApi().runtimes.create(input)    src/renderer/src/apps/ai-workflow/api.ts:4-8
  → window.aiWorkflow.runtimes.create src/preload/index.ts:25
  → ipcRenderer.invoke(AI_WORKFLOW_CHANNEL,'runtimes.create',[input])
  → ipcMain.handle → handler(method,args)   src/main/ai-workflow/ipc.ts:325-330
```

`runtimes.create`（`src/main/ai-workflow/ipc.ts:138-160`）：

1. **先探测、后落库**：`backendFor(input.protocolFamily ?? 'dsh').probe({command: input.command?.trim() || 'dsh', profile: input.profile?.trim() || 'multica'})`（`:140-143`）；
2. `probe.state !== 'ready'` → 抛错，不落库（`:144-146`）；
3. `dispatch({type:'runtime.create', ...})`（`:147-151`）→ `store.dispatch`（`src/host/store/index.ts:144-160`）：
   `validateInput`（`src/protocol/validate.ts:501-519` → `validateCommand` `:294-310` → `checkRuntimeInput` `:204-227`）
   → `kernel.viewSpec(input)`（`src/kernel/view-spec.ts:32-35` → `['runtimes']`）
   → `loadView`（`src/host/store/views.ts:504-518`，`runtimes` 切片走 `readRuntimes` `:311-320` + `mapRuntime` `:193-208`）
   → `decide`（`src/kernel/decide.ts:460-491`：名称唯一 `:474`、协议族校验 `:464-466`、权限 `:468-471`、并发归一 `:472-473`）
   → `project`（`src/kernel/project.ts:86-89`：`runtime.created/updated/probed` 都 `put('runtimes', payload.runtime)`）
   → `writer.applyAll`（`src/host/store/projection-apply.ts:416-441` → `writes.runtimes` `:357-374`）
   → `writeProjectionMeta`（`src/host/store/index.ts:139`）
4. 用事实反查新 id：`createdId(facts,'runtime.created')`（`src/main/ai-workflow/ipc.ts:42-57`）；
5. **再写一条 `runtime.probed`** 把 `lastProbe` 落到同一行（`:153-158` → decide `:534-539`）；
6. 返回 `runtimeById(store, id)`（`:60-64` → `store.query('runtimes.all')`）。

`runtimes.update`（`:162-173`）：先 `runtime.update` 事实，再 `runtimeById` + `probeAndSave`（`:124-133`）→ `runtime.probed`。探测失败不抛。
`runtimes.probe`（`:180`）：只 `probeAndSave`，不建 run、不写配置。
`runtimes.remove`（`:174-176`）：`decide` 里查被智能体引用则 `reject('conflict')`（`src/kernel/decide.ts:541-549`），否则 `runtime.removed`（payload 是 tombstone 整行 `src/protocol/facts.ts:124-127`）。

### 2.2 读：视图 → IPC → UI

- `runtimes.list`（`src/main/ai-workflow/ipc.ts:136`）→ `store.query('runtimes.all')` → `queryView`（`src/host/store/views.ts:597-607`）→ `readRuntimes`（`:311-320`，显式 13 列）→ `mapRuntime`（`:193-208`，`last_probe_json` 反序列化 `:206-207`）→ `Runtime[]` → preload → `RuntimeManager.items`（`:101`、`:116-128`）。
- `runtimes.statuses`（`:182-194`）→ `runtimes.workloads`（`src/host/store/views.ts:424-440`，按 `runs.runtime_id + status IN ('queued','running')` 现算）+ `runtimes.all`。
- 调度器自己的读取口是 `deps.runtimes()`（`src/main/index.ts:155` → `store.query('runtimes.all')`），`run.claim` 由内核判启用/并发（`src/kernel/decide.ts:790-800`）。

### 2.3 重建 / 指纹

- 指纹 = `sha256(PROJECTION_DDL + KERNEL_VERSION)`（`src/host/schema.ts:329-339`）。
- `ensureProjection`（`src/host/store/projection.ts:85-97`）：`meta.format !== current` 或 `meta.seq < lastSeq` → `rebuildProjection`（`:54-73`）：外键 OFF → `writer.clear()`（清九表，`src/host/store/projection-apply.ts:443-453`）→ 按 seq fold `kernel.project(fact)` → 写 meta。
- 启动顺序固定：`openDatabase`（结构/升级）→ `importLegacyIfNeeded`（旧表→事实）→ `store.ensureProjection()`（重建）（`src/main/index.ts:90-97`）。新列升级必须在这三者之前完成（在 `openDatabase` 内，照 `upgradeLegacyRuns` 的位置）。

### 2.4 `snapshot.imported` 与 runtimes

- payload 联合：`{ table: 'runtimes'; rows: Runtime[]; importedFrom: 'v2' }`（`src/protocol/facts.ts:268`）。
- 只有**事实日志为空**（真正的 v2 老库）才走「首次迁移」这条路（`src/host/store/import.ts:668-675` → `importEmptyLedger` `:571-615`）：按 `IMPORT_ORDER`（`:83-93`，`runtimes` 第一）读旧表（`readLegacyEntityRows` `:283-375`，runtimes 在 `:286-309`）→ 每批 ≤500 行写导入根（`appendImportFacts` `:553-566`，`buildDraft` `:484-508`）→ 同事务内 `writer.clear()` + `kernel.project(fact)` 回填 + `verifyCounts`（`:511-520`）+ 写 meta（`:595-609`）。
- **M2 升级补迁移不碰 runtimes**（`backfillRuntimeData` `src/host/store/import.ts:625-653` 只补 `runs`/`run_events`/聊天两表）→ M3 改 runtimes 列时，只有「v2 老库首次迁移」这一条路径需要读旧列名，可用 `PRAGMA table_info` 分支或让 `upgradeRuntimes` 先把 `executor_key` 回填好再让 import 读。
- 重建对导入根同样走 `project`（`src/kernel/project.ts:55-56`）→ 写入新列 → 所以 `normalizeRuntime` 对「导入根 + 老 `runtime.*` payload」都生效，一处覆盖两条路径。

## 3. executorKey 落地

### 3.1 改动清单（按层）

| #   | 层       | 位置                                                                                                                                                                     | 改什么                                                                                                                                                                    |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 契约     | `src/protocol/entities.ts:28-30`、`:67`、`:90`                                                                                                                           | 删 `PROTOCOL_FAMILIES`/`RuntimeProtocolFamily`，`Runtime.executorKey: string`、`RuntimeInput.executorKey?: string`；`RunRow.executorKey`（`:325-326`）注释去掉「M3 换成」 |
| 2   | 校验     | `src/protocol/validate.ts:14`、`:212`                                                                                                                                    | 换成 `optionalText(input.executorKey, 'input.executorKey', L)`（不枚举；合法性由宿主/registry 判）                                                                        |
| 3   | 内核     | `src/kernel/decide.ts:60`、`:191-195`、`:267`、`:415`、`:464-466`、`:497-503`                                                                                            | 删运行期白名单副本与 `protocolFamilyOf`；`executorKey` 只校验形状（非空、slug 长度）；run 行 `executorKey: runtime.executorKey`                                           |
| 4   | 内核     | `src/kernel/decide.ts:479-480`、`:522-523`                                                                                                                               | 默认 `command`/`profile`（`'dsh'`/`'multica'`）**必须搬出内核**（见 §7-2）                                                                                                |
| 5   | 事实     | `src/protocol/facts.ts:116-132`                                                                                                                                          | 不用改（payload 是完整 `Runtime` 行），但重建要能吃老 payload → 见 #8                                                                                                     |
| 6   | DDL      | `src/host/schema.ts:21`、`:17-33`、`:227-251` 邻位                                                                                                                       | 加 `executor_key TEXT NOT NULL DEFAULT 'dsh'`（是否保留 `protocol_family` 见 §5）；新增 `RUNTIMES_M3_ADDED_COLUMNS` + `legacyRuntimesCopySql`                             |
| 7   | 升级     | `src/host/db.ts:61-65` 邻位、`:122-134`                                                                                                                                  | 新增 `needsRuntimesUpgrade` / `upgradeRuntimes`（12-step，外键 OFF，照 `:67-94`），插在 `upgradeLegacyRuns` 之后、补索引之前                                              |
| 8   | 投影写   | `src/host/store/projection-apply.ts:226-244`、`:357-374`、`:111-152` 邻位                                                                                                | 列清单加 `executor_key`；新增 `normalizeRuntime`（`executorKey ?? 从 protocolFamily 推导 ?? ''`）                                                                         |
| 9   | 投影读   | `src/host/store/views.ts:69-83`、`:193-208`、`:311-320`                                                                                                                  | Row 接口 + `mapRuntime` + SELECT 列                                                                                                                                       |
| 10  | 导入     | `src/host/store/import.ts:110-124`、`:286-309`、`:471-481`、`:484-508`                                                                                                   | 旧行映射：老库无 `executor_key` 时从 `protocol_family` 映射                                                                                                               |
| 11  | 指纹     | `src/kernel/types.ts:32`                                                                                                                                                 | `KERNEL_VERSION = 'm3.0.0'`（与 DDL 双触发，幂等）                                                                                                                        |
| 12  | 插件     | 新增 `src/plugins/registry.ts`、`src/plugins/executors/dsh/**`、`src/plugins/executors/command/**`、`src/sdk/**`；删 `src/main/ai-workflow/runtime/{registry,detect}.ts` | registry 暴露 `executors: {key,label,plugin}[]`（顺序即 UI 顺序）                                                                                                         |
| 13  | 装配     | `src/main/index.ts:24`、`:100-106`、`:103-104`                                                                                                                           | `backendFor(family)` → `executors.forRuntime` 按 `runtime.executorKey` 查 registry；`src/main/ai-workflow/executor-port.ts:72-93` 缓存键换成 `string`                     |
| 14  | IPC      | `src/main/ai-workflow/ipc.ts:33`、`:125`、`:140-142`、`:178`、`:197`                                                                                                     | `backendFor` 签名 → 按 key；create 的默认 command/profile/executorKey 由 registry 提供；detect 改调 registry 聚合                                                         |
| 15  | shared   | `src/shared/ai-workflow-api.ts:40`、`:64-73`、`:116-132`                                                                                                                 | 去 `RuntimeProtocolFamily` re-export；`DetectedRuntime` 加 `executorKey`（`supported` 去留见 §7-4）；可能需要新增只读方法（§7-5）                                         |
| 16  | renderer | `src/renderer/.../RuntimeManager.tsx:24-32`、`:330`、`:249-266`；`RuntimeDialog.tsx:52-53`、`:137-147`                                                                   | 角标改 `r.executorKey`；表单加「执行器」`Select`（选项来自 registry）；`newRuntimeInput` 默认值改由选项首项给                                                             |
| 17  | 测试     | 见 §3.3                                                                                                                                                                  | 夹具/列清单/DDL 快照/组件断言                                                                                                                                             |

### 3.2 顺序化迁移序列（每步都可独立绿）

> 关键约束：**normalizer 必须先于指纹变化**；**表结构升级必须先于导入**。

1. **S0 契约先行（不碰 DB）**：改 `entities.ts` + `validate.ts` + `shared` re-export + `decide.ts` 的取值/校验/run 行赋值（把 `protocolFamily` 的读写都切到 `executorKey`，此时 `Runtime.protocolFamily` 删除、DDL 仍是老列 → 投影写入会插 NULL 进 `protocol_family NOT NULL`，所以 S0 与 S1 **必须同一提交**）。
2. **S1 DDL + 升级 + normalizer（同一提交）**：`schema.ts` 加列/删列 + `RUNTIMES_M3_ADDED_COLUMNS` + `db.ts` 的 `upgradeRuntimes` + `projection-apply` 的 `normalizeRuntime` + `views/import` 列映射。此时 `KERNEL_VERSION` 还没变，但 DDL 已变 → **指纹本来就会变**，所以这一步实际上已经触发重建；因此 normalizer 必须同批落地（老 payload 缺 `executorKey`）。
3. **S2 老库冒烟**：用真实库副本跑一次启动（v2 老库 + M2 库各一份），验证 `upgradeRuntimes` 回填 `executor_key`、重建后 `runtimes` 行数与 `lastProbe` 不丢、`agents`/`runs` 外键不悬空。这一步就是 M2 教训的验收位（`docs/planning/refactor-plan.md:62` 的回滚点做法）。
4. **S3 内核默认值下沉**：把 `'dsh'`/`'multica'` 从 `decide.ts:479-480` 移走（方案见 §7-2），内核只校验形状。
5. **S4 import 兼容**：`import.ts` 读旧表按列存在性分支（或依赖 S1 已回填），补 `buildDraft('runtimes')` 的映射测试。
6. **S5 KERNEL_VERSION → `m3.0.0`**：明确「M3 格式」版本号，避免 S1 的指纹变化被误认为偶发；发布说明里写清「首启全量重建」。
7. **S6 插件化搬迁**：`dsh.ts` 整文件 → `src/plugins/executors/dsh/`；新增 `command` 插件；`registry.ts` 静态清单；`detect` 从各插件汇总；删 `runtime/{registry,detect}.ts` 与 `SAR` 相关 import。
8. **S7 装配与 IPC**：`main/index.ts` 注入 registry；IPC 按 key 取端口；`runtimes.create` 的默认值来自插件 manifest；`runtimes.detect` 走 registry。
9. **S8 renderer**：表单加执行器选择、角标改 key、detect 清单支持度文案改为「本机已装但未注册插件」。
10. **S9 测试与 SPEC**：§3.3 清单 + §6 修订；`pnpm check` + `pnpm e2e` + 打包冒烟（`tests/e2e-packaged/packaged-sqlite.spec.ts` 断言 schema，若 `user_version`/表断言变化要同步）。

### 3.3 会被现有断言挡住的测试（改代码前先扫一遍）

- DDL 快照：`tests/host/schema.test.ts:21-74`（pre-M1 `runtimes` DDL 原样）、`:81`（`FIVE_TABLES`）、`:146-159`（**逐列全等**，加 `executor_key` 必红）、`:305-317`、`:328-334`。M2 靠「runs 不在 FIVE_TABLES」绕过了同类问题，M3 绕不过。
- 契约：`tests/protocol/entities.test.ts:336`（`PROTOCOL_FAMILIES`）、`:403-417`（`sampleRuntime` 字段名含 `protocolFamily`）、`:197-204`、`:275`。
- 校验：`tests/protocol/validate.test.ts:305-306`（`input.protocolFamily取值必须是 dsh`）、`:30`。
- 内核：`tests/kernel/decide.test.ts:276`、`:374`（`protocolFamily:'claude'` 被拒）、`:70`；`tests/kernel/{project,timeline,next-wake,decide.chat,decide.run}.test.ts` 的 `runtime` 夹具（`:46-53`、`:48-55`、`:51-58`、`:66-73`、`:48-55`）。
- store 夹具：`tests/host/store/test-support.ts:69`（`protocolFamily:'dsh'`）、`:241-258`（`runtimes` 快照列清单）、`:140`；`tests/host/store/fake-kernel.ts:149-150`。
- store 断言：`tests/host/store/import.test.ts:246-268`、`:342-352`；`projection-apply.test.ts:61-70`；`views.test.ts:333-339`；`{index,projection,rebuild}.test.ts` 的 `sample.runtime`。
- 宿主装配：`tests/host/ipc.test.ts:104-122`（create 探测入参）、`:199-214`（detect 形状）、`:68`（`backendFor`）；`tests/host/boot.test.ts:220-228`、`:360`（`backendFor('dsh')`）；`tests/host/{cancel,chat,reconcile,scheduler,executor,process-registry}.test.ts` 的 `createRuntime` + `backendFor`。
- preload：`tests/preload/index.test.ts:72-81`（8 方法名）、`:134-175`。
- renderer：`tests/renderer/.../RuntimeManager.test.tsx:38`、`:62`、`:109`（`getByText('dsh')`）、`:161-175`（支持/不支持/已添加三分支）、`:267`；`RuntimeDialog.test.tsx:34-37`、`:246-258`；`AiWorkflowPage.test.tsx:20`；`AgentManager/AgentDialog.test.tsx:30-37`。
- 插件测试搬家：`tests/main/ai-workflow/runtime/registry.test.ts:1-39`、`detect.test.ts:1-204`（`SUPPORTED_COMMANDS` 语义）→ `tests/plugins/executors/**`（附带 `floor-guard` 对 `tests/main → tests/plugins` 搬家的判定，见 task-3）。
- e2e：`tests/e2e/helpers/seed-crash.ts:86`（`maxConcurrent` 种子）；其它 e2e 不直接构造 runtime input。

## 4. detect 现状与插件化汇总

### 4.1 现状

- 入口唯一：`runtimes.detect`（`src/main/ai-workflow/ipc.ts:178`）→ `detectInstalledRuntimes()`（`src/main/ai-workflow/runtime/detect.ts:33-55`），**无参调用**，用真实 `process.env.PATH` + `commonGlobalDirs`。
- 扫描目录：`defaultScanDirs`（`src/host/executable.ts:33-39`）= `PATH` 分段（`:37`）+ `commonGlobalDirs`（`:9-30`，Windows 4 条 / POSIX 6 条，不存在则跳过）。
- 候选清单：`RUNTIME_CANDIDATES`（`detect.ts:5-16`）10 条，**顺序即输出顺序**（`:40`、`:52-54`）。
- 命中判定：Windows 试 `.exe/.cmd/.bat/.ps1`（`src/host/executable.ts:6`、`:72-76`）；POSIX 要求可执行位（`:54`、`:77-80`）；多目录取靠前（`:70-82`，测试 `tests/main/ai-workflow/runtime/detect.test.ts:110-116`）。
- `supported` 语义：不是「装没装」，而是「协议后端已实现，可接入为运行时」。仅 `dsh`（`detect.ts:22`、`:47`）。UI 用它决定「使用 / 暂不支持」（`RuntimeManager.tsx:249-266`），`detected` 只用于预填，从不写库（`SPEC-ai-workflow.md:234`）。
- 零副作用：只 `statSync`（`src/host/executable.ts:41-59`），不 spawn、不读版本、不写库；`runtimes.detect` 不发 changed（`SPEC-ai-workflow.md:371`，测试 `tests/host/ipc.test.ts:213`）。

### 4.2 插件化后的汇总契约（建议写进 SPEC-plugins「接口/executor」）

- 每个插件导出 `detect?(): DetectedRuntime[]`（纯同步、零副作用）或 `Promise` 版本；`DetectedRuntime` 增加 `executorKey`（由 registry 填充，插件不必自报）。
- 宿主侧调用顺序 = **registry 数组顺序**（`src/plugins/registry.ts` 的静态清单），串行 await（不并发，保证输出顺序稳定且便于定位慢插件）；同一 `command` 被多个插件声明时**按 registry 顺序先到先得**，冲突写一条 warn，不抛。
- 失败隔离：单个插件 `detect` 抛错/超时（建议 2 s/插件）→ 跳过该插件并记日志，**不影响其它插件与 UI**；整体永不抛（对齐 `SPEC-plugins.md:270`「插件失败不拖垮宿主」）。
- `supported` 语义消亡：registry 里有的插件返回的都是「可接入」；UI 需要区分的是「装了但无插件对应」，这由「候选清单不再写死在宿主」自然消失——因此建议直接删 `supported` 字段（代价见 §7-4）。

## 5. executorKey 三个候选方案

| 维度            | **A. executorKey 取代 protocol_family**                                                        | **B. 保留 protocol_family + 新增 executor_key**                       | **C. 不加列，用 command 推断**                                         |
| --------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 列取舍          | `runtimes.executor_key TEXT NOT NULL`，删 `protocol_family`                                    | 两列并存，`executorKey ?? protocolFamily` 回退                        | 不动 schema                                                            |
| 迁移方式        | 12-step 物理重建（旧列被 CHECK 引用，不能 `DROP COLUMN`）+ 从旧列回填                          | 纯 `ALTER TABLE ADD COLUMN`（最便宜）                                 | 零迁移                                                                 |
| 老 fact payload | 需 `normalizeRuntime`（缺 `executorKey` → 从 `protocolFamily` 推）                             | 需 `normalizeRuntime`（缺 `executorKey` → 用同行的 `protocolFamily`） | 不需要                                                                 |
| 生产文件数      | ~16（protocol 2 / kernel 1 / host 4~5 / main 4 / shared 1 / renderer 2 + 新增 plugins/sdk）    | ~15（多一处回退逻辑，少一个 12-step）                                 | ~8（不动 schema/契约/导入，只改 registry 推断表 + IPC + UI）           |
| 测试文件数      | ~28                                                                                            | ~26                                                                   | ~8                                                                     |
| 指纹/重建       | DDL 变 + `KERNEL_VERSION` 变 → 首启全量重建（一次）                                            | DDL 变 → 同样重建                                                     | 不重建（**这是 C 唯一优势**）                                          |
| 旧库兼容        | 需升级函数，一次性；回滚需 DB 备份（与 M2 同级）                                               | 升级可逆（多一列空着）                                                | 无风险                                                                 |
| 两套真相源      | 无                                                                                             | **有**（`AGENTS.md`「不得在过渡期保留两套真相源」直接冲突）           | 无（但「真相源」换成 command 字符串，语义更糟）                        |
| 与 SPEC 关系    | **零反向修订**：`SPEC-kernel.md:20/185`、`SPEC-plugins.md:15/107`、`SPEC-host.md:42` 已按 A 写 | 需反向改 3 份 SPEC                                                    | 需反向改 4 份 SPEC + 放弃 M3 验收条                                    |
| 新增协议成本    | registry 一行（达标）                                                                          | registry 一行（达标，但双字段要同步）                                 | 仍要改推断表（**不达标**）                                             |
| 结论            | **推荐**                                                                                       | 只在「M3 必须单次发布、不能接受一次全量重建」时才选；且与项目原则冲突 | 不推荐（`command` 用户可任意改名/绝对路径/包装脚本，无法作为协议标识） |

A 的两个细节：

- **CHECK 是否保留**：不要保留。若 CHECK 取值来自 registry → `PROJECTION_DDL` 依赖插件清单 → **加一行插件就触发全库重建**（`src/host/schema.ts:329`），与 `SPEC-plugins.md:107`「新增协议只改插件目录 + registry 一行」直接冲突。建议 DDL 只写 `TEXT NOT NULL DEFAULT 'dsh'`，合法性在 IPC 入口用 registry 校验（见 §7-3）。
- **默认值**：`DEFAULT 'dsh'` 本身也是产品名进 schema。可接受（DB 默认只兜导入/老行），但 `command`/`profile` 的默认值（`schema.ts:22-23`）同理——真正要处理的是内核里的那两处（`decide.ts:479-480`）。

## 6. 需修订的 SPEC 条目

| SPEC                             | 小节                                       | 修订内容                                                                                                                                                               |
| -------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/specs/SPEC-kernel.md`      | §派活单位（`:12-20`）                      | 已写 executorKey 口径 ✓；补一句「内核只校验 `executorKey` 为非空 slug（≤100 字符），不校验取值；默认 `command`/`profile` 来自执行器插件 manifest，内核不出现产品名」   |
| 同上                             | §类型契约（`:22-85`）                      | `View.runtimes` 的 `RuntimeRow` 字段清单更新为含 `executorKey`、无 `protocolFamily`                                                                                    |
| 同上                             | §事实目录（`:185`）                        | 已写「配置（含 `executorKey`）」✓；补「M3 起 `runtime.*` payload 无 `protocolFamily`，重建需按老 payload 归一（normalizeRuntime），不保留兼容字段」                    |
| 同上                             | §重建与指纹（`:303`）                      | 新增一条：「DDL 变更即换指纹 → 首启重建；重建 fold 的是历史 payload，因此**契约删除字段必须先加归一函数**」                                                            |
| `docs/specs/SPEC-plugins.md`     | §目录与注册（`:19-38`）                    | 补 `src/plugins/registry.ts` 的导出形状（`executors: ReadonlyArray<{key,label,manifest,plugin}>`）与「顺序即 UI 顺序 / detect 顺序」                                   |
| 同上                             | §接口 / executor（`:136-198`）             | `detect` 契约当前只有一行注释（`:141`）：补「零副作用、返回候选清单、`executorKey` 由 registry 注入、单插件失败隔离、2 s 超时、同 command 先到先得」                   |
| 同上                             | §Manifest（`:69-107`）                     | executor 的 `config` 字段成为**运行时表单字段来源**（command/profile/权限/模型默认值），明确「新增协议只改插件目录 + registry 一行」的验收含义                         |
| 同上                             | §内置插件清单（`:234-249`）                | `command` 插件必须给 `detect` 能力或明确不给（推荐不给，否则与 dsh 抢 `dsh` 命令）                                                                                     |
| 同上                             | §测试（`:272-278`）                        | 补「registry 汇总：顺序稳定、同名去重、单插件抛错不影响整体」                                                                                                          |
| `docs/specs/SPEC-host.md`        | §宿主职责（`:42`）                         | 已写「按 `runtime.executorKey` 调执行器插件」✓；补「未知 key → `run.host_settled{runtime_missing}`（沿用 `scheduler.start` 的兜底，`src/host/scheduler.ts:485-495`）」 |
| 同上                             | §存储与单实例（`:48-54`）                  | 补 M3 结构升级：`runtimes` 一次性物理重建（与 M2 `runs` 同级），顺序「结构升级 → 导入 → 指纹重建」                                                                     |
| 同上                             | §IPC 契约（`:56-77`）                      | 视图清单里的 `runtimes.detected` 与代码不符（`src/protocol/views.ts:21-37` 没有它）——要么删，要么明确 detect 继续走方法而非视图；若新增「执行器列表」需在此登记        |
| 同上                             | §启动与关闭（`:87-91`）                    | 启动序列补「载入 registry（静态清单）→ 注入 IPC/调度器」一步                                                                                                           |
| `docs/specs/SPEC-ai-workflow.md` | §数据模型（`:137`）                        | `runtimes` 表列：`protocol_family` → `executor_key`（DEFAULT `dsh`，无 CHECK，理由见 §5）                                                                              |
| 同上                             | §迁移（`:151`）                            | 新增 M3 段：DDL 变化 + `KERNEL_VERSION=m3.0.0` → 首启重建；老 payload 归一；回滚需 DB 备份                                                                             |
| 同上                             | §运行时模型（`:188-205`）                  | `protocolFamily` 行改 `executorKey`；默认值清单（`:203`）改为「由插件 manifest 提供」                                                                                  |
| 同上                             | §探测与健康（`:207-215`）                  | `runtime='dsh'` 的帧校验归 dsh 插件内部（`:211`）；`create` 先探测的规则不变，但探测用的后端由 `executorKey` 选                                                        |
| 同上                             | §检测（`:217-234`）                        | 候选清单/`SUPPORTED_COMMANDS`/`supported` 语义整节重写为「registry 汇总各插件 detect」；UI 行为段（`:234`）改「已添加 / 已有插件 / 未注册」三态                        |
| 同上                             | §IPC 契约（`:315-332`）                    | `RuntimeInput` 字段（`executorKey`）、`DetectedRuntime` 形状（去 `supported` 或加 `executorKey`）、可能新增的 `runtimes.executors()`                                   |
| 同上                             | §Boundaries（`:420`）                      | 「新增协议族」从 Ask-first 里移除或改成「新增执行器插件（M3 起是本机插件目录 + registry 一行，不需评审）」                                                             |
| 同上                             | §Out of scope（`:442`）                    | 删「其它协议族的后端实现（`protocolFamily` 当前仅 `dsh`）」，改为「由插件提供，M3 后不再是范围外」                                                                     |
| 同上                             | §Success Criteria（`:423-435`）            | 加一条 M3 验收：「新增一个假运行时协议只写插件目录 + registry 一行即可被 detect 到、被选中、跑通一轮」                                                                 |
| `docs/ARCHITECTURE.md`           | §插件（`:133-160`）、§验收与度量（`:246`） | 与 `SPEC-plugins` 同步 registry 形状与「executorKey 选择」口径                                                                                                         |
| `docs/planning/refactor-plan.md` | §里程碑 M3（`:20`）、§文件去向（`:86-88`） | 已写删除 `runtime/{registry,detect}.ts` ✓；补「runtimes 表 12-step 升级 + normalizeRuntime」到 M3 交付物                                                               |

## 7. 待拍板（3–5 条）

1. **方案 A / B 选哪个？** SPEC 已按 A 写死（`SPEC-kernel.md:20/185`、`SPEC-plugins.md:15`），B 需要反向修订 3 份 SPEC 且与「禁止两套真相源」冲突；A 的代价是一次 `runtimes` 12-step 物理升级 + 老库首启全量重建。建议 A。
2. **内核里的产品默认值去哪？** `decide.ts:479-480` 的 `'dsh'`/`'multica'` 违反「内核不出现产品名」。三种落法：(a) 默认值由 IPC 从 registry/manifest 补齐后再 dispatch（内核只见完整输入）；(b) `executorKey`/`command` 改为必填，UI 预填；(c) 内核按 manifest 注入的白名单取默认值（需给 `decide` 加注入参数，动 KernelPort 签名）。推荐 (a)，但要确认 `runtime.create` 的 reject 文案/测试是否可接受改动。
3. **DB CHECK 是否彻底去掉？** 保留 CHECK 就必须把插件清单塞进 DDL → 加插件触发全库重建（与 M3 验收冲突）。建议去掉，靠 IPC 入口的 registry 校验拦住非法 key；代价是「绕过 IPC 直接写库」时非法值能落库（当前 `createRuntimeBackend` 的 `default: throw` 已经兜住这类情况，可保留为最后防线）。
4. **`DetectedRuntime.supported` 删还是留？** 删更符合「registry 里有的都可接入」，但会动 `src/shared/ai-workflow-api.ts:64-73`、`RuntimeManager.tsx:249-266` 的三态 UI 与 `tests/renderer/.../RuntimeManager.test.tsx:161-175`。留则语义变成「registry 里是否有该 executorKey 的插件」，需要给 `DetectedRuntime` 加 `executorKey`。
5. **「执行器列表」给 UI 的通道**：表单要选 `executorKey`，选项只能来自 registry。加一个 `runtimes.executors(): {key,label}[]` 方法最直接，但 `SPEC-host.md:74` 写「三个动词之外不新增 RPC」、`SPEC-ai-workflow.md:371` 只约束 detect 只读——当前 `AiWorkflowApi` 已是一批具名方法，加一个是否算破例需要拍板；替代方案是把 `executors` 塞进 `runtimes.detect()` 的返回（形状变成 `{executors, candidates}`，破坏性更大）。
