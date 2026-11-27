---
type: plan
status: active
---

# 计划：脚本阶段（Script Stage）

> 2026-11-13 起草。回答一个问题：**阶段能不能选「执行脚本」而不是智能体**——例如审查前先跑测试。
> 状态：**M40 已实施（2026-11-13）**，M41（脚本实体复用）与 M42（同阶段前置脚本）未开工。实施口径与偏离见文末「实施记录」。**2026-11-13 补**：D5 已撤销——命令只来自运行时连接，`StageScript.command` / `Turn.command` 已删除，见文末「命令只来自运行时」。
> 关联：[ARCHITECTURE](../ARCHITECTURE.md)（派活单位、执行器不是派活目标）、[SPEC-kernel](../specs/SPEC-kernel.md)（阶段 / 闸门 / 调度）、[SPEC-plugins](../specs/SPEC-plugins.md)（executor 端口与 `Turn`）、[plan-stage-exits](./archive/2026-Q4/plan-stage-exits.md)（出口表）、[flexible-workflow-plan](./flexible-workflow-plan.md)（「卡边界不卡步骤」）。

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
| UI   | 类型下拉加「执行脚本 / 脚本闸门」；脚本块（运行时只列命令执行器、命令、参数、工作目录、超时、环境变量）；`ScriptLinesField` 用本地原文避免半行被格式化擦掉；`pruneByEntryKind` 认两种脚本类型；看板 / 任务详情 / 重跑对脚本阶段同口径；`model/stage-script.ts` 纯函数                                                                                                                                    | `src/renderer/src/apps/ai-workflow/**`                                  |
| 文档 | ARCHITECTURE「派活单位」与术语、SPEC-plugins 派活链与 `Turn`、SPEC-kernel 的 `entry_mode` 与闸门段                                                                                                                                                                                                                                                                                                       | `docs/**`                                                               |

### 与计划的偏离（都以「不破坏既有不变量」为准）

1. **`StageScript` 带 `runtimeId`（必填）而不是自动挑第一条命令运行时**：内核不认识 `'command'` 这个字符串，也不扫盘；表单预填第一条命令执行器，真配错了的失败模式是「闸门拿不到 `exitCode`，停在原地」，可见可诊断。
2. **`script` 在 `WorkflowStage` / `RunRow` 上是可选字段**：与 `instructions` / `acceptance` / `runTimeoutMs` 同口径（老事实按 null 归一），避免为了加一个字段去改所有测试夹具。
3. **`normalizeRun` 落在 `host/store/projection-apply.ts`（投影边界）而不是 `kernel/project.ts`**：该文件本来就是 run 行的第二道防线（`normalizeAgent` / `normalizeTask` 同处），重建与增量共用一条归一。
4. **结算归一放在 `kernel/commands/run.ts#scriptGateSettled`**：`command` 执行器对非 0 退出的 `failed/exit_nonzero` 归类不变（非闸门脚本阶段要靠它走 `errored`），只在闸门阶段翻成 `succeeded` 让 `failed` 边可达。
5. **脚本闸门不采信脚本自报的 `verdict`**：结论只取 `exitCode`；脚本仍可 echo 回执块上报 `notices` / `findings`，但那些不参与闸门判定。
6. **UI 的脚本类型拆成两项**（「执行脚本」与「脚本闸门」）：闸门在本项目里一直是「类型下拉里的一项 + `judge` 开关」的形态，脚本闸门沿用同一交互，而不是让人先选脚本再单独找判定开关。
7. **环境变量的值在解析时 `trim()`**：界面按 `KEY=VALUE` 一行一个，行内两侧空白没有语义。

### 验证

- 全量 **196 测试文件 / 3415 用例全绿**；覆盖率 **99.82 / 99.04 / 99.85 / 99.92**（按 [CONSTRAINTS](../../CONSTRAINTS.md) EX-011 登记，阈值 98/93/95/98 与门禁强度不变）。
- 改动行 **168/170 = 98.82%**（门槛 90%）。
- `pnpm check:fast` 各门（类型 / lint / floor / secrets / ui）exit 0。
- 新增用例覆盖：脚本阶段派活（快照 / 无智能体 / access=full / 提示词只有资料 / 缺脚本与缺运行时零事实 / 无项目回落脚本 cwd）、脚本闸门三条（0 / 非 0 / 拿不到退出码）、非闸门脚本阶段的 `errored` 边、超时优先级、`workflow.create/update` 的落库与引用校验与 `sameScript`、调度器 `Turn`（command/args/env/无模型/脚本超时）、`command` 执行器（命令与 argv 覆盖、空提示词不写 stdin）、表单纯函数与编辑器脚本块。

