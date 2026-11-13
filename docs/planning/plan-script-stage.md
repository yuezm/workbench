# 计划：脚本阶段（Script Stage）

> 2026-11-13 起草。回答一个问题：**阶段能不能选「执行脚本」而不是智能体**——例如审查前先跑测试。
> 状态：**M40 已实施（2026-11-13）**，M41（脚本实体复用）与 M42（同阶段前置脚本）未开工。实施口径与偏离见文末「实施记录」。
> 关联：[ARCHITECTURE](../ARCHITECTURE.md)（派活单位、执行器不是派活目标）、[SPEC-kernel](../specs/SPEC-kernel.md)（阶段 / 闸门 / 调度）、[SPEC-plugins](../specs/SPEC-plugins.md)（executor 端口与 `Turn`）、[plan-stage-exits](plan-stage-exits.md)（出口表）、[flexible-workflow-plan](flexible-workflow-plan.md)（「卡边界不卡步骤」）。

## 结论

阶段执行者从「只能是智能体」扩成「智能体或脚本」。脚本不是第五类插件、不是新的 `purpose`、不是新的派活路径——它就是第二个**执行目标**，走同一条 `run.queued → claimed → receipt → 出口表` 生命周期。

真正的收益不在「省一次模型调用」，在**闸门结论从模型自述换成进程退出码**：现在闸门要求模型在回执里自报 `checks[].exitCode`，脚本阶段能给出真实退出码。

```
阶段「自测」  进入方式 [执行脚本 ▾]  命令 pnpm  参数 check
  出错时     主去向 [停在这里等人 ▾]
  通过时     主去向 [代码评审 ▾]
  未通过时   主去向 [编码实现 ▾]
  判定       [x] 由脚本退出码给结论
```

这一阶段零 LLM：测试失败直接回编码阶段，通过才进评审，评审者拿到的上下文里已经有脚本输出的尾部。

## 目标 / 非目标

| 目标                                                           | 非目标                                 |
| -------------------------------------------------------------- | -------------------------------------- |
| 有确定退出码的阶段（测试 / lint / 构建 / 部署检查）零 LLM 跑完 | 脚本派活（`spawn` / `ask` / `events`） |
| 脚本失败按出口表回退，与智能体阶段同一套边                     | 脚本会话续接                           |
| 脚本输出进线程上下文，成为下一阶段资料                         | 用脚本编排流程（把阶段切成命令清单）   |
| 判定结论来自真实退出码                                         | 脚本里再调 agent                       |

## 现状缺口（锚点）

| 位置                                   | 现状                                                     | 缺口                                   |
| -------------------------------------- | -------------------------------------------------------- | -------------------------------------- |
| `protocol/entities.ts:245`             | `ENTRY_MODES = ['none','agent','user']`                  | 没有「执行脚本」                       |
| `protocol/entities.ts:422`             | `WorkflowStage` 只有 `agentId`                           | 没有脚本字段                           |
| `kernel/task-effects.ts:87`            | `if (!stage \|\| stage.entryMode !== 'agent') return []` | 派活入口硬编码智能体                   |
| `kernel/task-effects.ts:88-91`         | agent / runtime 缺失即零事实                             | 脚本没有对应分支                       |
| `kernel/run.ts:78`                     | 并发窗口只按 `agentId` 算                                | 脚本 run 没有窗口                      |
| `kernel/commands/run.ts:94`            | `gateVerdictOf(receipt, stage)` 只认模型自报             | 拿不到退出码即「没给结论」             |
| `kernel/commands/run.ts:262`           | `stageTimeoutOf` 只读阶段                                | 脚本超时无处配                         |
| `host/schema.ts:78`                    | `entry_mode CHECK (... 'none','agent','user')`           | 加值必须物理重建表                     |
| `host/scheduler.ts:396`                | `turnOf(run, agent, …)` 强制智能体                       | 脚本 run 走不通                        |
| `plugins/executors/command/run.ts:110` | 参数只取 `runtime.argsTemplate`                          | 脚本参数无处放                         |
| `plugins/executors/command/run.ts:294` | 无条件写 stdin                                           | 脚本秒退时 EPIPE 被当成 `spawn_failed` |
| `renderer/.../WorkflowEditor.tsx:763`  | 类型下拉三档                                             | 缺「执行脚本」                         |

