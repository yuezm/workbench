# M4 测绘：审批与通道（`card.*` / `run.waiting` / 通道 / 回答续接）

> 只读测绘。基线：M3 完成态（`KERNEL_VERSION='m3.0.0'`，事实投影 9 表）。
> 目标态：`docs/planning/refactor-plan.md:21` 的 M4。所有行号对应当前工作区。

## 0. 结论速览

1. `run.waiting` **已经完整落地**（事实 / 投影 / 释放租约与并发位 / 可取消 / 对账保留），但它是**只进不出的黑洞**：没有任何代码把 `waiting` 改回 `queued`，也没有任何东西产出 `ask` → 生产环境永远进不了 waiting。
2. `ask` 在内核已被消费（`decide.ts:828`），`notices / resolves / later / events` 只有类型与校验，**内核零消费、执行器零产出**。
3. `card.*` 在契约层**完全不存在**：无事实名、无 payload、无 `CardRow`、无 `cards` 投影表、无视图 id、`View` 无 `cards`。SPEC 已定义（`SPEC-kernel.md:191-196`）。
4. 宿主侧 `run.queued` 会自动唤醒 scheduler（`effects.ts:57-59`），所以「回答 → `card.answered` + `run.queued`」一旦产对，**续接执行链路不需要改调度器**；要新写的是卡片生命周期、通道投递与读路径。

## 1. 现状

### 1.1 `run.waiting` 的产生与流转

| 环节       | 现状                                                                                                             | 证据                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 产生       | 仅 `run.receipt` 且 `receipt.ask` 非空：清租约/超时、`status='waiting'`、`sessionId` 取回执值（否则沿用旧值）    | `kernel/decide.ts:827-830`、`kernel/run.ts:212-221`                                                    |
| payload    | `{ run: RunRow, cardIds: string[] }`，**cardIds 恒为空数组**，注释写明「M4 接卡片后填」                          | `kernel/run.ts:223-229`、`protocol/facts.ts:180-184`                                                   |
| 投影允许值 | `RUN_STATUSES` 第 3 位                                                                                           | `protocol/entities.ts:245-252`、`host/schema.ts:112`、`kernel/project.ts:103`、`kernel/timeline.ts:91` |
| 并发位     | `occupiedSlots` 只数 `running`；`waiting` 让出窗口                                                               | `kernel/run.ts:45-51`                                                                                  |
| 重新领取   | `claimCandidates` 只取 `status==='queued'` → **waiting 永不被重新领取**                                          | `kernel/run.ts:54-62`                                                                                  |
| clock      | `leaseExpired` / `deadlineReached` 都要求 `running`；waiting 无租约无 deadline → tick 对它零事实                 | `kernel/run.ts:234-241`、`kernel/decide.ts:891-902`                                                    |
| next-wake  | 只看 running 的 `leaseUntil/deadlineAt` 与 queued 的 `notBefore`，waiting 不参与                                 | `kernel/next-wake.ts:20-27`                                                                            |
| 取消       | 可取消（`queued/running/waiting`）→ `run.cancel_requested`；无控制器时宿主直接兜底 `run.host_settled{cancelled}` | `kernel/decide.ts:864`、`host/scheduler.ts:544-553`                                                    |
| 对账       | `ACTIVE_RUN_STATUSES=['running','waiting']`：杀残留进程但**保留状态**                                            | `host/reconcile.ts:24`、`tests/host/reconcile.test.ts:246-256`                                         |
| 唯一出口   | 只有取消（终态）。**无回答入口**；`run.queued` 对已存在 run 的复用目前只出现在测试夹具                           | `tests/host/store/runs-projection.test.ts:296-334`                                                     |

### 1.2 Receipt 五字段现状

| 字段       | protocol 类型                                             | 校验                                              | 内核消费                                              | 执行器产出 |
| ---------- | --------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- | ---------- |
| `ask`      | `inputs.ts:43-52`（无 version / 无 key 语义约束外的东西） | `validate.ts:404-417` 校验 title/text/options/key | **是**：`decide.ts:828` → `run.waiting`（**不建卡**） | **否**     |
| `notices`  | `inputs.ts:86` `string[]`                                 | `validate.ts:480-482`                             | 否                                                    | 否         |
| `resolves` | `inputs.ts:88` `string[]`                                 | `validate.ts:483-485`                             | 否                                                    | 否         |
| `later`    | `inputs.ts:90` ISO                                        | `validate.ts:486`                                 | 否（`clock.tick` 无复查分支）                         | 否         |
| `events`   | `inputs.ts:54-67` + `91`                                  | `validate.ts:419-431,487`                         | 否                                                    | 否         |