## 补口（2026-11-13，M40 实测 BUG）

**症状**：新建运行时选执行器「命令」→ 保存报「执行器不支持探测: command」，一条命令运行时都建不出来；工作流编辑器里选「执行脚本」后运行时下拉恒空，保存报 `input.stages[N].script.runtimeId必填`。**两层是同一个空洞**：M40 让脚本阶段的连接必须是 `executorKey='command'` 的运行时，而这条运行时在真实环境里没有任何创建路径。

| 根因                       | 位置                                             | 说明                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command` 插件没有 `probe` | `packages/plugins/executor-command/src/index.ts` | `runtime.create` 先探测后落库，`probe` 缺失一律 `unsupported`；`command` 也没有 `detect`（不产出候选），所以一条 `executorKey='command'` 的运行时既建不出、也检不到，只有 e2e 直接塞 DB 才有 |
| 编辑器空候选只留死路       | `WorkflowEditor.tsx` 脚本块                      | 候选恒空 → 下拉选不了 → `runtimeId=''`，最后由协议层 `requiredId` 甩一句路径式错误                                                                                                           |
| 编辑既有脚本阶段丢配置     | `WorkflowEditor.tsx#toDraft`                     | 没回传 `script`，脚本块整块不渲染，保存时又以「设为执行脚本时必须填写命令」整份拒收                                                                                                          |

**修法**

1. `packages/plugins/executor-command/src/probe.ts`（新）：只解析 `runtime.command`（`sdk.process.resolve`）与 `argsTemplate`，**不 spawn**——通用命令没有统一的版本旗标，猜一个只会把「没实现 `--version`」误报成不可用。空命令给「命令必填」。装配进 `commandPlugin.probe`。
2. `RuntimeDialog`：命令空就前端拦（清掉从前端到内核的一次无用往返）。
3. `WorkflowEditor`：`validateDraft` 收脚本运行时候选，脚本阶段没选 / 所选运行时已停用或被删都就地指出并展开该阶段；脚本块在候选为空时给出「去运行时页新建一条」的文案；`toDraft` 回填 `script`。
4. 表单口径（本轮需求）：脚本两项都不展示「要干什么」「单轮超时」（脚本没有提示词；脚本自带超时且优先级更高），脚本闸门另外不展示「验收」（判据是退出码，**M41 撤销：脚本闸门恢复验收**，见文末补口）；保存时随 `pruneByEntryKind` 归一成空，不留看不见的残留配置。内核的「脚本闸门最多一条验收」上限**已删除**（M41）。
5. `command` 的展示名从「命令」改成「通用命令」：运行时表单里已经有一个「命令」输入框，同名会让人以为「选不了命令」。

**验证**：新增 `tests/plugins/executors/command/probe.test.ts`（6 例）、注册表一条「command 必须自带 probe」的不变量、编辑器 5 条（回填 / 两条脚本类型不渲染三块并归一 / 无候选指路 / 运行时停用文案）、运行时表单一条命令必填；旧用例「插件只实现 run（不给 probe）」按新契约改写。

## 命令只来自运行时（2026-11-13，M40 实测 UI 反馈）

三条反馈都出在脚本阶段的编辑面上。前两条是排版，第三条是口径：**既然选了运行时，就以运行时为准——阶段上不能再输入命令**。

| 反馈                                                                   | 根因                                                                                                                                | 修法                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型下拉选「脚本闸门（判定）」（8 个全角字，当时的最长项）时文案被截断 | 类型 `Field` 固定 `w-36`（144px），减掉 `px-3` 与 chevron 只剩约 96px，放不下 8 个全角字，`select-value` 的 `line-clamp-1` 直接裁掉 | 宽度提到 `w-44`（176px），按最长类型文案留够                                                                                                                                                          |
| 「运行时」与「命令」不在一条水平线上                                   | 脚本块那一行是 `items-end`，而「命令」带常驻 `hint`：底对齐把输入框顶高了一行                                                       | 命令字段删除后该行只剩「运行时」，`items-start` + 命令说明整行铺开；「工作目录 + 超时」保持原行不动                                                                                                   |
| 已选命令执行器运行时（如 npm / pnpm）还要再填一遍命令                  | 首版让 `Turn.command` 覆盖 `runtime.command`，于是阶段上也有一条命令：同一个可执行文件两处可写，谁生效取决于实现细节                | **删字段而不是改提示**：`StageScript.command` 与 `Turn.command` 一起删掉，命令唯一来源是运行时连接（`runtime.command`）；脚本块只把运行时命中的那条以说明文字读出来；所选连接自身没有命令时保存前拦住 |

