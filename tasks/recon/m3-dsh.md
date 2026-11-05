# M3 测绘：dsh 适配层拆解与插件化依赖映射

> 只读测绘。基线：M2 完成态（`src/protocol/executor.ts` 端口 + `src/host/executor.ts` 适配器 + `main/ai-workflow/runtime/**` 实现）。
> 目标态：`src/plugins/executors/dsh/index.ts`（整文件搬）+ `src/plugins/registry.ts` + `src/sdk/**`，运行时配置用 `executorKey` 选插件（`docs/planning/refactor-plan.md:20,86-88`、`docs/specs/SPEC-plugins.md:136-198,234-240`）。

## 0. 结论速览

1. `dsh.ts` **自身不 import 任何 node 内置模块**，全部 IO 都走两个宿主模块：`host/process.ts`（spawn/killTree/lineReader/tail）与 `host/executable.ts`（resolve/needsShell/PATH 扫描）——这是它「能整文件搬」的前提，也是插件化后必须补 sdk 能力的两处缺口（见 §2）。
2. 当前 `DshDeps` 的**可注入面 = 未来 sdk 的能力面**：`spawn`/`killTree`/`now`/`baseEnv`/`sessionRoot`/`timeouts`/`grace`（`src/main/ai-workflow/runtime/dsh.ts:38-52`）。前五项可由 sdk 覆盖，`killTree` 与「可执行文件解析 + `.cmd` shell 包装」是 sdk 明确缺口。
3. 协议半边（frame 类型、execute/cancel 帧形状、probe 判据）是 dsh 专属；时序半边（cancel→宽限→SIGTERM→SIGKILL、幂等收尾、终态归一、JSONL 切行、stderr 尾部）是通用件，可进 `plugins/shared/`（`SPEC-plugins.md:38`）。
4. `resume_rejected` 重试与 `timeout→failed` 归一在 **host 适配器**而不是 dsh 里（`src/host/executor.ts:72-73,117-163`）。插件直接实现 `ExecutorPort` 后这两段必须有人接（建议留在 host 侧 wrapper），否则迁移清单 10 断掉。
5. 四处硬编码要一起拆：`PROTOCOL_FAMILIES`（`src/protocol/entities.ts:28`）、`SUPPORTED_COMMANDS`（`src/main/ai-workflow/runtime/detect.ts:22`）、`createRuntimeBackend` 的 switch（`runtime/registry.ts:32-46`）、`kernel` 里 `executorKey: runtime.protocolFamily`（`src/kernel/decide.ts:267,415`）。
6. 门禁会拦：`tsconfig.node.json` 没有 `src/plugins/**`、`src/sdk/**`、`tests/plugins/**`（`tsconfig.node.json:19-37`）；`eslint.config.mjs` 没有 plugins 边界规则（只有 renderer/main/host/kernel 四段，`eslint.config.mjs:28-140`）。

## 1. 结构地图

单文件 894 行，零 node 内置 import，4 个导出函数 + 10 个内部 helper。

### 1.1 区块与行号

| 区块           | 行号             | 内容                                                                                                                                                                                                                                                                             |
| -------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 外部 import    | `dsh.ts:1-17`    | 类型全来自 `shared/ai-workflow-api`（1-8）；`host/executable`（9）；`host/process` 的 `createLineReader/defaultSpawn/killProcessTree/tail`（10-17）                                                                                                                              |
| 常量           | `dsh.ts:19-36`   | `DSH_PROTOCOL_VERSION=1`(20)、`DSH_RUNTIME_ID='dsh'`(22)、`PROBE_TIMEOUT_MS=60_000`(24)、`VERSION_TIMEOUT_MS=15_000`(26)、`MODELS_TIMEOUT_MS=120_000`(28)、`RUN_TIMEOUT_MS=30*60_000`(30)、`CANCEL_GRACE_MS=3_000`(32)、`KILL_GRACE_MS=2_000`(34)、`OUTPUT_TAIL_LIMIT=4_000`(36) |
| 注入面         | `dsh.ts:38-52`   | `DshDeps`（见 1.2）                                                                                                                                                                                                                                                              |
| 协议帧类型     | `dsh.ts:61-100`  | `DshThinkingLevel`/`DshModelFrame`/`DshFrame`（`DshFrame` 23 个可选字段，73-100）                                                                                                                                                                                                |
| 对外结果/请求  | `dsh.ts:103-133` | `DshRunOutcome`(103-115)、`DshRunRequest`(117-133)                                                                                                                                                                                                                               |
| 小工具         | `dsh.ts:135-168` | `Collected`(135-141)、`errMsg`(143)、`parseFrame`(146-154)、`frameErrorText`(157-162)、`withStderr`(165-168)                                                                                                                                                                     |
| 模型 id        | `dsh.ts:171-186` | **导出** `parseModelId`：`provider/model` 拆分 + `decodeURIComponent` 容错                                                                                                                                                                                                       |
| 进程启动       | `dsh.ts:189-211` | `startProcess`：resolve → 组 env → `spawn(path,args,{cwd,env,shell})`                                                                                                                                                                                                            |
| 一次性命令收集 | `dsh.ts:217-290` | `collect`：`--profile` 前置(235)、超时→killTree(256-261)、stdout 全收 / stderr 截尾(268)、`onClose`/`onError` 双收口                                                                                                                                                             |
| 版本读取       | `dsh.ts:293-308` | `readCliVersion`：`--version` + semver 正则(306)                                                                                                                                                                                                                                 |
| 探测           | `dsh.ts:311-442` | **导出** `probeDshRuntime`                                                                                                                                                                                                                                                       |
| 模型目录       | `dsh.ts:445-517` | `providerOf`(445-450)、`thinkingLevels`(453-468)、**导出** `listDshModels`(471-517)                                                                                                                                                                                              |
| 执行           | `dsh.ts:520-894` | `mapResultStatus`(520-536)、`DshRunState`(538-551)、`handleFrame`(554-629)、**导出** `executeDshRun`(637-894)                                                                                                                                                                    |

### 1.2 `DshDeps` 注入项与缺省实现