「M2 执行适配层不产 ask」的代码处：`plugins/executors/dsh/run.ts:53-68`（`toReceipt` 只填 status/leaseId/turn/output/usage/sessionId/error/errorCode/exitCode/durationMs/resumeRejected）；dsh 帧表同样无卡片类帧（`plugins/executors/dsh/frames.ts:81-143` 的 switch 只有 ready/session/text/thinking/tool_call/tool_result/usage/protocol_error/result）；`plugins/executors/command/run.ts:59-72` 同理。该口径记录在 `refactor-plan.md:60`、`tasks/m2-plan.md:40`（D12）、`refactor-plan.md:70`。宿主包装层也不补这几个字段（`host/executor.ts:28-41`）。

### 1.3 事实表清单与版本

- 事实名全集 36 条：`protocol/facts.ts:30-66`（`run.*` 在 `48-60`；`run.usage` 已声明但**无生产者**）；payload 类型 `facts.ts:157-232`；`FactPayloads` 映射 `275-311`。
- `KERNEL_VERSION='m3.0.0'`（`kernel/types.ts:32`）；投影指纹 = `sha256(PROJECTION_DDL + KERNEL_VERSION)`（`host/schema.ts:357-364`），启动比对与重建 `host/store/projection.ts:40-42,85-97`。
- 投影表清单**两处重复**：`kernel/types.ts:43-53`（`PROJECTION_TABLES` + `ProjectionRow:57-58`）与 `host/schema.ts:327-339`（`PROJECTION_DDL:354`、`projectionTableDdl:341-351`）；清空白名单 `projection-apply.ts:308-318`。
- 新增 `card.*` 必须同步的 9 处：① `facts.ts` FACT_TYPES/payload/FactPayloads；② `project.ts:69-144`（**穷举 switch，缺分支 TS 直接报错**）；③ `timeline.ts:64-116` + `TimelineScope:14-16`（再一个穷举）；④ `kernel/types.ts` 三处；⑤ `host/schema.ts` DDL/tableDdl/PROJECTION_TABLES/索引；⑥ `projection-apply.ts` 列清单（仿 `RUN_FIELDS:65-105`）+ `writes:329-421`/`deletes:296-306`/`clearAll:308-318`；⑦ `host/store/views.ts` 读路径（逐列 SELECT，禁 `SELECT *`）；⑧ `protocol/views.ts` 视图 id；⑨ `kernel/view-spec.ts` 切片；另加测试硬编码清单 `tests/protocol/facts.test.ts:44-80`。

### 1.4 视图 id 与读取链路

- 15 个视图 id：`protocol/views.ts:21-37`；参数形状 `68-78`；返回类型 `81-97`；`tests/protocol/views.test.ts:48-60` 对顺序做硬断言。
- 读路径：`store.query` → `queryView`（`host/store/views.ts:598-633`，穷举 switch）→ IPC 映射表（`main/ai-workflow/ipc.ts:170-364`）→ `preload/index.ts` → renderer 直接 `window.aiWorkflow`（**`kernelStore` 尚不存在，M5**）。
- 内核入参切片：`View`（`kernel/types.ts:81-94`）、装载 `host/store/views.ts:505-519`、声明 `kernel/view-spec.ts:14-91`（switch + 注释约定 `8-10`）。
- 卡片视图要加：`VIEW_IDS` 增 `cards.open` / `cards.byRun`（或 `cards.byTask`）+ `ViewArgs/ViewResults` + `queryView` 分支 + `readCards`；内核侧要 `View.cards` + `viewSpec` 切片（`card.answer` / 通道重启补投都需要）。

### 1.5 续接链路