**契约影响**

1. `protocol/entities.ts`：`StageScript` 去掉 `command`；`protocol/executor.ts`：`Turn` 去掉 `command`（`args` 保留——参数仍属阶段执行配置）。
2. `protocol/validate.ts`：`checkScript` 不再校验命令；多写的 `command` 键既不校验也不落库。
3. `host/scheduler.ts`：`turnOf` 不再搬运命令，脚本轮的可执行文件由执行器读 `runtime.command`。
4. `plugins/executors/command/run.ts`：`turn.command ?? runtime.command` → `runtime.command`。
5. `model/stage-script.ts`：`defaultScript` 不再带命令；新增 `cleanScript` 在保存时只保留当前契约字段，老数据 / 外部写入里的 `command` 键随保存脱落。
6. 编辑器：删除「命令」输入框，运行时命中命令以说明文字展示（`命令用运行时上的「pnpm」`），所选运行时命令为空时就地拦住并指出是哪条连接。
7. 类型下拉文案（2026-11-13）：`交给智能体` → `智能体`、`闸门（判定）` → `智能体闸门`、`脚本闸门（判定）` → `脚本闸门`；类型列宽 `w-44` 按「智能体闸门」留够。`TaskDialog` 里引用类型名的「「智能体」的阶段会立即执行」随之更新，`执行脚本` / `不交接` / `交给用户` 不动。

**验证**：`tests/protocol/validate.test.ts`（`command` 键被忽略）、`tests/host/scheduler.test.ts`（`Turn` 上没有 `command`、`script_json` 快照不含命令）、`tests/plugins/executors/command/command.test.ts`（可执行文件解析自 `runtime.command`，`resolvedIn` 断言）、`tests/kernel/decide.run.test.ts`、`tests/renderer/.../{WorkflowEditor,stage-script}.test.tsx`（无命令输入框 / 命令只读展示 / 运行时无命令被拦 / `cleanScript` 清掉遗留键）。

## 补口（2026-11-17，M41）：脚本闸门与智能体闸门共用证据口径

**起因**：一条使用反馈——「一个阶段只能跑一条命令，那 `node a.js` + `node b.js` 怎么办？」。这个问法本身是症状：真正缺的是**逐条验收的证据位**。M40 的脚本闸门只有「一个退出码 + 最多一条验收」（`stage-validation.ts` 的那条规则 + `gateVerdictOf` 只读 `run.exitCode`），于是只要多于一件事要证明，就只能去写 `c.js` 包装脚本、或者把流程切成命令清单——两个都比问题更糟（前者把闸门逻辑挪进不受模型管控的文件，后者回到「卡步骤」）。

**口径**（两条闸门一份证据，正式描述见 [SPEC-kernel](../specs/SPEC-kernel.md)「闸门」）：

| 情形                                   | `run.status`            | `exitCode` | 结论                                     |
| -------------------------------------- | ----------------------- | ---------- | ---------------------------------------- |
| 退出码 0，没给 `checks`                | `succeeded`             | 0          | `pass`（验收条目此时只是配置记录）       |
| 退出码 0，`checks` 全 0 且逐条覆盖验收 | `succeeded`             | 0          | `pass`                                   |
| 退出码 0，`checks` 里有非 0            | `succeeded`             | 0          | `fail`（证据说没过，不拿退出码替它翻案） |
| 退出码 0，`checks` 漏覆盖某条验收      | `succeeded`             | 0          | 没给结论（原地停、不消耗预算）           |
| 退出码非 0（闸门阶段）                 | `succeeded`（结算归一） | n          | `fail`，即使 `checks` 全 0               |
| 拿不到退出码（超时 / 被杀 / 起不来）   | `failed`                | `null`     | 没给结论                                 |

**改动面**

- `kernel/scopes/commands/run.ts`：`gateVerdictOf` 合并成一份证据判定（脚本分支 = 退出码硬结论 + 可选 `checks` 逐条核对），新增 `coversAcceptance`；智能体分支行为逐字不变。
- `kernel/scopes/workflow/stage-validation.ts`：删「脚本闸门最多一条验收条目」，脚本闸门与智能体闸门同受 `ACCEPTANCE_LIMITS` 约束。
- 编辑器：脚本闸门恢复「验收」块（`hasAcceptance` 认 `script-gate`），`pruneByEntryKind` 不再把脚本闸门的验收清空，文案改成「回执块 `checks` 逐条核对；不给只按退出码判」。「要干什么」「单轮超时」仍然不展示（脚本没有提示词，脚本超时优先）。