| 项                                     | 行                                       | 缺省                                                                                                                              | 用途                                     |
| -------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `spawn?: SpawnFn`                      | `dsh.ts:40`（缺省 `dsh.ts:315,475,641`） | `host/process.ts:24-48` `defaultSpawn`（`stdio:['pipe','pipe','pipe']`、POSIX `detached:true`、`windowsHide:true`）               | 所有子进程                               |
| `killTree?: (pid, signal?) => boolean` | `dsh.ts:42`（缺省 `dsh.ts:643`，另 258） | `host/process.ts:54-74` `killProcessTree`（win32 `taskkill /pid <p> /T /F`；POSIX `process.kill(-pid)`→回落 `process.kill(pid)`） | 杀进程树                                 |
| `now?: () => number`                   | `dsh.ts:43`                              | `Date.now`（`dsh.ts:642`）                                                                                                        | `durationMs`、`elapsedMs`、`checkedAt`   |
| `baseEnv?: ProcessEnv`                 | `dsh.ts:45`                              | `process.env`（`dsh.ts:197,236`）                                                                                                 | 子进程环境基线（**全量透传，无白名单**） |
| `sessionRoot?: string \| null`         | `dsh.ts:47`                              | `null` → 不设 env（`dsh.ts:199`）                                                                                                 | 写 `MULTICA_DSH_SESSION_ROOT`，跨轮续接  |
| `timeouts?{probe,version,models,run}`  | `dsh.ts:49`                              | 常量 24/26/28/30                                                                                                                  | 测试覆写                                 |
| `grace?{cancel,kill}`                  | `dsh.ts:51`                              | 常量 32/34（`dsh.ts:765-766`）                                                                                                    | 测试覆写                                 |

装配根现状：`src/main/index.ts:100-102` 建 `userData/ai-workflow/sessions` 目录后以 `{ sessionRoot }` 注入；`executor-port.ts:22-27` 在其上叠 `retryOnResumeRejected`/`requestId`。

## 2. 依赖清单与 sdk 映射