- run 上的续接相关字段：`turn`（`entities.ts:386`，1 基）、`resumeSessionId`（`388`，上一轮会话）、`sessionId`（`348`，本轮会话 id）、`notBefore`（`398`，注释已写「退避 / 等待回答后续接」）、`hops`（`383`）、`executorKey/cwd/access`（`372-377`）。
- `run.queued` payload 是**完整 RunRow**（`facts.ts:165-167`），`queueSeq` 由 `project` 用事实 seq 回填（`project.ts:98-100`）。
- 提示词：`prompt.ts:12-20`（阶段）、`44-54`（聊天首轮）；聊天续接轮只发新消息（`decide.ts:945-948`）；执行器侧靠 `Turn.resumeSessionId` + `fallbackPrompt`（`protocol/executor.ts:49-56`、`host/scheduler.ts:280-296`），续接被拒重试在 `host/executor.ts:71-94`。
- 已有「回答后续接」的**形状样本**（仅测试）：同 run、`status='queued'`、`turn=2`、`resumeSessionId=sessionId`、`notBefore` 置值（`tests/host/store/runs-projection.test.ts:296-334`）；帧 seq 跨轮续编验证（`tests/host/scheduler.test.ts:1037-1049`）。
- 缺口：无 `card.*` 事实；无「把 `run.sessionId` 搬到 `resumeSessionId` 并 `turn+1`」的生产代码；`entryRunFacts` 恒 `turn:1 / resumeSessionId:null`（`decide.ts:417-419`）；`waitingRun` 把会话 id 写在 `sessionId`（`run.ts:216`），续接必须读它。

### 1.6 决策函数签名与纯度

- `decide(view, input, now, env): Decision{facts, reject?}`（`kernel/types.ts:143-146,154-163`；实现 `kernel/decide.ts:445`）；同端口还有 `project(fact)`、`viewSpec(input)`、可选 `nextWakeAt`。
- 纯度由 `tests/kernel/purity.test.ts:9-29` 静态强制（禁 electron / node IO / `Date.now` / `Math.random` / `randomUUID` / `fetch` / 跨层 import）。
- 事实 seq 是全局自增（`host/schema.ts:307-324` + `host/store/facts.ts:44-59`），seq 冲突重试一次（`host/store/index.ts:120-160`），事实与投影变更同事务（`index.ts:127-141`）。
- `clock.tick` 现有分支只有「整体超时」与「租约过期」（`decide.ts:891-902`），`viewSpec` 只装 `runs`（`view-spec.ts:76-78`）。
- `card.answer` 的入口形态二选一（见 §5-D1）：Command（须带 `commandId`，`commands.ts:30-33`、`validate.ts:359`）或 HostInput（`inputs.ts:20-32,191-203` + `validate.ts:496-551`）。SPEC 声明来源是「channel、owner」（`SPEC-kernel.md:161`）——两端都要，这是形态选择的约束点。

### 1.7 谁把 `waiting` 当执行中

- 内核/宿主：`View.activeTaskIds` 语义（`kernel/types.ts:92`）、`readActiveTaskIds` SQL（`host/store/views.ts:490-502`）、两条活跃视图（`views.ts:561-571,574-584`）、`ActiveRun.status` 含 `waiting`（`protocol/views.ts:46-51`）、对账（`host/reconcile.ts:24`）。
- 守卫：拖动/完成被拒（`decide.ts:744,767`）、同对话只跑一轮（`decide.ts:222-231`）。
- UI：看板活跃集合（`KanbanBoard.tsx:29-32`）、运行日志文案（`RunLog.tsx:22,32`）。
- `grep -w waiting`：**src 36 处 / 17 文件**；**tests 48 处 / 12 文件**。断言 waiting 的用例集中在 `tests/kernel/decide.run.test.ts:293-320,760-809,1239-1254`、`tests/kernel/next-wake.test.ts:154-156`、`tests/kernel/project.test.ts:411-413`、`tests/kernel/decide.chat.test.ts:352-353`、`tests/host/store/views.test.ts:76-79,249-257,276-281,373-384,511`、`tests/host/store/runs-projection.test.ts:296-334`、`tests/host/reconcile.test.ts:246-256`、`tests/host/scheduler.test.ts:1037-1049`、`tests/protocol/{entities,facts}.test.ts:346,370-371,65`、`tests/host/db.test.ts:485-495`。

## 2. 缺口（M4 必须新增/改动的最小集合）