**这不是 steps**：一条命令仍是「一件事」。要让一件事有多条证据，通用做法是让命令在输出末尾给回执块（`applyReceiptBlock` 在 `command` 执行器里本来就会跑）：

```json
{
  "checks": [
    { "cmd": "node tsc.js", "exitCode": 0, "acceptance": 1 },
    { "cmd": "node test.js", "exitCode": 0, "acceptance": 2 }
  ]
}
```

**未做（下一批）**：`StageScript.steps[]`（同一连接上多组 argv，执行器逐条 spawn、逐条产 `checks`）——把这份回执块搬进阶段配置，同时消掉手写包装脚本；以及 `scripts` 表（M41 原计划）与闸门试跑（`script.tryrun`）。

**验证**：`tests/kernel/decide.run.test.ts`（脚本闸门 6 条：全 0 覆盖 / 漏覆盖原地停 / 证据非 0 判 fail / 无证据按退出码 / 退出码非 0 压过证据 / 超时没结论）、`tests/kernel/scopes/workflow/stage-validation.test.ts`（脚本闸门多条验收放行）、`tests/renderer/.../WorkflowEditor.test.tsx`（脚本闸门展示与保存验收、空验收文案）。`pnpm check:fast` 全门 exit 0。

## 补口（2026-11-17，M42）：脚本变成步骤序列 + 脚本窗口按连接

**起因**：M41 让脚本闸门能消费回执块里的 `checks`，但一份「类型检查 + 单测 + lint」还是要手写一个包装脚本去 echo 回执块——证据是真的，脚本文件却是模型管不到的第二份真相源。这一步把组合搬进阶段配置：**同一连接上的 N 组 argv**，每步实测一条退出码。

**契约**

```ts
export interface ScriptStep {
  label: string // 证据标签，落 checks[].cmd（空串 = 执行器用「命令 + 参数」拼）
  args: readonly string[] // 逐项 argv，不经 shell
  acceptance?: number // 1 基验收序号；省略 = 与验收无关的环境检查
}

export interface StageScript {
  runtimeId: string // 连接唯一：命令仍只来自 runtime.command
  steps: readonly ScriptStep[] // 1..8 步，按顺序执行
  cwd: string | null
  env: Record<string, string>
  timeoutMs: number | null // **整轮预算**（所有步骤共用），不是每步
  runAll?: boolean // 缺省 true：全部跑完再判；false = 首个非 0 即停
}

// Turn：args → steps + runAll（缺省用运行时 argsTemplate 展开成一步）
export interface TurnStep {
  label: string
  args: readonly string[]
  acceptance?: number
}
```

| 取舍               | 选择                  | 理由                                                                                                   |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------ |
| 命令是否跟着步骤走 | **否**，步骤只给 argv | 一条命令两处可写就是第二份真相源（M40 撤 `command` 的同一条理由）。要跑别的可执行文件 = 另建一条运行时 |
| 超时按步还是按轮   | **按轮**              | 看板上「这一轮最多跑 10 分钟」才是人能预判的承诺；按步会变成「10 分钟 × 8」                            |
| 失败停不停         | 缺省全跑，可关        | 闸门要的是证据完整性；日常快反馈才关（关掉后证据不全，闸门会显示少了哪条）                             |
| 自报 `checks`      | 被实测覆盖            | 执行器手里有真实退出码，没有理由再采信 echo 出来的                                                     |

**内核 / 执行器**

- `gateVerdictOf` 的脚本分支不变形：退出码是硬结论（非 0 = fail、`null` = 没给结论），退出码 0 时再按 `checks` 逐条核对验收（M41 已落）。M42 只让 `checks` 变成「实测」而不是「自报」。
- `stage-validation#validateScriptAcceptance`：脚本闸门声明验收时，**每条验收都要有步骤指向它**；先查「步骤指向不存在的验收」（第 n 条越界），再查「第 n 条验收没有步骤指向它」。
- `sameScript` 逐字段比 `steps`（含顺序、label、acceptance、逐项 argv）与 `runAll`。
- `command` 执行器：逐步 spawn，多步时每步在输出与事件流里带 `## 步骤标签` 段头；整轮预算耗尽 → 不再开新步骤、按 `timeout` 收口（`exitCode=null`）；聚合退出码 = 首个非 0；提示词只在第一步写 stdin（脚本读 stdin 的老行为）。
- 投影 `normalizeScript`（`host/store/projection-apply.ts`）：老事实的 `args` 归一成「一步」、`runAll` 缺省 true，`args` 键随之脱落；不需要新列，也不需要动 `KERNEL_VERSION`（重建即归一）。

