# 计划：闸门回执可靠性与提示词数据隔离

> 2026-11-21 起草。起因：线程 `0668c0f8` 第 5 轮（run `be923a5a`，阶段 Code Review）闸门没给结论，任务停在原地，界面只留一句「第 1 条验收没有全 0 的证据」。
> 状态：**已实施（2026-11-21）**：R1–R9 全部落地（PR-1…PR-5），PR-6（输出侧 sentinel）未做。实施口径与偏离见文末「实施记录」。
> 关联：[SPEC-kernel](../specs/SPEC-kernel.md)（闸门判定 / 线程上下文）、[SPEC-ai-workflow](../specs/SPEC-ai-workflow.md)（阶段与出口、提示词段序）、[SPEC-plugins](../specs/SPEC-plugins.md)（回执两通道）、[SPEC-host](../specs/SPEC-host.md)（artifacts 落盘）。

## 结论

这一轮**不是模型没做判断，也不是提示词格式坏了**：它确实调用了回执工具，`ask` / `findings` / `deliverables` 都在，但 `findings[].severity` 用了 review skill 的词汇（`Required` / `Optional` / `Nit`），协议只认 `blocker|high|medium|low`，`receiptFromObject` 一票否决把**整份回执**（连 `ask` 一起）丢掉了；而回执工具 server 不做校验、照样回「回执已收到」，模型于是在正文里写了「已发 gate-verdict 卡」——事实里从来没有这张卡。

四个独立缺陷按这个顺序修：

1. **回执校验不再一票否决**：逐键容错 + 阻塞键单独判（P0，立刻解除这类卡死）；
2. **工具不再假成功**：schema 带枚举、server 回可读的错误（P0，让模型当轮自纠）；
3. **闸门无结论可诊断、可补一轮**：文案分流 + 人工触发的「补一次回执」（P1）；
4. **提示词数据层隔离**：派生正文装进按内容算长的围栏，先截断后包裹（P1，结构从此不可能被结果内容改坏）。

## 事件与证据链

| 步  | 事实                                                                                                                            | 位置                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | `seq 185` `tool_call mcp__workbench__receipt`，3511 字符，`JSON.parse` 正常，键 `ask` / `findings` / `deliverables`             | `runs/be923a5a…/transcript.jsonl`                                    |
| 2   | `seq 186` `tool_result`：`回执已收到`，`isError:false`                                                                          | 同上                                                                 |
| 3   | `findings` 7 条 severity = `Required` / `Optional` / `Nit`；协议枚举 = `blocker                                                 | high                                                                 | medium | low` | `kernel` 段全部未收到 |
| 4   | `parseFindings` 返回 null → `receiptFromObject` 返回 null → **整块丢弃**                                                        | `packages/plugins/kit/src/receipt-fields.ts:182`                     |
| 5   | `state.receipt` 保持 null；正文又没有 ```json 块（模型以为工具已成功）                                                          | `packages/plugins/executor-dsh/src/frames.ts:111`                    |
| 6   | 内核 `verdict === undefined` → 零流转、不消耗 `gateFails`；M49 文案落到「第 1 条验收」分支                                      | `kernel/scopes/workflow/stage-machine.ts:188`、`commands/run.ts:205` |
| 7   | 产物其实**已落盘**（`prompt.md` / `transcript.jsonl` / `output.md` / `meta.json`），只缺 `review.md`（没有 verdict / findings） | `runs/be923a5a…/`、`host/host/src/artifacts.ts:139`                  |

另有两个非代码问题：提示词里落单的 ```（截断把围栏切开）、以及本机同时跑着两份 dev 实例共写 `.scratch/dev-data` 与 `out/server`。

## 问题清单