| #   | 位置                                                        | 改什么                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `protocol/facts.ts`                                         | 6 条事实：`card.opened / card.updated / card.delivered / card.delivery_failed / card.answered / card.resolved`（口径 `SPEC-kernel.md:191-196`）+ payload + `FactPayloads`                                                                                                      |
| 2   | `protocol/entities.ts`                                      | `CardRow`（`id, runId, taskId, conversationId, title, text, options[], key, version, status, delivery, deliveryRef, optionIndex, answeredBy, answeredAt, createdAt, updatedAt`）+ `CARD_STATUSES` / `CARD_DELIVERY` 常量；`Ask` 补 `version` 语义（`inputs.ts:43` 注释已预留） |
| 3   | 新增 `kernel/cards.ts`                                      | ask → `card.opened` 生成；回答校验（open / 版本匹配 / 选项越界 / 重复答拒绝）；`card.answer` → `card.answered` + `run.queued`（同 run、`turn+1`、`resumeSessionId=run.sessionId`、清 `notBefore`）；`resolves` → `card.resolved`                                               |
| 4   | `kernel/decide.ts`                                          | waiting 分支改为「先 `card.opened`×N 再 `run.waiting{cardIds}`」（`run.ts:210` 注释已预留）；新增 `card.answer` 分支；`run.cancel` 对 waiting 是否顺带 `card.resolved{cancelled}`                                                                                              |
| 5   | `kernel/next-wake.ts` + `clock.tick`                        | 若拍板卡片超时 / `later` 到期，二者都要纳入；默认不超时时**保持现状零改动**（`SPEC-kernel.md:309`）                                                                                                                                                                            |
| 6   | `kernel/{types,project,timeline,view-spec}.ts`              | `View.cards`、`PROJECTION_TABLES` 加 `cards`、`ProjectionRow`、fold 分支、`TimelineScope` 加 `card`、切片声明                                                                                                                                                                  |
| 7   | `host/schema.ts` + `projection-apply.ts` + `store/views.ts` | `cards` DDL / 索引 / 指纹输入 / 列映射与写删清 / `loadView` 切片 / `queryView` 分支                                                                                                                                                                                            |
| 8   | `protocol/views.ts` + `main/ai-workflow/ipc.ts`             | `cards.open`（按 run/任务/对话）与 `cards.answer` 入口；M5 的 `kernelStore` 之前需要一条最小 IPC                                                                                                                                                                               |
| 9   | `plugins/executors/dsh/frames.ts` + `run.ts`                | 解析 ask/notice/resolve/later/events 帧并填进 `Receipt`（当前 switch 无这些帧）；`command` 执行器是否支持（stdin 约定）另定                                                                                                                                                    |
| 10  | 新增 `plugins/channels/{in-app,desktop}/` + `registry.ts`   | `ChannelPlugin/ChannelContext` 契约（`SPEC-plugins.md:239-257`，**目前只在文档里**）；`in-app` = 卡片落投影 + UI 直批，`desktop` = 系统通知（`SPEC-plugins.md:284-285`）                                                                                                       |
| 11  | `host/effects.ts`                                           | `card.opened` → 通道投递；`card.delivered/delivery_failed` → 回报事实；`card.answered` 已由既有 `run.queued` 分支唤醒调度器，无需改（`effects.ts:57-59`）                                                                                                                      |
| 12  | `sdk`（若 desktop 通道走插件）                              | `notify` 能力在 `protocol/manifest.ts:18` 已声明但 sdk 未实现；要么补 sdk 面，要么 desktop 通道放宿主（`host/notify.ts`）                                                                                                                                                      |
| 13  | 测试                                                        | `facts.test.ts:44-80` 清单、`views.test.ts:48-60` 顺序、`view-spec`/`project`/`timeline`/`decide` 逐分支（穷举 switch 会逼出来）                                                                                                                                               |

## 3. 集成点

1. **写入口唯一**：`store.dispatch`（`host/store/index.ts:144-160`）← `effects.dispatch`（`effects.ts:72-78`）← IPC / scheduler / clock / 通道。通道投递状态必须走事实（`card.delivered`），禁止直写 `cards` 表。
2. **装配根**：`src/main/index.ts:164-213`（reconcile → effects → clock → scheduler → IPC），通道 `start()` 要排在这之后（需要 `store.query` + `dispatch` 同时就绪）；`cast` 顺序决定重启补投时机。
3. **重启补投**：`SPEC-plugins.md:256` 要求只补 `pending`；现有对账（`reconcile.ts:54-86`）不碰卡片，需新增「查 `cards.delivery='pending'`」一步（依赖 §2-7 的读路径）。
4. **桌面通知**：现有通道是 renderer→main 的 `workbench:notify`（`src/main/ipc.ts:1-9`、`src/shared/workbench-api.ts:11-17`），**不是**宿主侧通道；desktop 通道要么直接 `new Notification`（宿主），要么补 sdk `notify`。
5. **in-app 回答**：卡片答案要经 IPC 回来（`ipc.ts:170-364` 的 handler 表 + `preload`），M5 会把这段改成 `kernelStore`。