`entryMode` 是 DB CHECK 约束，SQLite 改不了 CHECK——**M40 必然触发 `workflow_stages` 一次性物理重建**。现有重建路径就是给这件事准备的（`schema.ts:573` `STAGES_REQUIRED_COLUMNS` + `host/db.ts` 的差集检测），把新列加进必须列即可，不写迁移脚本。

## 设计决策

| 编号   | 决策                                                                                                | 理由 / 取舍                                                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D1** | 新增 `entryMode='script'`，不做第五类插件                                                           | 脚本没有协议帧、没有会话、没有 `probe/models`，进插件体系只会产生一堆 `if (kind==='script')`。执行器 `command` 已经是「跑一条命令并读回退出码」，缺的只是「谁来决定跑什么」                      |
| **D2** | 脚本与智能体对称：**连接**在运行时，**执行配置**在目标上                                            | 沿用 M27 的分家口径；脚本的 `args/env/cwd/timeout` 与智能体的 `model/effort/env/workdir` 同层                                                                                                    |
| **D3** | `run.purpose` 不变，脚本 run 仍是 `'stage'`                                                         | `thread-context` 的「最近一轮产出」只取终态 `purpose='stage'`，脚本输出自动成为下一阶段资料；artifacts / 帧批 / 结算 / 出口表全部零改动复用                                                      |
| **D4** | 脚本闸门用 `exitCode` 给结论；闸门阶段的非 0 退出在结算时归一回 `succeeded`，业务结论交给 `verdict` | 真实退出码优于自述；不归一的话 `command` 执行器报的 `failed` 会让脚本闸门永远走 `errored`、`failed` 边成死代码。`exitCode=null`（超时 / 被杀）按「没给结论」处理，原地停、不消耗 `maxFails` 预算 |
| **D5** | `Turn` 新增 `command` / `args` 两个执行配置字段                                                     | 命令本体随阶段走（`pnpm` / `node` / `pwsh` 各不相同），不为一脚本建一条运行时。代价：`Runtime.command` 从「唯一命令来源」降为「缺省命令」，SPEC-plugins 补一句                                   |
| **D6** | `prompt === ''` 时不写 stdin                                                                        | 脚本不读 stdin；秒退脚本上写已关闭的管道会抛错，被 `command` 执行器当成 `spawn_failed`——这是必须修的一行，否则脚本阶段随机失败                                                                   |
| **D7** | 脚本 run 的「最近一轮产出」取**尾部** N 行                                                          | 测试日志的失败信息在尾部，头部是最没用的 banner；全文照常落 `artifacts/.../output.md`                                                                                                            |
| **D8** | M40 用**内联** `stage.script`，M41 才抽 `scripts` 表                                                | 先打通「脚本能跑、退出码能给结论」；中间态丑一点，但端到端可验。与 M19（文案）→ M20（DDL）的节奏一致                                                                                             |

## 契约（M40）

```ts
// protocol/entities.ts
export const ENTRY_MODES = ['none', 'agent', 'script', 'user'] as const

/** 脚本配置上限：与 argsTemplate 同口径（逐项 argv，不经 shell） */
export const SCRIPT_LIMITS = { maxArgs: 20, maxArgChars: 500 } as const

/**
 * 阶段脚本（M40 内联）：一条命令 + 参数。提示词不参与——
 * 脚本没有 systemPrompt、没有模型、没有会话。
 */
export interface StageScript {
  /** 连接：必须指向 executorKey='command' 的运行时（表单预填第一条，用户可改） */
  runtimeId: string
  /** 命令名或绝对路径（宿主按 PATH 解析；找不到即 spawn_failed） */
  command: string
  /** 逐项 argv；不允许 {prompt} / {model} / {effort}（脚本没有这些概念） */
  args: readonly string[]
  /** null = 项目文件夹 > 宿主默认目录 */
  cwd: string | null
  env: Record<string, string>
  /** null = 阶段 runTimeoutMs > 全局缺省；上限仍受 STAGE_TIMEOUT_LIMITS 约束 */
  timeoutMs: number | null
}

export interface WorkflowStage {
  entryMode: EntryMode // 加 'script'
  agentId: string | null
  /** M40：内联脚本（entryMode='script' 时必填，否则必须为 null） */
  script: StageScript | null
  // …既有字段全部不变
}

export interface StageInput {
  entryMode: EntryMode
  agentId?: string | null
  script?: StageScript | null
  // …既有字段全部不变
}

/** 脚本 run 的执行配置随 run 行落库（与 prompt / cwd / access 同口径：历史轮次自包含） */
export interface RunRow {
  /** 与阶段上的值逐字相同（快照）；连接已在 `runtimeId` 列，这里多带的那个字段不读 */
  script: StageScript | null
  // …既有字段全部不变
}
```