| 依赖                              | 出处（相对路径:行号）                                                  | 现状                                                                                                    | sdk 是否已有                                                             | 缺口/风险                                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:child_process` spawn        | `src/host/process.ts:1,24-48`                                          | 经 `SpawnFn` 注入；`stdio` 三管道、POSIX 独立进程组                                                     | `sdk.process.spawn(argv[], {cwd,env,signal})`（`SPEC-plugins.md:51-57`） | 形状不同：现签名 `(command, args[], {env, shell})`；sdk 是 `argv[]` 且 `env` 为 `Record<string,string>`（不能传 `undefined`）。**必须保住** `detached`+`windowsHide`，否则 POSIX 杀组失效                      |
| 杀进程树                          | `src/host/process.ts:54-74`，调用点 `dsh.ts:258,759,763,889`           | `killProcessTree` / `.cmd` 无关；只吃 pid                                                               | **无**                                                                   | **硬缺口**。迁移清单 8（`refactor-plan.md:107`）依赖它。建议 sdk 加 `process.kill(handle, signal)` 或 `Spawned.killTree(signal)`，且保留 `pid===undefined` 时回落 `child.kill`（`dsh.ts:259-260,760-764,890`） |
| 可执行解析（PATH + 全局目录扫描） | `src/host/executable.ts:33-39,65-83,98-126`；调用 `dsh.ts:194,224,321` | `resolveExecutable`：带分隔符走路径、否则扫 `PATH`+`commonGlobalDirs`；Windows 试 `.exe/.cmd/.bat/.ps1` | **无**                                                                   | **硬缺口**。插件禁止 import `host/**`（`SPEC-plugins.md:262`）。需 sdk 暴露 `resolve`/`which`（含 `fs.stat` 语义），否则 probe/models/detect 全废                                                              |
| `.cmd/.bat` shell 包装            | `src/host/executable.ts:129-133`；调用 `dsh.ts:205,241`                | `needsShell` → `shell:true`                                                                             | **无**                                                                   | 缺口；与上条同源能力。`SPEC-plugins.md:197` 另要求 command 执行器用「`cmd /c` + 单一脚本参数」的固定包装                                                                                                       |
| 环境变量                          | `dsh.ts:197-199,236`                                                   | 全量 `process.env` 透传 + `DSH_PERMISSION_MODE`(198) + `MULTICA_DSH_SESSION_ROOT`(199)                  | sdk 由宿主白名单构造（`SPEC-plugins.md:67`）                             | **语义缺口**：白名单会削掉 `HOME/PATH/APPDATA/SystemRoot` 等，dsh CLI 可能立刻不可用；需定义执行器白名单基线                                                                                                   |
| 会话根目录                        | `dsh.ts:199`；建目录 `src/main/index.ts:100-101`                       | 宿主 `mkdirSync` 后注入                                                                                 | `sdk.config<T>()`（`SPEC-plugins.md:49`）                                | 无目录扫描需求（dsh 只把根丢给 CLI）；缺的是「宿主 → 插件」的配置通道                                                                                                                                          |
| 临时文件                          | 无                                                                     | `dsh.ts` 全文 0 处写文件                                                                                | `sdk.fs.write`                                                           | 无缺口（dsh 不产生临时文件；`Turn.contextFile` 是宿主给的只读路径，`protocol/executor.ts:52-53`）                                                                                                              |
| 读文件                            | 仅 `statSync`（`host/executable.ts:43,52`）                            | 只做存在性/可执行位判断                                                                                 | `sdk.fs.read`（返回文本）                                                | 不匹配：需要的是 `stat`，不是读内容。建议并入「解析可执行」能力，别放 fs                                                                                                                                       |
| 时钟                              | `dsh.ts:316-319,642,781`                                               | `now()` 毫秒数                                                                                          | `sdk.now(): Iso`（字符串）                                               | 轻微缺口：需 `Date.parse(sdk.now())` 或 sdk 增加 `nowMs`                                                                                                                                                       |
| 日志                              | 无                                                                     | 0 处 console/log；诊断只进 `RuntimeProbe.output`/错误文案（`dsh.ts:344,353-356,396`）                   | `sdk.log`                                                                | 无缺口；M3 可顺手补日志（当前删/加都不影响行为）                                                                                                                                                               |
| 网络                              | 无                                                                     | `dsh.ts` 不 import `net/http`                                                                           | `sdk.net`/`capabilities:'net'`                                           | 不声明 `net`                                                                                                                                                                                                   |
| 子进程 pid 回调                   | `dsh.ts:697`                                                           | 宿主写 `process_registry`（`src/main/index.ts:111-120`）                                                | `ExecutorIO.process?(pid)`（`protocol/executor.ts:69-72`）               | SPEC 的 `ExecutorIO` 漏了 `process`（`SPEC-plugins.md:167-170`），需补                                                                                                                                         |

## 3. 协议行为

### 3.1 启动 argv 与 stdin 用法

- 一次性命令：`['--profile', <profile>, ...extraArgs]`，extraArgs 为 `['--version']` / `['--probe']` / `['--list-models']`（`dsh.ts:235`，调用点 302/341/480）。`collect` **不传 cwd**（`dsh.ts:239-242`），只有执行路径传 cwd。
- 执行：`['--profile', <profile>, '--stdio']`（`dsh.ts:677-681`），`spawn` 选项 `{cwd: runtime.workdir ?? undefined, env, shell: needsShell(path)}`（`dsh.ts:202-206`）。
- **prompt 从不进 argv**：它作为 `execute` 帧的一个 JSON 字段走 stdin（`dsh.ts:719,874-881`）。
- 写帧 = `JSON.stringify(frame) + '\n'`，写失败即 `false`（`dsh.ts:717-724`）；收尾 `child.stdin?.end()`（`dsh.ts:842`）。

### 3.2 `--stdio` JSONL 帧

| 帧 `type`        | 方向         | 字段（`dsh.ts:73-100`）                                                                                                   | 处理                                                                                    |
| ---------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `execute`        | 出           | `v,type,request_id,cwd,prompt,mcp_servers[],model{provider,id}?,reasoning_effort?,resume_session_id?`（`dsh.ts:874-885`） | 启动后立即写；`mcp_servers: []` 写死（880）                                             |
| `cancel`         | 出           | `v,type,request_id`（`dsh.ts:756`）                                                                                       | 取消/超时第一动作                                                                       |
| `probe`          | 入（一次性） | `v,runtime,protocol_version,plugin_version`                                                                               | 见 3.3                                                                                  |
| `models`         | 入（一次性） | `models:[{id,label,provider,default,thinking{supported_levels[],default_level}}]`                                         | 见 3.4                                                                                  |
| `ready`          | 入           | `runtime`（须为 `dsh`）                                                                                                   | 置 `state.ready`；不得事件（`dsh.ts:567-573`，测试 `dsh.test.ts:479`）                  |
| `session`        | 入           | `session_id`                                                                                                              | 记 `state.sessionId` + emit `status:running`（`dsh.ts:574-577`）                        |
| `text`           | 入           | `content`                                                                                                                 | 累加 `state.text` + emit `text`（578-583）                                              |
| `thinking`       | 入           | `content`                                                                                                                 | emit `thinking`（584-586）                                                              |
| `tool_call`      | 入           | `call_id,name,arguments`                                                                                                  | emit `tool_call`（587-594）                                                             |
| `tool_result`    | 入           | `call_id,name,output,is_error`                                                                                            | emit `tool_result`（595-603）                                                           |
| `usage`          | 入           | `input_tokens,output_tokens,cache_read_tokens,cache_write_tokens`                                                         | **只累加，不 emit**（604-609）——`RunEventType` 无 `usage`（`protocol/entities.ts:240`） |
| `protocol_error` | 入           | `code,message`                                                                                                            | 记 `state.protocolError`（610-616）                                                     |
| `result`         | 入           | `status,output,session_id,resume_rejected,error{code,message}`                                                            | 记终态（617-625）                                                                       |
| 其它             | 入           | —                                                                                                                         | 忽略（626-628）                                                                         |

帧过滤：先查 `frame.v !== 1` → `protocolError` 立即返回（`dsh.ts:560-563`）；再查 `frame.request_id` 存在且不等于本轮 `requestId` → 丢弃（564）。切行用 `host/process.ts:87-112` `createLineReader`（跳过空行、容忍 `\r\n`），`onClose` 前 `lines.flush()`（`dsh.ts:869`）。

### 3.3 probe 判据（`probeDshRuntime`，`dsh.ts:311-442`）

顺序：`resolveExecutable` 失败 → `unavailable`+`path:null`（321-334）→ 读版本（失败不阻断，336）→ `--probe`（337-343，超时 60s）→ 判 spawnError(346-358)/timedOut(359-374) → 在 stdout 按 `\n` 找 `type==='probe'` 帧（376-383，取**第一帧**）→ 无帧则区分「退出码非 0」与「未提供 `--probe`」（385-401）→ `v===1 && protocol_version===1`（403-416）→ `runtime==='dsh'`（417-429）→ `ready`，带 `path/cliVersion/protocolVersion/pluginVersion/output/elapsedMs/checkedAt`（431-441）。
`output` 取 `stderr || stdout` 的尾部 4000 字符（`dsh.ts:344`，`host/process.ts:115-117`）。

### 3.4 models 来源（`listDshModels`，`dsh.ts:471-517`）

`--list-models` 的 stdout 逐行 parse，只收 `type==='models'` 且 `models` 为数组的帧（489-491）；跳过无 `id` 项（493）；`label` 空回落到 id（497）；`provider` 缺失时从 id 前缀兜底（445-450）；`thinking.supported_levels` 兼容 `{value}` 与裸字符串两种形态（453-468）；`default_level` 归一为 `defaultThinkingLevel`（501-504）。空目录/非零退出抛带 stderr 的错误（509-515）。

### 3.5 帧 → `RunEvent` 映射（`handleFrame`，`dsh.ts:554-629`）

`seq` 由本模块从 1 递增（`dsh.ts:707-715`），订阅方抛错被吞（712-714，测试 `dsh.test.ts:715-731`）。映射表见 3.2。`ready`/`result`/`protocol_error`/`usage` 不产生事件——这是断言 `dsh.test.ts:538-546,949` 的依据。

### 3.6 session 续接与 `resume_rejected`

- 续接：`execute` 帧带 `resume_session_id`（`dsh.ts:885`），来源 `DshRunRequest.resumeSessionId`（126）→ `Turn.resumeSessionId`（`protocol/executor.ts:43-44`）→ run 行（`host/scheduler.ts:290`）。
- 采集：`session` 帧（574-577）与 `result.session_id`（622）；终态优先取 `result.sessionId ?? state.sessionId`（`dsh.ts:774`）。
- 失效信号：`result.resume_rejected === true` 原样带出（`dsh.ts:623,779`），**dsh 自己不做重试**。
- 重试在 host 适配器：`resume_rejected && 有 resumeSessionId && 未 abort` → 清会话、用 `turn.fallbackPrompt ?? turn.prompt` 重发一次；仍被拒且非取消/超时 → `failed`（`src/host/executor.ts:138-163`；cancel/timeout 优先 154-156）。`fallbackPrompt` 由装配根按完整历史拼（`host/scheduler.ts:107-108,292`）。

### 3.7 取消时序、超时、杀树

`terminate()`（`dsh.ts:753-767`）：写 `cancel` 帧 → `CANCEL_GRACE_MS=3s` → `killTree(pid,'SIGTERM')`（无 pid 回落 `child.kill`）→ `KILL_GRACE_MS=2s` → `killTree(pid,'SIGKILL')`。每个定时器回调先看 `closed`（758,762），进程已退出就不再杀（测试 `dsh.test.ts:833-847,1015-1031`）。
触发源两个：`signal.abort`（`dsh.ts:769,872`）与 30 分钟超时定时器（849-855，`RUN_TIMEOUT_MS`；宿主传入值 `host/scheduler.ts:133,293` 同为 1_800_000）。
Windows：`killProcessTree` 固定 `taskkill /pid <p> /T /F`（`host/process.ts:56-62`），不区分 SIGTERM/SIGKILL——即 Windows 上 3s+2s 两阶段退化为「同一命令两次」，行为必须保持（迁移清单 8）。
`execute` 帧写不进去时：置 spawnError、杀树、立刻收尾（`dsh.ts:886-892`，测试 869-878）。
收尾幂等：`settled` 守卫 + 清三个定时器 + 摘 abort 监听 + `stdin.end()`（`dsh.ts:836-847`）。

### 3.8 终态归一（`buildOutcome`，`dsh.ts:772-834`）

`result` 帧优先（783-807）：`status` 经 `mapResultStatus`（520-536：completed/succeeded/success→succeeded；cancelled/canceled/aborted→cancelled；timeout/timed_out→timeout；其余/缺省→failed）→ `errorCode` 映射 succeeded→null / cancelled→`cancelled` / timeout→`timeout` / 其它→`run_failed`；错误文案取 `result.error || protocolError || 兜底`（793-800）。
无 `result` 时按序：`timedOut`→`timeout`（817-821）→ `cancelRequested`→`cancelled`（822）→ `spawnError`→`spawn_failed`（823）→ `protocolError`→`protocol_error`（824-825）→ `!ready`→`protocol_error`「未就绪」（826-830）→ 非零退出→`exit_nonzero`（831-832）→ 否则 `no_result`（833）。
`output = result.output || state.text`（773）；`sessionId = result.sessionId ?? state.sessionId`（774）。
注意：`timeout` 状态在 host 适配器才折成 `failed`+`errorCode='timeout'`（`src/host/executor.ts:72-73`）；插件化后插件直接产出 `Receipt`（`protocol/executor.ts:97-101`），归一必须提前。

### 3.9 usage

四个字段全量累加（`dsh.ts:604-609`），初值 `emptyUsage()`（54-59），`result` 帧不覆盖 usage（`DshFrame` 上的 token 字段仅 usage 帧用）。终态原样塞进 `DshRunOutcome.usage`。

## 4. 通用 vs dsh 专属切分

### 4.1 可进 `src/plugins/shared/`（纯函数，`SPEC-plugins.md:38`）

| 候选                                          | 现位置                    | 备注                                                                    |
| --------------------------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| JSONL 帧解析 `parseFrame`                     | `dsh.ts:146-154`          | 非对象/数组/非法 JSON → null                                            |
| 增量切行 `createLineReader`                   | `host/process.ts:87-112`  | 插件不能 import host，需复制进 shared（或 sdk 暴露）                    |
| 文本尾部 `tail`                               | `host/process.ts:115-117` | OUTPUT_TAIL_LIMIT 用                                                    |
| 错误码/文案拼装 `frameErrorText`+`withStderr` | `dsh.ts:157-168`          | `withStderr` 的 `[dsh stderr]` 标签参数化                               |
| semver 提取                                   | `dsh.ts:306`              | 任何 CLI `--version` 通用                                               |
| `parseModelId`                                | `dsh.ts:171-186`          | `provider/model` + 百分号反转义，纯                                     |
| 终态状态映射 `mapResultStatus`                | `dsh.ts:520-536`          | 通用词表；command 执行器可复用（或退化为 exitCode 判据）                |
| 终态归一骨架（status→errorCode→文案）         | `dsh.ts:772-834`          | 建议抽 `normalizeOutcome()`，dsh 只填「有没有 result 帧」               |
| 取消/超时两阶段杀树骨架                       | `dsh.ts:747-767,836-855`  | 依赖注入 `writeCancel?`/`killTree`/`now`/定时器；无 cancel 帧的协议传空 |
| argv 模板 + 占位符替换                        | 新增                      | command 执行器专用（§4.3）                                              |

### 4.2 dsh 专属（留在 `plugins/executors/dsh/`）

`--profile` 前置、`--stdio/--probe/--list-models/--version` 四个 argv 词；`DshFrame` 全部帧类型与字段；`execute`/`cancel` 帧形状（含 `mcp_servers: []`、`model{provider,id}`、`reasoning_effort`、`resume_session_id`）；`v=1`/`protocol_version=1`/`runtime='dsh'` 三判据；`DSH_PERMISSION_MODE` 与 `MULTICA_DSH_SESSION_ROOT` 两个 env 名；`result.resume_rejected` 语义；thinking levels 的 `{value}` 兼容形态。

### 4.3 `command` 执行器的最小差异（新增，`SPEC-plugins.md:239,197`）

- **无协议帧**：stdout 直接当 `text` 增量（或整段），stderr 只进诊断尾部；退出码 0 → `succeeded`，非 0 → `failed`+`exit_nonzero`；`sessionId` 恒 null → **无续接、无 resume_rejected**。
- **argv 模板**：配置里存 `string[]`，占位符只允许 `{prompt}`/`{model}`/`{effort}`/`{cwd}`/`{context}`（`SPEC-plugins.md:197`）。`{prompt}` 必须替换成**独立 argv 元素**或改走 stdin（配置 `promptMode: 'argv' | 'stdin'`），禁止拼进含空格的命令串。
- **Windows `.cmd/.bat`**：固定 `cmd /c <script> <args...>` 包装（`SPEC-plugins.md:197`），不接受任意 shell 拼接；依赖 sdk 的 `needsShell` 等价能力。
- **取消**：无 cancel 帧 → 直接进 SIGTERM→SIGKILL 两阶段（复用 shared 骨架，`writeCancel` 传 `() => false`）。
- **probe/detect**：probe 可退化为「解析得到 + `--version` 有输出」；detect 用配置的候选命令列表 + 扫描目录（`host/executable.ts:65-83` 的等价能力）。
- **权限**：dsh 的 `DSH_PERMISSION_MODE` 无对应物；需要拍板「映射成 env / argv / 忽略」（§8）。
- 参考实现口径：autoloop 的 `plugins/command`（仓库内无，属外部参照，`SPEC-plugins.md:239`）。

## 5. `dsh.test.ts` 断言清单与搬迁

现状 1080 行 / 59 个 `it`。目标路径 `tests/plugins/executors/dsh/`（与 `tests/` 同构镜像规则：`AGENTS.md`「测试统一放 tests/」），建议拆 4 文件：
`tests/plugins/executors/dsh/probe.test.ts`、`models.test.ts`、`run.test.ts`、`frames.test.ts`；
会话/续接相关若抽 shared，则 `tests/plugins/shared/{jsonl,model-id,outcome}.test.ts`。

### 5.1 断言清单（测试名 : 行号）

| #   | 行   | 测试名                                                 | 断言要点                                             | 搬迁处置                                                                   |
| --- | ---- | ------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | 132  | parseModelId 拆分 provider/model 并解码百分号转义      | 拆分 + decode                                        | 移 shared 后随函数搬                                                       |
| 2   | 143  | parseModelId 格式不合法返回 null                       | 空/无斜杠/边界/坏转义                                | 同上                                                                       |
| 3   | 155  | probe 命令解析不到：unavailable，path 为 null          | error 含 PATH、未 spawn                              | 保留（sdk.resolve 打桩）                                                   |
| 4   | 167  | probe 就绪：读版本 + --probe 帧，字段齐全              | 6 字段 + `checkedAt` + argv 断言                     | 保留；argv 断言改断 sdk.spawn 入参                                         |
| 5   | 207  | 版本读取失败不阻断探测                                 | cliVersion/pluginVersion null                        | 保留                                                                       |
| 6   | 222  | 版本输出无 semver                                      | cliVersion null，state ready                         | 保留                                                                       |
| 7   | 237  | probe 帧缺 protocol_version                            | unavailable、protocolVersion null                    | 保留                                                                       |
| 8   | 252  | 协议版本不兼容                                         | protocolVersion=2、error 含「协议版本」              | 保留                                                                       |
| 9   | 268  | runtime 不是 dsh                                       | unavailable                                          | 保留（防错 profile）                                                       |
| 10  | 283  | 无 probe 帧且非零退出                                  | 错误含退出码+stderr                                  | 保留                                                                       |
| 11  | 299  | 无 probe 帧正常退出                                    | 提示 `--probe`                                       | 保留                                                                       |
| 12  | 313  | 探测超时：杀进程树                                     | killedTrees>0                                        | 保留；改断 sdk kill                                                        |
| 13  | 324  | collect 收尾幂等（error 后 close）                     | 只收口一次                                           | 保留                                                                       |
| 14  | 337  | spawn 抛错                                             | error 含「启动探测失败」+EPERM                       | 保留                                                                       |
| 15  | 352  | models 帧解析：thinking 两形态/ provider 兜底/ default | 2 项、字段精确相等                                   | 保留                                                                       |
| 16  | 396  | 模型目录为空抛错                                       | `/模型目录为空/`                                     | 保留                                                                       |
| 17  | 405  | 非零退出带 stderr                                      | `/退出码 2…boom/`                                    | 保留                                                                       |
| 18  | 415  | models 超时抛错                                        | 文案含 5ms                                           | 保留                                                                       |
| 19  | 422  | models spawn 抛错                                      | `/启动失败…nope/`                                    | 保留                                                                       |
| 20  | 431  | 命令不存在                                             | `/PATH/`                                             | 保留（sdk.resolve）                                                        |
| 21  | 440  | 成功：execute 帧 + 事件顺序 + usage/output/session     | 帧全等、env 两变量、事件 6 条 seq 1..6、`stdinEnded` | 帧断言保留；env 断言改断 `sdk.config`/runtime 行                           |
| 22  | 557  | result 无 output 回退 text 累计                        | output='abc'                                         | 保留                                                                       |
| 23  | 568  | result=failed 取帧内 code/message                      | error='model_error: 额度不足'                        | 保留                                                                       |
| 24  | 588  | result=failed 无 error 文本兜底                        | error 含 `status=failed`                             | 保留                                                                       |
| 25  | 600  | result=cancelled                                       | status/errorCode/error='已取消'                      | 保留                                                                       |
| 26  | 613  | result=timeout                                         | status='timeout'                                     | 保留但**输出层变化**：插件 Receipt 只有 failed+errorCode=timeout（见 5.3） |
| 27  | 623  | 未知 result 状态                                       | failed                                               | 保留                                                                       |
| 28  | 633  | 无 result 非零退出                                     | `exit_nonzero`+退出码+stderr                         | 保留                                                                       |
| 29  | 647  | 无 result 正常退出                                     | `no_result`+「终态结果」                             | 保留                                                                       |
| 30  | 658  | 未 ready 即退出                                        | `protocol_error`+「未就绪」                          | 保留                                                                       |
| 31  | 667  | protocol_error 帧                                      | 含 `bad: 帧坏了`                                     | 保留                                                                       |
| 32  | 679  | 协议版本不符                                           | `protocol_error`+「协议版本」                        | 保留                                                                       |
| 33  | 690  | ready 帧 runtime 非 dsh                                | `protocol_error`                                     | 保留                                                                       |
| 34  | 699  | 忽略 request_id 不匹配/无效 JSON/未知帧                | 仍 succeeded、零事件                                 | 保留                                                                       |
| 35  | 715  | 订阅方抛错不影响执行                                   | succeeded                                            | 保留（io.emit 打桩抛错）                                                   |
| 36  | 733  | resume_rejected 透传                                   | resumeRejected=true、sessionId='new-session'         | 保留；重试断言属 host 适配器（`tests/host/executor*`）                     |
| 37  | 754  | 取消：cancel 帧→SIGTERM→SIGKILL                        | 帧尾部 type=cancel、killedTrees 两步、终态 cancelled | 保留（迁移清单 8 证据）                                                    |
| 38  | 779  | 超时：cancel 协议 + timeout 终态                       | cancel 帧、超时文案、exitCode null                   | 保留                                                                       |
| 39  | 797  | 超时收尾后 close 幂等                                  | 二次 finish 早退                                     | 保留                                                                       |
| 40  | 814  | flush 期间 abort：closed 直接返回                      | status failed、不杀树                                | 保留                                                                       |
| 41  | 833  | 进程已关闭后不再杀树                                   | killedTrees=[]                                       | 保留                                                                       |
| 42  | 849  | 命令解析不到 → spawn_failed                            | 未 spawn                                             | 保留                                                                       |
| 43  | 860  | spawn 抛错 → spawn_failed                              | error 含 EPERM                                       | 保留                                                                       |
| 44  | 869  | execute 帧写入失败 → spawn_failed + 终止               | killedTrees=[{pid}]                                  | 保留                                                                       |
| 45  | 880  | 无 pid 时 child.kill 兜底                              | killed=['SIGTERM','SIGKILL']                         | 保留（要求 sdk 仍给 pid 可空）                                             |
| 46  | 897  | signal 已取消：不启动进程                              | children=0                                           | 保留                                                                       |
| 47  | 906  | 模型 id 非法 → run_failed 不启动                       | error 含 provider/model                              | 保留                                                                       |
| 48  | 917  | 子进程 error 事件 → spawn_failed                       | error 含 EACCES                                      | 保留                                                                       |
| 49  | 926  | 帧字段缺省：空值兜底不多发事件                         | 事件仅 status/tool_call/tool_result                  | 保留                                                                       |
| 50  | 953  | 常量与协议版本对齐 v1                                  | 6 个常量 >0、版本=1                                  | 保留（常量随插件导出）                                                     |
| 51  | 964  | parseModelId 两侧空白段非法                            | `%20/a`→null                                         | 移 shared                                                                  |
| 52  | 969  | 探测无 pid 时 child.kill 兜底                          | killed 含 SIGKILL                                    | 保留                                                                       |
| 53  | 981  | 被信号杀掉（code null）文案可读                        | 「探测退出码 null」                                  | 保留                                                                       |
| 54  | 994  | 不注入 spawn 也能給结论                                | probe/list/run 三条降级                              | **不再适用**（sdk 必注入，见 5.3）                                         |
| 55  | 1004 | error 之后再 close 只收口一次                          | spawn_failed                                         | 保留                                                                       |
| 56  | 1015 | 取消后立刻退出，宽限定时器停手                         | killedTrees=[]                                       | 保留                                                                       |
| 57  | 1033 | 非对象 JSON / 缺字段帧                                 | failed、零事件                                       | 保留                                                                       |
| 58  | 1051 | 写入失败且无 pid → child.kill                          | killed=['SIGKILL']                                   | 保留                                                                       |
| 59  | 1061 | models 无斜杠 id provider 空、非字符串 label 回落      | provider=''、label=id                                | 保留                                                                       |

### 5.2 连带搬迁

| 现测试                                                        | 行/证据                               | M3 去向                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/main/ai-workflow/runtime/registry.test.ts`             | `registry.test.ts:3,6-37`             | 删除，换成 `tests/plugins/registry.test.ts`（id 唯一、kind 合法、capabilities 在枚举内、必填齐全，`SPEC-plugins.md:278`）+「新增协议只写插件」契约测试 |
| `tests/main/ai-workflow/runtime/detect.test.ts`               | `detect.test.ts:38`                   | 拆给各插件 `detect()`：`tests/plugins/executors/*/detect.test.ts`；「零副作用」断言（`detect.ts:24-33`）保留                                           |
| `tests/main/ai-workflow/runtime/executor-port.test.ts`        | `executor-port.test.ts:3,43-83`       | `createRuntimeExecutors` 消失；保留 `tests/host/executor.test.ts`（适配器归一见 5.3），新增「registry → forRuntime」装配测试                           |
| `tests/host/boot.test.ts` 的 `createRuntimeExecutors` mock    | `boot.test.ts:27,114,156,179,348,503` | 改 mock `createExecutorRegistry(...)`                                                                                                                  |
| `tests/main/ai-workflow/runtime/{process,executable}.test.ts` | 目录列表                              | 随 `host/process                                                                                                                                       | executable` 原样保留（M2 已在 host，refactor-plan.md:87） |

### 5.3 插件化后不再适用 / 需换等价物的断言

| 问题断言                                                              | 行                         | 原因                                                                         | 等价替代                                                                                                         |
| --------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 「不注入 spawn 依赖时也能用默认实现」                                 | 994-1002                   | 插件不再有 `deps.spawn` 缺省；sdk 必注入                                     | 改成「sdk.resolve 返回 null」三条降级（等价覆盖「未安装 CLI」）                                                  |
| 一切 `depsOf(h)` 注入 `spawn/killTree/now/sessionRoot/timeouts/grace` | 123-127（以及几乎全部 it） | `DshDeps` 注入面被 sdk 取代（`dsh.ts:38-52` → `SPEC-plugins.md:46-63`）      | 建 `fakeSdk({spawn,killTree,now,config})` 夹具，断言内容不变；`timeouts/grace` 改经 manifest `config` 或插件常量 |
| `env.DSH_PERMISSION_MODE` / `env.MULTICA_DSH_SESSION_ROOT`            | 472-477                    | 值来源从 `DshDeps` 变 `ExecutorContext.runtime` + `sdk.config`               | 断言改为「fake sdk.config 返回 sessions 根 → spawn env 含此值」；permissionMode 断 runtime 行传入                |
| `result=timeout` → `status:'timeout'`                                 | 613-621                    | `Receipt.status` 只有三值（`protocol/executor.ts` 与 `SPEC-plugins.md:173`） | 断言插件输出 `status:'failed'` + `errorCode:'timeout'`（等价于 host 适配器 `src/host/executor.ts:72-73` 的归一） |
| `DshRunRequest.runtime` 六字段直传                                    | 102-110, 112-121           | 入参变 `Turn` + `ExecutorContext.runtime`                                    | `runtime()` 夹具改 `{turn, ctx}`；`workdir` 语义见 §8-1                                                          |
| probe/models 以 `{command, profile}` 调用                             | 157-160 等                 | 端口签名变 `probe(ctx)`/`models(ctx)`（`SPEC-plugins.md:140-142`）           | 断言不变，调用参数换成 `ExecutorContext`（须先升 `EXECUTOR_PORT_VERSION`，`protocol/executor.ts:22`）            |
| `parseModelId`/常量导出位置                                           | 5-18                       | 若 `parseModelId` 进 `plugins/shared/`                                       | import 路径改为 `src/plugins/shared/model-id`；`DSH_PROTOCOL_VERSION` 等仍在 dsh 插件导出                        |

## 6. 插件 manifest 与运行时配置字段

### 6.1 `src/plugins/executors/dsh/manifest.ts`（按 `SPEC-plugins.md:71-104`）

```ts
{
  id: 'dsh',
  kind: 'executor',
  name: 'DeepSeek Harness',
  version: '1.0.0',              // 对应 refactor-plan M3；协议版本另见 DSH_PROTOCOL_VERSION
  description: 'dsh --stdio JSONL 协议：探测 / 模型目录 / 执行 / 终止',
  capabilities: ['spawn', 'fs.read'], // spawn=子进程 + 杀树；fs.read=可执行文件 stat/解析
  config: [
    { key: 'command',        label: '命令',     type: 'text',   required: true,  default: 'dsh' },
    { key: 'profile',        label: 'Profile',  type: 'text',   required: true,  default: 'multica' },
    { key: 'permissionMode', label: '权限模式', type: 'select', options: [...PERMISSION_MODES] },
    { key: 'model',          label: '模型',     type: 'text' },
    { key: 'reasoningEffort',label: '推理强度', type: 'text' },
    { key: 'workdir',        label: '工作目录', type: 'text' },
  ],
}
```

`command` 执行器同理，另加 `argv: string[]`（模板）、`promptMode: 'argv' | 'stdin'`。

### 6.2 运行时配置（`Runtime` 行，`src/protocol/entities.ts:64-86`）

| 字段                        | 现状                                                                           | M3                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `command`                   | `text`                                                                         | 保留（dsh 插件 `configFields` 声明）                                                                                                     |
| `profile`                   | `text`                                                                         | 保留（dsh 专属字段，command 插件无）                                                                                                     |
| `permissionMode`            | `select`，取值 `PERMISSION_MODES`（`entities.ts:33`）                          | 保留；dsh 映射 `DSH_PERMISSION_MODE`                                                                                                     |
| `model`                     | `text`（provider/model）                                                       | 保留；表单由插件 `models()` 填充                                                                                                         |
| `reasoningEffort`           | `text`                                                                         | 保留；选项来自 `models()[].thinkingLevels`                                                                                               |
| `workdir`                   | `text`，null=主进程 cwd                                                        | 保留；**与 `Turn.cwd` 的优先级要拍板**（§8-1）                                                                                           |
| `maxConcurrent` / `enabled` | 调度/启停                                                                      | 不动（内核 + host/scheduler）                                                                                                            |
| `protocolFamily`            | 枚举 `PROTOCOL_FAMILIES=['dsh']`（`entities.ts:28`）                           | **新增 `executorKey: string`** 选插件；`protocolFamily` 降级为兼容字段或随 DB CHECK 一起退场（`SPEC-plugins.md:107` 要求枚举硬编码消失） |
| —                           | `executorKey` 现由 `runtime.protocolFamily` 推导（`kernel/decide.ts:267,415`） | 改为读运行时配置的 `executorKey`；缺省回落 `protocolFamily`（存量数据迁移）                                                              |

## 7. M3 不能动 / 必须保住的行为（对应迁移清单 8/9/10）

| 条  | 行为                                                                                                                    | 现状证据                                                                                                                                                      | 插件化后受威胁点                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 8   | 取消时序：`cancel` 帧 → 3s → SIGTERM → 2s → SIGKILL；Windows `taskkill /T /F`；30 分钟超时同流程                        | `dsh.ts:756-766`、`dsh.ts:849-855`、`host/process.ts:54-74`、测试 `dsh.test.ts:754-795`、宿主超时值 `host/scheduler.ts:133,293`                               | sdk 无杀树能力（§2）；`shell:true` 的 `.cmd` 场景下 pid 可能不是真实 CLI 进程（需要 taskkill /T 才能覆盖）          |
| 9   | probe：`ready` 需 `v=1` / `protocol_version=1` / `runtime=dsh`；create 先探测失败不落库；update 保存后重探；detect 只读 | `dsh.ts:403-429`；`src/main/ai-workflow/ipc.ts:138-160`（create）、`162-172`（update）、`124-132`（probeAndSave）、`178`（detect）；`runtime/detect.ts:24-33` | `detect` 归插件后仍须「不 spawn、不写库、不读版本」；probe 判据不得因「插件已按协议族选中」而删掉 runtime 校验      |
| 10  | 聊天：续接只发新消息、`resume_rejected` 用完整历史重试一次、同一对话只跑一轮                                            | `dsh.ts:575,622-624,779,885`；重试 `host/executor.ts:138-163`；`fallbackPrompt` `protocol/executor.ts:44-49` + `host/scheduler.ts:292`                        | 插件直接实现 `ExecutorPort` 会把重试挤出 host（见 §0-4）；「同一对话只跑一轮」在 kernel/scheduler，不动             |
| 附  | 终态归一表 + 10 个 errorCode 语义不变                                                                                   | `dsh.ts:772-834`、`protocol/entities.ts:219-230`、`host/executor.ts:72-82`                                                                                    | timeout→failed 的折法、`chat` 失败补「执行失败」（`host/executor.ts:96`）不得丢                                     |
| 附  | `run_events` seq 单调、`output` = text 汇总                                                                             | `dsh.ts:707-715,773`                                                                                                                                          | 事件改经 `io.emit` 后 seq 由宿主分配（`protocol/executor.ts:63-67`），插件内的 seq 递增要么保留要么删干净，不能两套 |
| 附  | prompt 永不进 argv                                                                                                      | `dsh.ts:719,874-881`                                                                                                                                          | command 执行器的 `{prompt}` 占位约束（`SPEC-plugins.md:197`）                                                       |
| 附  | 子进程 pid 立即上报（崩溃对账）                                                                                         | `dsh.ts:696-697`；`io.process` `protocol/executor.ts:69-72`                                                                                                   | sdk 的 Spawned 必须暴露 pid（可空，回落 child.kill 路径要留）                                                       |
| 附  | stderr 截尾 4000 进诊断                                                                                                 | `dsh.ts:36,860,268`                                                                                                                                           | 白名单 env 变更后错误文案仍需带 CLI 原始诊断                                                                        |

## 8. 待拍板问题（5 个）

1. **`Turn.cwd` 与 `runtime.workdir` 谁赢**：现状 spawn cwd 与 execute 帧 cwd 都取 `runtime.workdir ?? undefined / process.cwd()`（`dsh.ts:202-206,878`），而宿主传的 `Turn.cwd` 来自 `run.cwd = runtime.workdir ?? ''`（`kernel/decide.ts:269,417`，`host/scheduler.ts:286`）。插件同时拿到两者，若照搬 `turn.cwd` 会拿到 `''` → spawn ENOENT。建议 `ctx.runtime.workdir ?? (turn.cwd || undefined)`。
2. **`resume_rejected` 重试放哪**：插件 `run()` 直接返回 `Receipt` 后，`host/executor.ts:117-163` 的「换新会话 + 完整历史重试一次」没有落点。建议 host 侧保留一层 `wrapReceipt(retry)`，插件只上报 `resumeRejected` 标志；否则每个执行器插件都要重写一遍。
3. **sdk 杀树与可执行解析的形状**：是 `sdk.process.killTree(pid, signal)` + `sdk.process.resolve(command)` 两条独立能力，还是把 `resolve`+`shell`+`killTree` 全塞进 `sdk.process.spawn` 返回的句柄（`handle.killTree(signal)`）？后者更少漏，但要改 `SPEC-plugins.md:51-57` 的 sdk 契约。
4. **env 白名单口径**：现状全量 `process.env` 透传（`dsh.ts:197,236`）。`SPEC-plugins.md:67` 要求宿主白名单。需要一份「执行器基线白名单」（至少 PATH/HOME/USERPROFILE/APPDATA/LOCALAPPDATA/SystemRoot/TEMP/COMSPEC/LANG + 插件声明的键），否则真实 CLI 会因缺环境而失败。
5. **`protocolFamily` 枚举怎么退场**：`PROTOCOL_FAMILIES=['dsh']` 是协议/DB CHECK/UI/detect 四处硬编码的根（`protocol/entities.ts:28`，`detect.ts:22`，`runtime/registry.ts:32-46`，`kernel/decide.ts:267,415`）。M3 只做 `executorKey` 字段还是同步放宽枚举？「契约只许新增」（`refactor-plan.md:112`）与「枚举硬编码消失」（`SPEC-plugins.md:107`）在这里冲突，需定取舍。

## 附：M3 开工前必须一起改的配置（否则 `pnpm check` 直接红）

| 文件                       | 现状                                                          | 需要                                                                                                                                |
| -------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tsconfig.node.json:19-37` | include 无 `src/plugins/**`、`src/sdk/**`、`tests/plugins/**` | 补三条 include，否则新目录不参与类型检查、覆盖率也不计                                                                              |
| `eslint.config.mjs:28-140` | 只约束 renderer/main/host/kernel                              | 新增 `src/plugins/**`（禁 import `host/**`、其它插件、`electron`）与 `src/sdk/**`（只依赖 `protocol`）两段；`tests/plugins/**` 同步 |
| `vitest.config.mts:14`     | `include: tests/**/*.test.{ts,tsx}`                           | 无需改（新目录自动纳入）                                                                                                            |
| 覆盖率基线                 | 99.73/97.78/100/100（`CONSTRAINTS.md:68`）                    | dsh 整文件搬家后行号全变，改动行门禁按「搬家视为改动」需重新计；建议先搬文件再改行为，分两次提交                                    |