**并发窗口（P0 修复）**：`pickClaims` 原来把所有脚本 run 挂在 `agentId=null` 这一个键上、窗口 1 —— 等于**全系统脚本共用一个并发位**，一条 `pnpm test` 就让别的工作流的 lint 闸门干等。改成脚本 / 脏行（`agentId=null`）按 `runtimeId` 计窗口（每连接 1 个），智能体仍按 `maxConcurrent`；线程闸门保持，且**只有两道闸门都过了才占位**（原来先占位后判线程会让被挡掉的候选吃掉并发位——M42 实现过程中被 `decide.thread` 的既有用例当场抓住）。

**验证**：`tests/plugins/executors/command/command.test.ts`（10 例：单步证据 / 多步分段与逐条 checks / 默认全跑 / 首个失败即停 / 整轮预算 / 自报被覆盖 / stdin 只喂第一步 / 模板退回不产 checks）、`tests/kernel/scopes/workflow/stage-validation.test.ts`（验收 ↔ 步骤对应三条）、`tests/kernel/decide.run.test.ts`（脚本窗口按连接 2 例）、`tests/kernel/decide.test.ts`、`tests/host/scheduler.test.ts`（`Turn.steps` + `runAll` + 快照）、`tests/host/store/projection-apply.test.ts`（老 `args` → 一步）、`tests/renderer/**`（编辑器步骤列表 / 验收序号 / 跑法 / `cleanScript` 升级）。

**未做（下一批）**：`scripts` 表与复用（原 M41 计划）、闸门试跑（`script.tryrun`）、步骤拖拽排序（当前只能删了重加）、同阶段「先脚本后智能体」的 precheck。

## 补口（2026-11-17，M49）：判定证据落库、无结论留痕、脚本配置复制

**起因**：M42 把脚本闸门的证据从「一个退出码」扩到「每步一条 `checks`」，但 `checks` 只在结算时被读一次——`RunRow` 没有这个字段、`run.receipt` 也不产事实，脚本闸门跑完 3 步后，界面上只剩 `output.md` 里的 `## 标签` 段和一句「退出码 2」。**证据生成即丢弃**，恰好把「脚本比智能体准确」的立足点（可核对）丢掉了。同一轮还补了两个小口子：闸门原地停下时不说话、同一套脚本配置在多个阶段各抄一遍。

**口径**

| 改动            | 落点                                               | 说明                                                                                                                                                                                          |
| --------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 证据随 run 落库 | `Run.checks` / `runs.checks_json` / `normalizeRun` | 结算时从回执带（空证据不写键，投影统一补 `[]`）；老事实 / 非闸门轮次为 `[]`；列走 `RUN_M2_ADDED_COLUMNS` 的 ALTER 路径，不递增 `KERNEL_VERSION`                                               |
| 任务详情证据表  | `TaskActivity#RunChecks`                           | 每行：标签 / 退出码 / 对应第 n 条验收；没有证据不占版面                                                                                                                                       |
| 无结论留痕      | `noConclusionCommentText` + `stageTransitionFacts` | 只在「判定没给结论且任务没离开本阶段」时追加一条 `task.comment_added`：拿不到退出码（带 errorCode）/ 第 n 条验收没有全 0 证据（带本轮证据条数）/ 证据不足。跟着去向走（errored 出口）不加噪音 |
| 复制脚本配置    | 编辑器脚本块「复制自」                             | 同草稿里其它有步骤的脚本阶段，整套复制 steps / cwd / env / timeout / runAll（连接不在候选里时保留原连接）；`ScriptLinesField` 按刷新代号重挂载，避免本地原文盖住新值                          |

**为什么不是卡**：闸门停下需要的是「知道为什么 + 一个可读的下一步」，不是又一个要人点的选项；卡片要回答语义（选项 → 命令），成本是 comment 的十倍，先不加。

**验证**：`tests/kernel/decide.run.test.ts`（证据随 `run.succeeded` 落库、四种「没给结论」都留痕、文案三分支）、`tests/host/store/projection-apply.test.ts`（`checks_json` 落库与老行补 `[]`）、`tests/renderer/.../TaskActivity.test.tsx`（证据表两行 / 无证据不渲染）、`tests/renderer/.../WorkflowEditor.test.tsx`（整套复制 + 重挂载）、`tests/protocol/entities.test.ts`（IPC 形状锁：`Run.checks` 可选）。