```ts
// protocol/executor.ts
export interface Turn {
  /** 命令覆盖（脚本阶段）：缺省用运行时连接上的 command */
  command?: string
  /** argv（脚本阶段）：缺省用运行时的 argsTemplate 展开 */
  args?: readonly string[]
  // …既有字段全部不变
}
```

M41 在 `StageScript` 旁边加实体 `Script`（`id/name/runtimeId/args/cwd/env/timeoutMs/enabled/createdAt`），阶段上加 `scriptId: string | null`，与内联 `script` 二选一。

## 内核改动（5 处）

**1. 派活入口**（`kernel/task-effects.ts:87`，唯一入口：人工拖拽 / 建任务 / 回执流转 / 规则建任务全部经它）

```ts
// 1) 解析执行目标
const isScript = stage.entryMode === 'script'
const agent = isScript ? undefined : view.agents.get(stage.agentId ?? '')
const script = isScript ? (stage.script ?? undefined) : undefined
if (isScript ? !script : !agent) return []

// 2) 解析连接：脚本用自己声明的运行时（必填，内核不猜、不扫盘）
const runtime = view.runtimes.get(isScript ? script.runtimeId : agent.runtimeId)
if (!runtime) return []
```

内核不认识 `'command'` 这个字符串：`runtimeId` 必填，表单在新建脚本时预填第一条命令执行器运行时；内核只判「运行时存在」，不判它是不是命令执行器（见下面「不校验 `executorKey`」）。

脚本分支写进 run 行的四处差异：

```ts
agentId: isScript ? null : agent.id,
script: isScript ? script : null,
cwd: project?.path ?? (isScript ? script.cwd : agent.workdir) ?? '',
access: isScript ? 'full' : runAccessOf(stage, agent.permissionMode),
prompt: isScript ? scriptContextText(task, stage) : taskPrompt(...),
resumeSessionId: null,   // 脚本无会话
```

`scriptContextText` 只放资料：任务标题 / 描述 / 阶段说明 / 验收条目 / 上轮产物路径。脚本通常不读 stdin，这段文本是给「run 详情页」看的。

**2. 校验**（`kernel/workflow/stage-validation.ts:26-33`）

```
entryMode='script' 且 script 为空        → 阶段「X」设为执行脚本时必须填写命令
entryMode='script' 且 agentId 非空        → 阶段「X」只能选一个执行目标（归一成 agentId=null）
judge 存在且 entryMode 不在 {agent,script} → 阶段「X」设为判定时必须交给智能体或脚本
脚本闸门 acceptance 超过 1 条              → 阶段「X」的脚本闸门最多一条验收条目
script.command 为空 / args 越界 / 未知占位符 → 沿用 argsTemplate 的文案句式
script.runtimeId 查不到                   → 阶段「X」的脚本运行时不存在（在 `commands/workflow.ts:159` 旁按 view 判，与 `agentId` 同法）
```

**不校验 `executorKey`**：内核不认识 `'command'`。UI 的运行时下拉按 `runtimes.executors()` 过滤，只列命令执行器；真配错了（脚本挂到 dsh 运行时），执行器会按自己的协议跑一轮、回执没有 `exitCode`，闸门拿 `null` 停在原地——可见、可诊断、不危险。

**3. 并发窗口**（`kernel/run.ts:78`）

```ts
const limit =
  run.agentId === null
    ? 1 // 脚本 run：固定 1 个并发位
    : (view.agents.get(run.agentId)?.maxConcurrent ?? 1)
```

脚本默认并发 1；线程闸门（缺省 1）已经保证同一线程串行。

**4. 结算归一**（`kernel/commands/run.ts` 结算分支，`:366` 附近）

`command` 执行器把非 0 退出报成 `run.status='failed'`（`errorCode='exit_nonzero'`）——这是「执行器没跑好」的归类。但**闸门阶段的非 0 退出是业务没过**，两者必须分开，否则脚本闸门的 `failed` 边永远走不到、只会走 `errored`。