| ID  | 级别 | 症状                                                                                   | 根因                                                                                         |
| --- | ---- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| R1  | P0   | 一份合法回执因一个坏子字段被整块丢弃                                                   | `receiptFromObject` 全有或全无（`receipt-fields.ts:218`）                                    |
| R2  | P0   | 模型以为交上去了，正文宣称「已发卡」                                                   | 回执 server 不校验就回「回执已收到」（`receipt-mcp-server.cjs:110`）                         |
| R3  | P0   | 模型无从知道 `severity` 的合法值                                                       | 工具 schema 把 `findings` 声明成 `array of object`，无嵌套枚举（`receipt-tool.ts:52`）       |
| R4  | P1   | 「第 1 条验收没有全 0 的证据」把人引向补证据                                           | `noConclusionCommentText` 不区分「没有 verdict」与「pass 但漏覆盖」（`commands/run.ts:205`） |
| R5  | P1   | 卡住的闸门只能重跑整轮（重读仓库）或人工拖卡片                                         | 没有「同一会话、只补回执」的路径                                                             |
| R6  | P1   | 结果正文里的行首构造会改坏提示词结构（``` / `#` / `<div>` / `---` / `\|`）             | 派生正文平铺进 Markdown；截断按字符切，会切出落单围栏（`thread-context.ts:45`）              |
| R7  | P1   | 闸门要求「必须给 verdict」，回执段标题却写「（可选）」且说「照常结束、不报错」         | `RECEIPT_BLOCK_INTRO` / `heading(level,'回执块（可选）')`（`scopes/prompt.ts:114,131`）      |
| R8  | P1   | review skill 用 Critical/Required/Optional/Nit，协议用 blocker/high/medium/low，无映射 | `findings` 文案只有示例没有枚举（`protocol/receipt-keys.ts:89`）                             |
| R9  | P2   | 两个 `scripts/dev.mjs` 同时写同一个库与 `out/server`，旧实例 server 不监听             | dev 脚手架没有单实例保护                                                                     |
| R10 | P3   | 输出侧同样拿 Markdown 当协议（只认最后一个 ```json 块）                                | `receipt-block.ts` 解析口径                                                                  |

## 修复方案

### A. 回执校验闭环（R1 / R2 / R3 / R8）

**A1 逐键容错（P0，核心）**

`receiptFromObject` 改成「每个键独立校验，失败的键丢掉，其余照收」，并把丢掉的原因带出来：

```ts
export interface ReceiptParse {
  block: ReceiptBlock | null
  /** 校验不过、已被忽略的键（按 RECEIPT_KEYS 顺序） */
  dropped: { key: ReceiptKey; reason: string }[]
}

export function parseReceiptObject(parsed: unknown): ReceiptParse
```

- 单键失败只影响该键：`findings` 坏了不再连坐 `ask` / `deliverables`；
- 全部键都失败或一个键都没给 → `block: null`（与现口径一致）；
- `parseReceiptBlock` / `parseReceiptToolInput` 跟着返回 `ReceiptParse`，执行器只取 `block`；
- **不做部分合并**：一次调用内的键要么合法要么丢，避免「半张卡」；
- 文本通道丢掉键的后果只有「该键没生效」，不需要新增事实；工具通道由 A2 回给模型。

覆盖这次的回归用例：拿真实载荷（`ask` + 7 条 `Required/Optional/Nit` 的 `findings`）断言 `ask` 仍在、`findings` 被丢。

**A2 工具不再假成功（P0）**

`packages/plugins/kit/src/receipt-mcp-server.cjs`：

- `tools/call` 先做**最小校验**（只查协议枚举与必需形状，完整校验仍在内核侧）：
  - `verdict` ∈ `pass|fail`；
  - `findings[].severity` ∈ `blocker|high|medium|low`；
  - `checks[].exitCode` 是整数；
  - `ask[].options` 非空数组。
- 有问题的键 → 返回 `isError: true`，`content` 写清「哪个键、哪一项、合法值是什么、请重发完整回执」；
- 全通过 → 仍回「回执已收到」。

枚举是**手写镜像**（和现有 `RECEIPT_KEYS` 同一做法），加一条 parity 用例对着 `REVIEW_SEVERITIES` / `GATE_VERDICTS` 断言，防漂移。

执行器侧：工具通道改成**按键合并**（后到的覆盖同名键，不清空未提到的键），让模型只补修正那一块也能生效。

**A3 schema 带枚举（P0）**

`packages/plugins/kit/src/receipt-tool.ts` 的 `SCHEMA_OF` 补齐嵌套结构：

```jsonc
"findings": { "type": "array", "items": {
  "type": "object",
  "properties": {
    "key": {"type":"string","maxLength":32},
    "severity": {"type":"string","enum":["blocker","high","medium","low"]},
    "location": {"type":"string","maxLength":300},
    "claim": {"type":"string","maxLength":500},
    "evidence": {"type":"string","maxLength":2000},
    "requiredAction": {"type":"string","maxLength":500}
  },
  "required": ["key","severity","claim","requiredAction"]
}}
```

`ask` / `checks` / `deliverables` 同样把关键字段与枚举写进去。客户端若按 schema 校验，模型在**发起调用时**就会收到错误，比事后回执被丢好一个数量级。

**A4 文案同步（R8）**

`RECEIPT_KEY_DOCS.findings.text` 由 `REVIEW_SEVERITIES` 生成，并写明与 review skill 词汇的映射：

```
`severity` 只接受 blocker / high / medium / low。
Critical→blocker、Required→high、Optional→medium、Nit→low；
写别的词该条 `findings` 整块被忽略（不影响同回执的其它键）。
```

### B. 闸门无结论：诊断 + 补一轮（R4 / R5）

**B1 判定结果带原因（P1）**

`gateVerdictOf` 从 `GateVerdict | undefined` 改成判别式结果：

```ts
type GateOutcome =
  | { verdict: GateVerdict }
  | {
      noConclusion:
        | { kind: 'missing_verdict' } // 回执里没有 verdict/ask
        | { kind: 'no_checks' } // pass 但一条证据都没有
        | { kind: 'uncovered'; index: number } // pass 但第 n 条验收没被覆盖
        | { kind: 'no_exit_code'; errorCode: string | null }
    } // 脚本闸门拿不到退出码