## 4. 风险

| 风险                 | 说明                                                                                                                                                        | 证据                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 首启全量重建         | 改 `cards` DDL 即改指纹，老库启动清空 9 表重放；历史 `run.waiting` 无对应 `card.*` 事实 → 重建后卡片表空、「等人答」的 run 无卡可答，永久卡「执行中」       | `schema.ts:361-364`、`projection.ts:85-97`、`host/store/views.ts:496-499` |
| `queueSeq` 被重写    | 复用 `run.queued` 做续接会无条件把 `queueSeq` 改成新事实 seq → 老 run 排到队尾，FIFO 位次变化                                                               | `project.ts:98-100`                                                       |
| 挂起期间零进程未验证 | 回执返回后 scheduler 走 `finishOnce` 释放位（`scheduler.ts:372-391`），dsh 进程自行退出（`dsh/run.ts:291-304`）；「零进程 + 零 Token」需 e2e 断言，现无覆盖 | `refactor-plan.md:21` 的验收条目                                          |
| 会话 id 搬错字段     | `waitingRun` 写 `sessionId`（`run.ts:216`），续接轮必须复制到 `resumeSessionId` 否则丢上下文                                                                | `entities.ts:348,388`                                                     |
| 卡片正文注入         | 卡片文字来自模型，只能作平台 API 参数；桌面通知不得拼 shell/HTML                                                                                            | `SPEC-plugins.md:255`                                                     |
| 迟到回执             | waiting run 的 `leaseId` 已清 → 任何回执都 `lease_mismatch` 只审计，安全                                                                                    | `kernel/run.ts:137-142`                                                   |
| 覆盖与规模门         | 基线覆盖率 99.81/97.92/100/100；`src/kernel` ≤2000 行预算                                                                                                   | `refactor-plan.md:94`、`ARCHITECTURE.md:251`                              |

## 5. 需评审的决策点

- **D1 `card.answer` 入口形态**：Command（带 `commandId`，幂等语义提前到 M4）vs HostInput（无 `commandId`，内核按 `(cardId,version)` 幂等）。建议 Command：channel 侧由宿主生成 `commandId=cardId:version`，代价是 M4 提前引入 M5 的幂等口径（`refactor-plan.md:22`）。
- **D2 续接用哪条事实**：复用 `run.queued`（同 run + `turn+1`，已有测试样本）vs 新 `run.resumed`。建议复用：改动最小、scheduler 自动接通；代价是 `queueSeq` 被刷新（§4），且「入队 / 重新入队」在 `why` 链上只能靠 `turn` 区分。
- **D3 卡片超时与 `later` 是否进 M4**：SPEC 明说卡片默认不超时（`SPEC-kernel.md:309`），但 M4 范围列了 `later`（`refactor-plan.md:21`）。建议 M4 只解析并落事实、不排定时器（`next-wake`/`clock.tick` 零改动），复查排期留 M6；代价是 `later` 与 `events` 一样变成「只记账不生效」。
- **D4 通道插件的能力面与归属**：desktop 通道插件需要 `notify` 能力（`protocol/manifest.ts:18` 已声明、sdk 未实现）。建议补 sdk 最小 `notify`（宿主注入 Electron 实现），通道统一按 `capabilities:['notify']` 声明；代价是新增 sdk 面 + `tests/plugins/boundary.test.ts` 的「声明↔用法」校验要跟着扩。
- **D5 in-app 读路径提前到 M4 还是等 M5**：M5 才做 `kernelStore/subscribe`（`refactor-plan.md:22`），但 M4 的验收要「问答闭环 E2E」。建议 M4 先加两条最小 IPC（`cards.open`、`cards.answer`）复用现有 `invoke` + `broadcastChanged`，M5 再迁到 kernelStore；代价是同一段接线改两遍。
- **D6 存量 waiting run 如何收口**：重建后无卡可答的 waiting run 建议由启动对账补 `run.host_settled{cancelled}`（或按需补卡）；代价是改 `reconcile` 语义并改 `tests/e2e/helpers/seed-crash.ts:50` 的既有断言。