```ts
// 结算前归一：脚本闸门阶段「跑完了但没过」按 succeeded 落，业务结论交给 verdict
const scriptGate = run.script !== null && (stage?.judge ?? null) !== null
if (scriptGate && settled.status === 'failed' && settled.errorCode === 'exit_nonzero') {
  settled = { ...settled, status: 'succeeded', error: null, errorCode: null }
}
```

非闸门脚本阶段不动：非 0 退出仍是 `failed` → `errored` 边（命令跑挂了就是跑挂了）。

**5. 闸门判定**（`kernel/commands/run.ts:94`，签名多收 `run`；调用点 `:374`）

```ts
function gateVerdictOf(
  receipt: Receipt,
  stage: WorkflowStage,
  run: RunRow,
): GateVerdict | undefined {
  // 脚本闸门：真实退出码即结论，不需要模型自报 checks
  if (run.script !== null) {
    if (run.exitCode === null) return undefined // 超时 / 被杀 = 没给结论
    return run.exitCode === 0 ? 'pass' : 'fail'
  }
  // …既有口径（verdict + checks + acceptance 覆盖）
}
```

**超时**（`kernel/commands/run.ts:262`）：

```ts
return run.script?.timeoutMs ?? stage?.runTimeoutMs ?? limits.runTimeoutMs
```

## 脚本闸门的两个轴

| 情形                                  | 落库 `run.status`                               | `exitCode` | guard     |
| ------------------------------------- | ----------------------------------------------- | ---------- | --------- |
| 进程跑完、退出码 0                    | `succeeded`                                     | `0`        | `passed`  |
| 进程跑完、退出码非 0（**闸门阶段**）  | `succeeded`（结算归一，业务结论交给 `verdict`） | `n`        | `failed`  |
| 进程跑完、退出码非 0（非闸门阶段）    | `failed` + `exit_nonzero`                       | `n`        | `errored` |
| 命令找不到 / spawn 失败 / 超时 / 被杀 | `failed`                                        | `null`     | `errored` |

口径：**「跑完了」是执行轴，「过没过」是业务轴**。脚本闸门把退出码翻译成业务结论，非闸门脚本阶段只回答「命令跑没跑成」。`failed` 消耗 `judge.maxFails` 预算，`errored` 不消耗。

## 宿主改动

**投影**（`host/schema.ts`）

- `workflow_stages` 加 `script_json TEXT NOT NULL DEFAULT 'null'`；`entry_mode` CHECK 加 `'script'`
- `runs` 加 `script_json TEXT NOT NULL DEFAULT 'null'`
- `STAGES_REQUIRED_COLUMNS`（`:573`）加 `script_json` → 旧库首启一次性物理重建（`entry_mode` 的 CHECK 同时换成四档）
- `KERNEL_VERSION → M40.0.0`（`kernel/types.ts:62`）

**投影读写**

- `host/store/views.ts:81/96`（stage 行形状）、`:308-315`（JSON 列还原）、`:548-551`（SELECT 列清单）
- `host/store/views.ts:446-469`（run 行还原）、`:635`（`RUN_COLUMNS`）
- `host/store/projection-apply.ts:83-124`（`RUN_FIELDS` 加 `['script','script_json']`）
- `kernel/project.ts:75-97`（`normalizeStage` 补 `script: null`）；**新增 `normalizeRun`**——runs 的三条写路径（`run.queued`、`run.*` 整行演进、`snapshot.imported`）现在都是原样 `put('runs', payload.run)`，老事实没有 `script` 键，重建时会往 `NOT NULL` 列绑 NULL 直接报错；`normalizeRun` 与 `normalizeStage` 同法补默认值，三条路径都过它

**调度器**（`host/scheduler.ts`）

```ts
const targetOf = (run: RunRow) =>
  run.script !== null
    ? ({ kind: 'script', script: run.script } as const)
    : ({ kind: 'agent', agent: agentOf(run) } as const)

const turnOf = (run: RunRow, target: Target, signal: AbortSignal): Turn => ({
  /* …既有… */
  command: target.kind === 'script' ? target.script.command : undefined,
  args: target.kind === 'script' ? [...target.script.args] : undefined,
  model: target.kind === 'agent' ? modelOf(target.agent) : null,
  effort: target.kind === 'agent' ? target.agent.reasoningEffort : null,
  env: target.kind === 'agent' ? target.agent.env : target.script.env,
})
```

`start()`（`:621`）里 `agentOf` 的兜底分支改成 `targetOf`；脚本为空时落 `settleFailed(run, 'run_failed', '脚本配置不存在')`，与智能体缺失同口径。运行时不存在 / 停用 / 执行器未注册三条兜底不变（脚本也受 `runtime.enabled` 管）。