```

`stageTransitionFacts` 用它，`noConclusionCommentText(stage, run, reason)` 按 reason 出文案：

| reason            | 文案                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `missing_verdict` | 「闸门「X」没给结论：本轮回执里没有 `verdict`（也没有 `ask`）。补一次判定，或让它重跑这一轮。」 |
| `no_checks`       | 「…给了 pass 但一条 `checks` 都没有；`pass` 必须有全 0 的证据。」                               |
| `uncovered`       | 保留现有「第 n 条验收没有全 0 的证据（本轮 m 条）」。                                           |
| `no_exit_code`    | 保留现有脚本闸门文案。                                                                          |

**B2 人工触发的「补一次回执」（P1）**

定位是**安全网**，不是主修。形态选择「同阶段新开一轮 run、续接同一会话」，不是复用同一 run：

- 复用同一 run 会让第二轮终态归档覆盖第一轮的 `output.md`（评审正文就没了）；
- 新 run 保留两轮产物，事实可审计，人看执行索引能分清「哪一轮是补回执」。

实现：

- 新命令 `task.reask`（`protocol/inputs.ts` + `kernel/decide.ts` + `kernel/scopes/view-spec.ts` + `commands/task.ts`），校验与 `task.rerun` 同源，但：
  - 提示词走**专用短文本**（不拼任务全文）：只说「上一轮缺回执，只补回执」+ 验收清单 + 三条分支（pass/fail/ask）；
  - `roundSession: 'resume'` 强制续接上一轮会话（否则 M28 的「第 2 轮开新会话」会从零重读仓库）；
  - 超时取阶段配置与 10 分钟的较小值。
- 额度：**不新增 `gate_asks` 列**（实施时改的口径）——按 `stageRoundCount(view, task, stage)` 判：该阶段只跑过一轮才允许补，补过一轮仍无结论就交给人。这样不动投影表、不递增 `KERNEL_VERSION`，也天然覆盖「人工重跑后再无结论」的情形。
- 不消耗 `gateFails`、不打 `gate:degraded`。
- UI：任务详情在「停在闸门且本轮无结论」时显示「让它补一次回执」按钮（与「重新执行」并列，文案区分）。
- **不做自动**：M34 已定「重跑只能由人触发」，先观察真实使用再议。

### C. 提示词数据层隔离（R6）

新增 `packages/core/kernel/src/scopes/markdown.ts`（纯函数）：

```ts
/** 围栏长度 = 内容里最长反引号游程 + 1（至少 3）：内容永远关不掉外层。 */
export function fenceFor(text: string): string

/** 派生正文 → 数据块。label 只传固定字面量。 */
export function dataBlock(label: string, body: string): string