**执行器**（`plugins/executors/command/run.ts`，两处）

```ts
const command = turn.command ?? runtime.command
const template = turn.args ? [...turn.args] : parseArgsTemplate(runtime.argsTemplate)
// …
if (!promptInArgs && turn.prompt !== '') {
  child.stdin?.write(turn.prompt)
  child.stdin?.end()
}
```

`{prompt}` 在脚本阶段不可能出现（`Turn.prompt` 是资料段，脚本模板里禁用它），`.cmd/.bat` 的 BatBadBut 防护照旧生效。

## UI

| 位置                              | 改什么                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowEditor.tsx:763` 类型下拉 | 加「执行脚本」；选中时清 `agentId`，切走时清 `script`                                                                                                   |
| `WorkflowEditor.tsx` 阶段详情     | 脚本块：运行时（下拉只列 `executorKey='command'`，默认第一条）/ 命令 / 参数（一行一个，逐项 argv）/ 工作目录 / 环境变量 / 超时；提示「退出码 0 = 通过」 |
| `WorkflowEditor.tsx:747` 判定开关 | 脚本阶段也允许打开；文案改成「由脚本退出码给结论」，隐藏 `checks` 相关说明                                                                              |
| `TaskCard.tsx:25` `HINTS`         | 加 `script: '等待执行脚本'`                                                                                                                             |
| `KanbanBoard.tsx:178`             | 脚本阶段的新建提示改成「这一列会立即执行脚本」                                                                                                          |
| `TaskDetailPage.tsx:107`          | 「重新执行」对脚本阶段同样可用（`entryMode !== 'user' && !== 'none'`）                                                                                  |
| 运行列表                          | 脚本 run 显示命令与退出码，不显示模型 / token 用量                                                                                                      |

## 事实与投影

- M40 **不新增事实类型**：`stage.created` / `stage.updated` 是整行演进，`script` 随行落库；`run.queued` 的 `RunRow` 自带 `script` 快照。
- M40 投影变更：`workflow_stages.script_json`、`runs.script_json`、`entry_mode` CHECK 四档、`KERNEL_VERSION → M40.0.0`。
- M41 才引入 `script.created` / `script.updated` / `script.removed` 与第 17 张投影表 `scripts`。

## 里程碑

| #       | 内容                                                                                        | 可独立上线 | 回滚                                                                                      |
| ------- | ------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| **M40** | `entryMode='script'` + 内联 `stage.script` + `Turn.command/args` + 脚本闸门 + 尾部输出 + UI | 是         | 列留空即关；已配脚本的阶段在回滚后 `entryRunFacts` 返回零事实，任务**停住等人**，不会乱跑 |
| **M41** | 抽 `scripts` 表 + 设置页「脚本」+ `stage.scriptId` 弱引用 + 复用                            | 是         | 表可删；阶段回落内联                                                                      |
| **M42** | `stage.precheck`（同阶段先脚本后智能体）                                                    | 否         | —                                                                                         |

M40 与 M41 之间不要长期停顿：M40 的阶段脚本写在阶段里，改一条命令要改每个用到的工作流。M41 上线后内联字段保留为「一次性覆盖」，常用命令搬进设置页的 `scripts` 表按引用复用（`scriptId` 与内联 `script` 二选一，同时给由校验拒绝）。

## 改造清单（M40）

| 层   | 文件                                                                             | 改什么                                                                                                                        |
| ---- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 协议 | `src/protocol/entities.ts`                                                       | `ENTRY_MODES` 加 `script`；`SCRIPT_LIMITS`；`StageScript`；`WorkflowStage.script`；`StageInput.script`；`RunRow.script`       |
| 协议 | `src/protocol/executor.ts`                                                       | `Turn.command` / `Turn.args`                                                                                                  |
| 协议 | `src/protocol/validate.ts`                                                       | 阶段脚本形状校验（命令非空、args 项数/长度、env 键规则、超时范围、禁 `{prompt}`）                                             |
| 内核 | `src/kernel/workflow/stage-validation.ts`                                        | 四条新校验 + 判定允许 `script`                                                                                                |
| 内核 | `src/kernel/task-effects.ts`                                                     | 目标解析分支 + `scriptContextText`                                                                                            |
| 内核 | `src/kernel/commands/run.ts`                                                     | 结算归一（闸门脚本的非 0 退出 → `succeeded`）；`gateVerdictOf` 脚本分支；`stageTimeoutOf` 读脚本超时                          |
| 内核 | `src/kernel/run.ts`                                                              | `pickClaims` 脚本窗口                                                                                                         |
| 内核 | `src/kernel/commands/workflow.ts`                                                | `stageRow` 落 `script`；`sameStage` 加 `sameScript`；`script.runtimeId` 存在性校验（与 `:159` 的 `agentId` 同法）             |
| 内核 | `src/kernel/project.ts`                                                          | `normalizeStage` 补 `script: null`；**新增 `normalizeRun`**（三条 runs 写路径都过它）                                         |
| 内核 | `src/kernel/types.ts`                                                            | `KERNEL_VERSION → M40.0.0`                                                                                                    |
| 内核 | `src/kernel/thread-context.ts`                                                   | 脚本 run 的「最近一轮产出」取尾部 N 行                                                                                        |
| 投影 | `src/host/schema.ts`                                                             | `script_json` 两列；`entry_mode` CHECK 四档；`STAGES_REQUIRED_COLUMNS`                                                        |
| 投影 | `src/host/store/views.ts`                                                        | stage / run 行形状、JSON 还原、SELECT 列、`RUN_COLUMNS`                                                                       |
| 投影 | `src/host/store/projection-apply.ts`                                             | `RUN_FIELDS` 加 `script`                                                                                                      |
| 宿主 | `src/host/scheduler.ts`                                                          | `targetOf` + `turnOf` + `start()` 兜底                                                                                        |
| 插件 | `src/plugins/executors/command/run.ts`                                           | `turn.command` / `turn.args` 优先；空 prompt 不写 stdin                                                                       |
| UI   | `WorkflowEditor.tsx` / `TaskCard.tsx` / `KanbanBoard.tsx` / `TaskDetailPage.tsx` | 见「UI」                                                                                                                      |
| 文档 | `ARCHITECTURE.md:66`、`:211`、`SPEC-plugins.md:15`                               | 「派活目标始终是智能体」→「派活目标是配置层执行目标（智能体或脚本）；执行器只是协议适配。脚本不派活、不续会话、不产生提示词」 |

## 测试

- **`tests/kernel/workflow/stage-validation.test.ts`**：脚本阶段无 `script` 拒；`script` 与 `agentId` 同给归一；脚本闸门 acceptance 超 1 条拒；命令为空 / args 越界 / 禁占位符；`runtimeId` 查不到拒；首条错误优先。
- **`tests/kernel/decide.run.test.ts`**：脚本阶段进入产 `run.queued` 且 `agentId=null` / `access='full'` / `resumeSessionId=null` / `script` 快照完整；脚本缺失或运行时缺失 → 零事实；`pickClaims` 脚本窗口 1（既有「并发窗口按智能体」用例旁加一组）。
- **`tests/kernel/decide.run.test.ts`（闸门段，:1648 起既有用例旁）**：`gateVerdictOf` 脚本分支——exit 0 → `pass`、exit 1 → `fail`、exitCode `null` → `undefined` 且不消耗 `maxFails`；结算归一——闸门脚本 `failed`/`exit_nonzero` 落成 `succeeded` 并走 `failed` 边、非闸门脚本仍走 `errored` 边；脚本闸门 `acceptance` 1 条被 exit 0 覆盖；脚本回执块自报 `verdict=pass` 但 exitCode 非 0 时仍判 `fail`；`stageTimeoutOf` 优先级（脚本 > 阶段 > 全局）。
- **`tests/kernel/project.test.ts`**：`normalizeStage` / `normalizeRun` 老事实补 `script: null`；两次归一幂等。
- **`tests/host/scheduler.test.ts`**：脚本 run 的 `Turn`（`command`/`args` 来自 run 行、`model=null`、`env` 取脚本）；脚本 run 不存在时落兜底终态；运行时停用仍挡住脚本 run。
- **`tests/plugins/executors/command/command.test.ts`**：`turn.args` 覆盖 `runtime.argsTemplate`；`prompt=''` 不写 stdin（用秒退假进程验证不产生 `spawn_failed`）；`.cmd/.bat` 仍拒绝 `{prompt}`。
- **`tests/host/store/{views,runs-projection,rebuild}.test.ts`**：新列读写；旧库重建后 `script` 全 `null` 且与旧表等价；`entry_mode` CHECK 四档。
- **`tests/kernel/thread-context.test.ts`**：脚本 run 的产出段取尾部。
- **UI**：`stage-draft.test.ts` 切类型清空互斥字段；`WorkflowEditor` 脚本块增删。
- 覆盖率门槛不变（`stage-machine.ts` 分支 100%）；`pnpm check` 全绿。

## 行为变更与回滚

1. `entryMode` 多一档：老工作流的阶段行为逐字不变（`script: null`）。
2. 脚本阶段的 `run.access` 恒为 `full`——脚本是用户自己写的命令，不设沙箱档位。
3. 脚本闸门阶段的非 0 退出落 `succeeded` + `verdict='fail'`（不是 `failed`）：这是「跑完了但没过」，与智能体闸门自报 `fail` 同形，出口表与预算口径因此完全复用。
4. 回滚：`script_json` 列可留空；`entry_mode='script'` 的行在回滚后仍存在于投影（列还在），但旧内核的 `entryRunFacts` 认不出这个模式 → 零事实 → 任务停在列里等人。**不会派给空智能体，也不会崩**。
5. `KERNEL_VERSION` 回退需要重建投影；上线前备份 DB（沿用既有口径）。

## 风险

| 风险                               | 表现                                         | 对策                                                                                             |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 流程被切成命令清单                 | 每个小步骤一个脚本阶段，回到「卡步骤」老毛病 | 脚本只用于**可机检的验收点**；编排仍交给智能体阶段的 `spawn`                                     |
| 退出码语义被夸大                   | `pnpm check` 绿 ≠ 功能正确                   | 脚本闸门的 acceptance 文案必须写「这条命令全绿」，不写「功能正确」；功能判定仍要人或有模型的闸门 |
| 日志灌爆上下文                     | `pnpm test` stdout 数 MB                     | 全文落 artifacts；上下文只给尾部 N 行                                                            |
| 脚本自报 `verdict=pass` 绕过退出码 | 脚本 echo 一个回执块                         | 闸门优先用 `exitCode`，脚本回执块的 `verdict` 不参与脚本闸门判定                                 |
| 每脚本一条运行时                   | 配置层膨胀                                   | `Turn.command` 让一条 `command` 运行时承载所有脚本；M41 的 `scripts` 表只管复用                  |

## 不做

- 不新增第五类插件（脚本不是 `executor` 插件）。
- 不新增 `purpose`（脚本 run 仍是 `stage`）。
- 不让脚本派活：回执的 `spawn` / `ask` / `events` 对脚本 run 一律忽略（M40 先只读 `exitCode` 与 `output`）。
- 不做脚本市场 / 脚本版本管理（M41 只做名称 + 复用）。
- 不把 `precheck` 塞进 M40（同阶段脚本→智能体的 run 链会污染轮次计数与会话策略，单独一步）。

## 实施记录（M40，2026-11-13）

| 层   | 落地内容                                                                                                                                                                                                                                                                                                                                                                                                 | 主要文件                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 协议 | `ENTRY_MODES` 加 `script`；`StageScript` / `SCRIPT_LIMITS` / `SCRIPT_FORBIDDEN_PLACEHOLDERS`；`WorkflowStage.script` / `StageInput.script` / `RunRow.script`（均为可选，老事实按 null 归一）；`Turn.command` / `Turn.args`；`validate.ts` 的 `checkScript` / `checkScriptArgs`（命令必填、args 20×500、`{prompt}/{model}/{effort}` 拒绝、env 复用智能体口径、超时同阶段范围）                            | `src/protocol/{entities,executor,validate}.ts`                          |
| 内核 | `stage-validation` 四条新校验（脚本必填、判定允许 script、脚本闸门 ≤1 条验收）；`task-effects` 的执行目标解析（`entryTargetOf`）与 `scriptContextText`；`gateVerdictOf` 脚本分支 + `scriptGateSettled` 结算归一；`stageTimeoutOf` 脚本优先；`stageRow`/`sameStage`/`sameScript`/`sameEnv`/`missingScriptRuntime`；`view-spec` 的 `workflow.create/update` 补 `runtimes` 切片；`KERNEL_VERSION → M40.0.0` | `src/kernel/**`                                                         |
| 投影 | `workflow_stages.script_json` / `runs.script_json`（`NOT NULL DEFAULT 'null'`）、`entry_mode` CHECK 四档、`STAGES_REQUIRED_COLUMNS` + `RUN_M2_ADDED_COLUMNS` 补列、重建拷贝 SQL、`normalizeStage` / `normalizeRun` / `runValue` 的脚本列                                                                                                                                                                 | `src/host/{schema,db}.ts`、`src/host/store/{views,projection-apply}.ts` |
| 宿主 | `targetOf` 取代「必须有智能体」：脚本轮从 run 行快照取执行配置（`command`/`args`/`env`，模型与思考强度置空），缺失时落 `run_failed` 兜底                                                                                                                                                                                                                                                                 | `src/host/scheduler.ts`                                                 |
| 插件 | `command` 执行器：`turn.command` 覆盖连接命令、`turn.args` 逐项原样传参（不展开占位符）、`prompt` 为空不写 stdin                                                                                                                                                                                                                                                                                         | `src/plugins/executors/command/run.ts`                                  |
| UI   | 类型下拉加「执行脚本 / 脚本闸门（判定）」；脚本块（运行时只列命令执行器、命令、参数、工作目录、超时、环境变量）；`ScriptLinesField` 用本地原文避免半行被格式化擦掉；`pruneByEntryKind` 认两种脚本类型；看板 / 任务详情 / 重跑对脚本阶段同口径；`model/stage-script.ts` 纯函数                                                                                                                            | `src/renderer/src/apps/ai-workflow/**`                                  |
| 文档 | ARCHITECTURE「派活单位」与术语、SPEC-plugins 派活链与 `Turn`、SPEC-kernel 的 `entry_mode` 与闸门段                                                                                                                                                                                                                                                                                                       | `docs/**`                                                               |

### 与计划的偏离（都以「不破坏既有不变量」为准）

1. **`StageScript` 带 `runtimeId`（必填）而不是自动挑第一条命令运行时**：内核不认识 `'command'` 这个字符串，也不扫盘；表单预填第一条命令执行器，真配错了的失败模式是「闸门拿不到 `exitCode`，停在原地」，可见可诊断。
2. **`script` 在 `WorkflowStage` / `RunRow` 上是可选字段**：与 `instructions` / `acceptance` / `runTimeoutMs` 同口径（老事实按 null 归一），避免为了加一个字段去改所有测试夹具。
3. **`normalizeRun` 落在 `host/store/projection-apply.ts`（投影边界）而不是 `kernel/project.ts`**：该文件本来就是 run 行的第二道防线（`normalizeAgent` / `normalizeTask` 同处），重建与增量共用一条归一。
4. **结算归一放在 `kernel/commands/run.ts#scriptGateSettled`**：`command` 执行器对非 0 退出的 `failed/exit_nonzero` 归类不变（非闸门脚本阶段要靠它走 `errored`），只在闸门阶段翻成 `succeeded` 让 `failed` 边可达。
5. **脚本闸门不采信脚本自报的 `verdict`**：结论只取 `exitCode`；脚本仍可 echo 回执块上报 `notices` / `findings`，但那些不参与闸门判定。
6. **UI 的脚本类型拆成两项**（「执行脚本」与「脚本闸门（判定）」）：闸门在本项目里一直是「类型下拉里的一项 + `judge` 开关」的形态，脚本闸门沿用同一交互，而不是让人先选脚本再单独找判定开关。
7. **环境变量的值在解析时 `trim()`**：界面按 `KEY=VALUE` 一行一个，行内两侧空白没有语义。

### 验证

- 全量 **196 测试文件 / 3415 用例全绿**；覆盖率 **99.82 / 99.04 / 99.85 / 99.92**（按 [CONSTRAINTS](../../CONSTRAINTS.md) EX-011 登记，阈值 98/93/95/98 与门禁强度不变）。
- 改动行 **168/170 = 98.82%**（门槛 90%）。
- `pnpm check:fast` 各门（类型 / lint / floor / secrets / ui）exit 0。
- 新增用例覆盖：脚本阶段派活（快照 / 无智能体 / access=full / 提示词只有资料 / 缺脚本与缺运行时零事实 / 无项目回落脚本 cwd）、脚本闸门三条（0 / 非 0 / 拿不到退出码）、非闸门脚本阶段的 `errored` 边、超时优先级、`workflow.create/update` 的落库与引用校验与 `sameScript`、调度器 `Turn`（command/args/env/无模型/脚本超时）、`command` 执行器（命令与 argv 覆盖、空提示词不写 stdin）、表单纯函数与编辑器脚本块。