/** 仍要当指令读的多行文本：只配平围栏，保证后续段不被吞。 */
export function balanceFences(text: string): string
```

应用点：

| 位置                           | 处理                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `precedingBlock` 正文节选      | `dataBlock('run <id> 正文节选', truncateBlock(...))`                             |
| 任务描述 / 阶段说明（多行）    | `balanceFences`（保留代码块的语义，只保证不吞后续段）                            |
| `reviewBlock` claim / 索引摘要 | 单行且已在行中（`- [R1] …` / `· 摘要`），无需包裹；可选把连续反引号压到 2 个以内 |
| `artifactBlock` / 路径行       | 系统生成，无风险                                                                 |

**顺序不变量**：先截断、后包裹。围栏长度按「已截断的文本」算，截断点落在反引号中间也不会提前闭合；反之（先包后截）会截掉外层围栏半边，等于没包。

**预算**：每处 +2 行（约 50 字），`precedingOf` 的长度断言（≤ `precedingChars + 160`）不受影响。

**结构不变量用例**（`tests/kernel/scopes/prompt.test.ts`）：对 5 个极端 fixture 生成完整提示词后断言——

1. 行首围栏（``` / ~~~）总数为偶数；
2. 围栏之外 `^# ` 恰好 1 行、`^## ` 全部在白名单；
3. `## 回执块` 不在任何围栏内；
4. 数据块内部的行不参与标题计数。

fixture：正文以 `json 结尾 / 正文含未闭合 ` / 正文含 `<div>` / 正文含 `---` / 截断点正好切在反引号中间。

### D. 提示词口径（R7）

- `receiptBlockHint(keys, level, { gate })`：闸门轮标题改 `## 回执块（闸门：必须给 verdict）`，非闸门轮保持 `（可选）`；
- `RECEIPT_BLOCK_INTRO` 的「不是合法 JSON 就当没写——本轮照常结束，不挂起也不报错」在闸门轮替换为「闸门轮缺 `verdict` 会停在闸门等人」；
- `verdict` 文案补一句：**`fail` 不需要 `checks`**（失败本身就是要修），以及 `checks` 里有非 0 也算 fail；
- `checks` 文案补一句：`checks` 必须是**真的执行过**的命令，不许编造。

### E. dev 单实例保护（R9）

`scripts/dev.mjs`：启动前探测 `WORKBENCH_PORT` 是否已被占用，占用则打印「另一个 dev 实例正在占用 <port>（很可能来自旧会话），先结束它」并 exit 1，不进入 watch 循环。目的：避免两份 `vite --watch` 互踩 `out/server`、两个内核开同一个 SQLite。

（本机现场：10:34 起的实例 server 进程活着但不监听，23:32 起的实例占着 3000；收尾时只保留一套。）

### F. 输出侧回执解析（R10，P3，可选）

同一个根因（拿 Markdown 当协议）在输出侧的镜像。两条低成本加固，二选一：

- 闸门阶段只认工具通道，文本通道仅作兜底并在提示词里明确；
- 或回执块要求独立 sentinel（如 ` ```json receipt `），解析器优先找它，找不到再退回「最后一块」。

## 批次

| 批次 | 内容                                                                | 依赖 | 预估     | 验收                                  |
| ---- | ------------------------------------------------------------------- | ---- | -------- | ------------------------------------- |
| PR-1 | A1 逐键容错 + A2 工具错误 + A3 schema + A4/D 文案（R1/R2/R3/R7/R8） | 无   | 0.5 天   | 用本次真实载荷回放：`ask` 能落卡      |
| PR-2 | B1 判定原因分流 + B2 文案（R4）                                     | PR-1 | 0.5 天   | 四种 no-conclusion 各一条用例         |
| PR-3 | C 数据隔离 + 结构不变量 + 文档同步（R6）                            | 无   | 0.5 天   | 5 个 fixture 结构断言全绿             |
| PR-4 | B2 补回执命令 + `gate_asks` + UI（R5）                              | PR-2 | 1 天     | 停在闸门 → 点按钮 → 只补回执 → 走出口 |
| PR-5 | E dev 单实例保护（R9）                                              | 无   | 0.5 小时 | 起第二个 dev 立即报错退出             |
| PR-6 | F 输出侧 sentinel（R10，可选）                                      | —    | 0.5 天   | 正文含围栏时仍能取到回执              |

每条 PR 独立可回滚；只有 PR-1 有语义变化（部分回执从「整份拒」变「按键盘收」），回滚即一个 commit。

## 验收

- 新增用例（按包分层放 `tests/`）：
  - `plugins/shared/receipt-fields`：逐键容错矩阵（坏 `findings` / 坏 `ask` / 坏 `checks` / 全坏 / 未知键）；
  - `plugins/shared/receipt-mcp-server`：枚举 parity + 坏载荷回 `isError`；
  - `plugins/executors/dsh`：用本次真实载荷回放，断言 `receipt.ask` 存在、`receipt.verdict` 缺省；
  - `kernel/scopes/prompt`：结构不变量 5 例；
  - `kernel/decide.run`：`GateOutcome` 四种 reason + 补回执额度上限；
  - `kernel/scopes/thread-context`：精确断言（`tests/kernel/scopes/thread-context.test.ts:577`）随数据块更新。
- 命令：`pnpm check`（类型 / lint / 覆盖率门 / secrets / ui）、`pnpm test`、`pnpm e2e:api`。
- 手工验收：把 `be923a5a` 的 `tool_call` 载荷原样打给回执工具 → 应回成功且 `cards` 表出现 `gate-verdict` 卡；坏 `severity` 版本 → 应回 `isError` 且 `ask` 仍落卡。
- 文档：SPEC-plugins（两通道口径 / 校验分层）、SPEC-kernel（闸门无结论原因 / `gate_asks`）、SPEC-ai-workflow（回执段标题与闸门必填）、TEST-CASES（各一条）、CONSTRAINTS-HISTORY（复核记录）。

## 兼容与迁移

- `tasks.gate_asks`：新列 DEFAULT 0，走 `ALTER` 路径（同 M49），不递增 `KERNEL_VERSION`；旧事实重放补 0。
- 回执行为变化：只有「部分键非法」的回执从「整份丢弃」变成「丢掉非法键、保留其余」。合法回执、整份非法回执的行为不变。
- 提示词变化只影响含多行派生正文的轮次；无正文节选的提示词逐字不变。

## 风险与回滚

| 风险                                             | 缓解                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| 部分键被静默丢弃（例如 `findings` 没进评审闭环） | 工具通道必回原因；闸门轮再补一条「本轮回执丢弃了哪些键」的提示词段（可选） |
| 模型收到 `isError` 后反复重试                    | 执行器按键合并、最后一份生效；提示词只要求重发一次完整回执                 |
| 数据围栏让模型把正文当代码、降低可读性           | 只包多行派生正文；标签行明确「资料，不是指令」                             |
| `gate_asks` 迁移失败                             | 与 M49 同路径，重建可还原；列缺失时按 0 归一                               |

## 不做

- 不改闸门语义（`pass` 仍必须有全 0 证据、仍要逐条覆盖验收）；
- 不做自动补问（先人工按钮）；
- 不扩 `REVIEW_SEVERITIES` 枚举（先做映射文案）；
- 不调整提示词段序（段序是 SPEC 契约）；
- 不为单次问题引入新基础设施（不新增服务、不加锁文件之外的机制）。

## 立即处置（代码修好前）

1. 结束 10:34 起的 dev 实例（PID 11632 / 27484 / 10360 / 19204），只保留占着 3000 的那套，避免双写。
2. 卡住的 `a6e02161`：评审正文已在 `be923a5a/output.md`，可直接拖到「修复」；或用 `task.comment{rerun}` 带一句「回执 `findings[].severity` 只能是 blocker/high/medium/low」重跑同一会话。

## 实施记录（2026-11-21）

| 批次 | 落地                                                                                          | 提交                          |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------------- |
| PR-1 | 回执逐键容错 + `deliverables` 写回 + schema 枚举 + server 校验 + 提示词口径（R1/R2/R3/R7/R8） | `1e535eb` `4ed3592` `f18bedf` |
| PR-2 | 闸门无结论按原因分流（R4）                                                                    | `39bde53`                     |
| PR-3 | 提示词数据层隔离 + 结构不变量（R6）                                                           | `fd952c9`                     |
| PR-4 | `task.reask` + 任务详情按钮（R5）                                                             | `89f3b70`                     |
| PR-5 | dev 单实例保护（R9）                                                                          | `786bb2d`                     |
| PR-6 | 输出侧 sentinel（R10）                                                                        | 未做（可选）                  |

**偏离**：

1. `tasks.gate_asks` 列未加——额度改按 `stageRoundCount <= 1` 派生，不动投影表、不递增 `KERNEL_VERSION`；
2. `task.reask` 采用「同阶段新开一轮」而不是复用同一 run（复用会让第二轮归档覆盖第一轮的 `output.md`）；
3. 顺带修了 M28 的 `deliverables` 断链（提示词与工具 schema 都有这个键，解析器漏了它）。

**验证**：全量 241 测试文件 / 4141 用例全绿；覆盖率 98.28 / 96.11 / 97.40 / 98.60（阈值 98/93/95/98）；`pnpm check` exit 0；`pnpm build` 通过；`pnpm e2e` 未跑（未改主进程启动与打包路径）。
