# 实施计划：M4 审批与通道（`card.*` / `run.waiting` / 回答续接 / in-app + desktop）

> 依据 [refactor-plan](../docs/planning/refactor-plan.md) M4 行、[SPEC-kernel.md](../docs/specs/SPEC-kernel.md)（输入/事实目录、审批、调度）、[SPEC-plugins.md](../docs/specs/SPEC-plugins.md)（channel、SDK、回执约定）、[SPEC-host.md](../docs/specs/SPEC-host.md)（effects/boot/IPC）。
> 起点：`master` @ `3d0c40d`（M3 退出后）。工作分支 `refactor/m4-cards`。
> 目标：**审批闭环零消耗**——回执里的拍板事项变成卡片，run 进 `waiting` 并释放租约/并发位（无进程、无 Token）；人回答后同一会话续接；桌面通知文字只作参数；新增通道/协议不碰内核。
> 本阶段不做：规则与线程（M6/M6.5）、`kernelStore`/IPC 三动词（M5）、外部插件子进程与 webhook 通道（M7）、卡片超时与「重写最后一条回复」的重试（M6 独立任务）。
> 任务明细与验收见 [m4-todo.md](./m4-todo.md)；测绘证据见 `tasks/recon/m4-{kernel,host,gates}.md`。

## 开工前提（2026-11-05）

- 分支 `refactor/m4-cards` @ `3d0c40d`；工作树干净（唯一未跟踪项是三份 m4 测绘文档）。
- 回滚点：开工前 `pnpm db:export` 备份实库到 `%APPDATA%\workbench\backups\`；M4 改投影指纹（`KERNEL_VERSION=m4.0.0` + `cards` DDL），回退需恢复数据库备份并重建。
- 门禁基线：`pnpm check` 全绿；覆盖率 **99.81 / 97.92 / 100 / 100**（阈值 98/93/95/98）；`check:diffcov` 门槛 90%。`floor-guard` 默认 base 是 `master`，在分支上工作才有效（直接改 master 会因 diff 为空假绿）。
- `floor-guard` 扫描未跟踪文件全文（`.md` 无豁免）：本计划与任务清单不得出现关闭检查器的注释、未完成标记、放松测试的写法。
- 实库仍是 v2 格式（M3 已记录），M4 首启会走 `host/store/import.ts` 兼容层 + 指纹重建；**M4 不删兼容层**（删除条件沿用 M3 退出记录）。

## 现状（测绘结论，2026-11-05）

| 事实                                                                                                                                                                                                   | 证据                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.waiting` 已完整落地但**只进不出**：仅 `receipt.ask` 非空时产生，清租约/超时，并发位只数 `running` 自动让出；`claimCandidates` 只取 `queued`，`next-wake`/`clock.tick` 都忽略 waiting → 无回答入口 | `kernel/decide.ts:827-830`、`kernel/run.ts:41-62,207-229`、`kernel/next-wake.ts:20-27`、`tests/host/store/runs-projection.test.ts:296-334`（仅测试夹具模拟续接）          |
| `receipt.ask` 内核只产 `run.waiting`（`cardIds` 恒空），**不建卡**；`notices/resolves/later/events` 只有类型与校验，内核零消费、执行器零产出                                                           | `kernel/run.ts:223-229`、`protocol/inputs.ts:69-97`、`protocol/validate.ts:466-494`、`plugins/executors/dsh/run.ts:53-68`、`dsh/frames.ts:81-143`、`command/run.ts:59-72` |
| `card.*` 契约层零存在：无事实名/payload、无 `Card` 行、无 `cards` 投影表、无视图 id、`View` 无 cards                                                                                                   | `protocol/facts.ts:30-66`、`kernel/types.ts:43-58,81-94`、`host/schema.ts:326-364`、`protocol/views.ts:21-37`                                                             |
| 新增一条事实要同步 9 处（含 `project.ts` / `timeline.ts` 两个穷举 switch，漏分支即类型报错）；新增投影表要同步 `PROJECTION_TABLES` / DDL / 指纹 / `projection-apply` / `loadView` / `queryView`        | `tasks/recon/m4-kernel.md` §1.3                                                                                                                                           |
| effects 是内联分发：`run.queued → wake`、`run.cancel_requested → cancel`，其余只广播 changed；未接线的 `onFacts` 是现成挂点，但 `afterCommit` 在写事务后同步执行                                       | `host/effects.ts:26-69`、`host/store/index.ts:127-141`                                                                                                                    |
| 通道契约只在文档：无 `plugins/channels/**`、无 `ChannelPlugin/ChannelContext`、无 `onCard/delivered/answer`、无 `sdk.notify`；`Capability` 已含 `notify` 但 sdk 未实现、boundary 未扫描                | `docs/specs/SPEC-plugins.md:239-257`、`src/sdk/types.ts:69-88`、`src/protocol/manifest.ts:18`、`tests/plugins/boundary.test.ts:200-205`                                   |
| IPC 是单 RPC 方法表 + preload 逐方法；changed 无 payload，renderer 收到即重拉；错误码不过桥（重复回答只能给文案）                                                                                      | `src/main/ai-workflow/ipc.ts:169-378`、`src/preload/index.ts:22-79`、`src/main/index.ts:88-90`                                                                            |
| 通知现状：`window.workbench.notify` → main `new Notification({title,body})`，与托盘无关；AppUserModelId 已设                                                                                           | `src/main/ipc.ts:1-9`、`src/main/index.ts:84`                                                                                                                             |
| 没有卡片 UI；waiting 只显示状态标签；看板用 runs 含 waiting 锁卡片                                                                                                                                     | `RunLog.tsx:19-36`、`KanbanBoard.tsx:29-34`                                                                                                                               |
| 装配顺序：store → 导入/重建 → sdkHost → executorRegistry → processRegistry → reconcile → effects → clock → scheduler → IPC → 建窗 → 托盘；无通道装配、无退出 dispose                                   | `src/main/index.ts:92-238,249-253`                                                                                                                                        |
| E2E 每例独立 `--user-data-dir`，不打真 CLI；进程断言范式是种 `process_registry` 后轮询 pid/归零                                                                                                        | `tests/e2e/helpers/launch.ts:50-58`、`tests/e2e/crash-recovery.spec.ts:35-46`、`tests/e2e/helpers/seed-crash.ts:152-209`                                                  |

## 架构决议（M4 口径）

| #   | 缺口                     | M4 口径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 卡片契约                 | `cards` 成为**第 10 张投影表**；事实 `card.opened / updated / delivered / delivery_failed / answered / resolved`。沿用 M2「一行事实 → 一行投影」：每条 `card.*` payload 携带完整 `card: Card` 行（`card.updated` 另可带 `changes` 供追溯），`project` 保持纯函数、重建无需回查。SPEC 的稀疏 payload 在 M4 修订为整行口径。                                                                                                                                                                                                                                                                                          |
| D2  | 卡片字段与投递状态       | `Card`：`id, runId, taskId, conversationId, title, text, options[], key, version, status('open'\|'answered'\|'resolved'), delivery('pending'\|'delivered'\|'failed'), deliveryRef, optionIndex, answeredBy, answeredAt, createdAt, updatedAt`。`delivery` 语义 = **已送达至少一个通道**（in-app 天然可见，投递即 ack；desktop 通知就地投递）；同一 `(cardId, version)` 只投一次，重启只补 `pending`，已投递的版本不重复打扰。                                                                                                                                                                                       |
| D3  | 回执解析与来源           | `receipt.ask / notices / resolves / later / events` 的解析器是纯函数 `plugins/shared/receipt-block.ts`：取执行器最终输出里**最后一个 ```json 围栏块**，对象含上述键才算回执块；非法/缺失 → 不产这些字段、不改变终态、不中断执行。dsh 从 `result` 帧 output 解析、`command` 从 stdout 解析。dsh 协议本身无卡片帧，不改外部 CLI。                                                                                                                                                                                                                                                                                     |
| D4  | 回执块提示词             | `kernel/prompt.ts` 在阶段任务提示词与聊天首轮提示词末尾追加固定「回执块」说明（确定性文本、同事实同文本），告诉智能体可输出 `ask/notices/resolves/later/events`；不把外部事件文字拼成指令。                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D5  | ask → 卡片与 waiting     | 每条 `ask` 产 `card.opened`（`version=1`、`delivery='pending'`），`run.waiting` 的 `cardIds` 填本次卡；同一 run 已有同 `key` 的 open 卡 → 产 `card.updated`（`version+1`、投递重置 `pending`）。`notices` → `card.opened` 且 `options: []`（信息卡，**不阻塞 run**）。`resolves[]` → 对同 run 的 open 卡产 `card.resolved{reason:'agent'}`；未知/已关闭 id 忽略。                                                                                                                                                                                                                                                   |
| D6  | 回答与续接               | `card.answer` 是**命令**（`commandId` 幂等）而非宿主输入：payload `{cardId, optionIndex, via?}`，`via` 缺省 `ui`（channel 传入 `channel`，用于 `card.answered.by`）。校验：卡片存在、`status='open'`、选项下标合法、run 为 `waiting`；重复/越界/已关闭 → `reject`（`conflict`/`invalid_input`）。产 `card.answered`；该 run 的 open 卡**全部答完**才产 `run.queued`（同 run、`turn+1`、`resumeSessionId = run.sessionId ?? run.resumeSessionId`、`notBefore=null`、清租约与 `cancelRequested`），续接提示词由 `answerPrompt(cards)` 生成（全部问答对、确定性）。未答完时 run 保持 `waiting`（`cardIds` 仍是该批）。 |
| D7  | `later`（约时间复查）    | 回执带 `later` 且无 `ask`/`notices` 时，run 不落终态而回 `queued`：`notBefore=later`、`turn+1`、`resumeSessionId` 同上、`prompt=laterPrompt()`；`next-wake` 已支持 queued 的 `notBefore`，`clock.tick` 与调度器零改动。`ask` 优先于 `later`（同一回执同时出现时只挂起）。                                                                                                                                                                                                                                                                                                                                           |
| D8  | `events`（派生事件）     | M4 只入账、不派活：每条事件写 `event.received` 事实（`hops = 父 run.hops + 1`、`summary` ≤200、`detail` 由宿主落 `artifacts/<eventId>.md` 并把路径放 `detailRef`、`dedupeKey` 原样保留）；`hops > maxHops` 时写 `event.dropped`，不派活。规则命中建任务留 M6（`event.received` 无投影，重建时 `project` 返回空）。                                                                                                                                                                                                                                                                                                  |
| D9  | 通道宿主                 | 新增 `host/channels.ts`：注册与启停、按 `card.opened/updated` 分发、接收 `delivered/answer`、启动补投 `delivery='pending'`。effects 增加 `channels: () => Channels` 惰性 getter（与 scheduler 同范式），`card.*` 投递 **fire-and-forget** 且自捕获异常，不拖住写路径。通道启停排在 effects 之后、scheduler 之前；退出时 abort + best-effort dispose。                                                                                                                                                                                                                                                               |
| D10 | 通道插件与契约           | `ChannelPlugin.start(ctx): Promise<dispose>`、`ChannelContext{sdk, onCard, delivered, answer, signal}` 进 `protocol`；新增 `plugins/channels/in-app`（投影即送达：`start` 内把 `pending` 卡片 ack 为 `delivered{ref:'in-app'}`）与 `plugins/channels/desktop`（`sdk.notify(title, body)`，标题/正文只作参数）；`plugins/registry.ts` 新增 `channels` 导出，数组顺序即投递顺序。                                                                                                                                                                                                                                     |
| D11 | `notify` 能力            | `Sdk.notify(title, body)`，按 `capabilities:['notify']` 做运行期门控与 boundary 扫描；宿主原件是 `src/main/notify.ts`（Electron `Notification`），经 `createSdkHost` 注入。**不新增 `host/notify.ts`**：`host` 不 import electron，refactor-plan 的该文件名在 M4 退出记录里更正为 `main/notify.ts`。                                                                                                                                                                                                                                                                                                                |
| D12 | 读路径与最小 UI          | 新增视图 `cards.open`（全部 open 卡，按 `createdAt` 升序）与 `cards.byRun`；IPC 方法 `cards.open` / `cards.answer`，preload 与 `shared/ai-workflow-api.ts` 同步；最小 in-app UI：ai-workflow 页面顶部「待审批」条（列出 open 卡与选项按钮，点击即回答），不新增导航、不弹模态。M5 迁 `kernelStore` 时替换该读路径。                                                                                                                                                                                                                                                                                                 |
| D13 | 版本、重建与存量 waiting | `KERNEL_VERSION='m4.0.0'` + `cards` DDL 变化 → 首启指纹重建。历史 `waiting` run 无对应 `card.*` 事实，重建后无卡可答：启动对账对「`waiting` 且无 open 卡」的 run 补 `run.host_settled{cancelled}`（reason 写明卡片缺失），避免永久「执行中」；有 open 卡的保持等待。                                                                                                                                                                                                                                                                                                                                                |
| D14 | 门禁与测试               | 阈值不动；清单类断言（facts/commands/views/view-spec/schema/db/boot/test-support）与新常量同批改；新增 `tests/kernel/decide.card.test.ts`（不拆 `decide.run.test.ts` 既有断言）、`tests/host/{channels,cards-projection}.test.ts`、`tests/plugins/{channels,receipt-block}.test.ts`、e2e「等待期零进程」；boundary 扫描扩 channels 与 `notify`，registry 测试扩 channels 目录一致性。                                                                                                                                                                                                                               |
| D15 | 回执块重写不迁移         | SPEC-plugins「解析失败只重写最后一条回复、上限 2 次」需要额外 execute 帧与模型调用，M4 只保证「解析失败不生效、终态照常」；重写作为 M6 独立任务，退出记录列为已知边界。                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 目标结构

```
src/
├── protocol/
│   ├── entities.ts        # Card / CARD_STATUSES / CARD_DELIVERIES
│   ├── facts.ts           # card.* + event.received / event.dropped
│   ├── commands.ts        # card.answer / card.resolve
│   ├── inputs.ts          # Receipt 保留五字段；Ask 增加 key 语义注释
│   ├── views.ts           # cards.open / cards.byRun
│   └── channels.ts        # ChannelPlugin / ChannelContext（新）
├── kernel/
│   ├── cards.ts           # 建卡、回答校验、续接、关闭（纯函数，新）
│   ├── prompt.ts          # 回执块说明 / answerPrompt / laterPrompt
│   ├── decide.ts          # receipt 五字段、card.answer、card.resolve、clock 兜底
│   ├── project.ts         # cards / event.* 折叠
│   ├── timeline.ts        # card 作用域
│   ├── view-spec.ts       # card 输入切片
│   ├── types.ts           # View.cards、投影表、IdKind 'card'、KERNEL_VERSION
│   └── next-wake.ts       # 不变（later 走 queued.notBefore）
├── host/
│   ├── channels.ts        # 通道 hub（注册/启停/分发/补投，新）
│   ├── effects.ts         # card.* → hub
│   ├── reconcile.ts       # 无卡 waiting 兜底
│   └── schema.ts / store/{projection-apply,views}.ts  # cards 表与读路径
├── sdk/
│   ├── types.ts           # Sdk.notify / SdkHost.notify
│   └── index.ts           # notify 能力门控
├── plugins/
│   ├── registry.ts        # channels 清单
│   ├── shared/receipt-block.ts      # 回执块解析（纯函数，新）
│   ├── executors/{dsh,command}/     # 解析回执块填入 Receipt
│   └── channels/{in-app,desktop}/   # 通道插件（新）
├── main/
│   ├── index.ts           # 通道装配/退出 dispose
│   ├── notify.ts          # Electron Notification（新）
│   └── ai-workflow/ipc.ts # cards.open / cards.answer
└── renderer/.../ai-workflow/        # 顶部待审批条
```

依赖红线不变：`plugins → sdk + protocol`；`host → kernel + protocol + sdk + plugins/registry`（禁具体插件实现）；`renderer` 只经 bridge；`main` 是装配根。

## 任务拆分

**M4a 契约与内核闭环（T1–T5 串行收口）**

| 编号 | 任务                                                                                                                                                                                                                                               | 依赖 | 规模 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| T1   | SPEC 修订：`SPEC-kernel` 卡片字段/事实/审批、`SPEC-plugins` channel 与回执块格式、`SPEC-host` effects/装配/IPC、`SPEC-ai-workflow` 数据模型                                                                                                        | 无   | S    |
| T2   | 契约与结构：`Card` 实体与常量、`card.*`/`event.*` 事实、`cards` 投影表 DDL、`KERNEL_VERSION=m4.0.0`、`Card` 视图 id、`card.answer`/`card.resolve` 命令、`validate`、`View.cards` + `view-spec` + `project` + `timeline` 穷举分支（与 T1 同一提交） | T1   | L    |
| T3   | 内核卡片：新 `kernel/cards.ts`；`run.receipt` 五字段分支（ask/notices/resolves/later/events）；`card.answer` / `card.resolve` 决策；续接与提示词（`answerPrompt`/`laterPrompt`/回执块说明）                                                        | T2   | L    |
| T4   | 回执块解析：`plugins/shared/receipt-block.ts` + dsh/command 执行器接线 + 校验复用；单测覆盖合法/非法/多块/上限                                                                                                                                     | T2   | M    |
| T5   | 投影与读路径：`projection-apply` 列映射与写删清、`store/views.ts` 读 `cards`、`queryView`、`loadView` 切片、存量导入兼容、重建等价                                                                                                                 | T2   | M    |

**M4b 通道与宿主（可与 M4a 尾段并行，T6 依赖 T5、T8 依赖 T3/T6）**

| 编号 | 任务                                                                                                                                      | 依赖  | 规模 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---- |
| T6   | sdk `notify`：`Sdk`/`SdkHost`/`createSdk` 门控、`main/notify.ts`、boundary 扫描                                                           | T2    | S    |
| T7   | 通道宿主：`host/channels.ts` hub、effects 接线（fire-and-forget + 隔离）、registry `channels`、装配启停与补投、reconcile 兜底无卡 waiting | T5,T6 | L    |
| T8   | 通道插件：`in-app`（ack pending）、`desktop`（notify + 失败落 `card.delivery_failed`）、契约测试与目录一致性                              | T6,T7 | M    |
| T9   | IPC 与 UI：`cards.open`/`cards.answer` IPC + preload + shared、顶部待审批条与组件测试、重复回答拒绝文案                                   | T3,T5 | M    |

**M4c 收尾（T10–T12）**

| 编号 | 任务                                                                                                        | 依赖   | 规模 |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------ | ---- |
| T10  | e2e：等待期零进程/零 Token、回答后续接、重复回答拒绝、桌面通知文字只作参数（假通知命令）                    | T7–T9  | M    |
| T11  | 覆盖率与门禁：清单类断言同批更新、新分支用例、`check:diffcov`、`pnpm e2e`                                   | T2–T10 | M    |
| T12  | 验收与退出记录：真 CLI 一轮（阶段执行 + 卡片 + 回答）、老库副本冒烟、SPEC/refactor-plan/CAPABILITY-MAP 同步 | T11    | M    |

T2 与 T1 同一提交（先改 SPEC 再改 DDL，避免字段反复）；T4 可与 T3 并行（写作用域 `plugins/**` vs `kernel/**`）；T6/T9 可与 T3/T4 并行（`sdk`/`main`/`renderer`）；T7 是唯一把通道接进写路径的提交，必须与 boot/effects 测试同批。

## 检查点

- **A（T1–T2）**：`pnpm typecheck && pnpm lint` 绿；`tests/protocol`、`tests/kernel/{project,timeline,view-spec,next-wake}`、`tests/host/{schema,db,store}` 全绿；旧库副本首启完成一次指纹重建，重建前后除 `cards` 外逐表全等。
- **B（T3–T5）**：`tests/kernel/decide.card.test.ts` 全绿（建卡/waiting 续接/重复回答/选项越界/notices/resolves/later/events/跳数熔断）；`tests/host/cards-projection.test.ts` 实时投影与分批重建逐行全等。
- **C（T6–T9）**：通道契约测试绿（假通道收到卡片、投递失败隔离、只补 pending）；`pnpm e2e` 新增用例通过；`runs` 在 waiting 时 `lease_id/deadline_at/usage_json` 均为空、`process_registry` 归零。
- **D（T10–T12）**：`pnpm check` exit 0、覆盖率不低于基线、改动行 ≥90%；真 CLI 手工验收完成；SPEC 与两处索引同步。

## 文件去向

| 现状                                                             | 去向                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `kernel/run.ts` 的 `waitingRun`/`waitingFacts`（恒空 `cardIds`） | `kernel/cards.ts` 生成卡片事实后填充；`waitingFacts` 改为接收 `cardIds`                                         |
| `kernel/decide.ts` 的 `run.receipt` 分支                         | 抽出「回执 → 事实」到 `kernel/cards.ts`（ask/notices/resolves/later），终态与阶段流转留在 decide                |
| `protocol/inputs.ts` 的 `Ask`（雏形）                            | 保留为回执输入；投影行用 `Card`，不再让 `Ask` 承担版本/投递字段                                                 |
| `src/main/ipc.ts` 的 `workbench:notify`                          | 保留给 shell；desktop 通道改走 `sdk.notify` → `main/notify.ts`（同一 Electron Notification 实现，避免两套通知） |
| `refactor-plan` 中的 `host/notify.ts`                            | 更正为 `src/main/notify.ts`（host 不 import electron）                                                          |
| `apps/ai-workflow/**`                                            | 顶部待审批条（新组件）；M5 迁 kernelStore 时替换读路径                                                          |

## 必须保住的行为（M4 相关，逐条验收）

1. 「执行中」= 存在 `queued`/`running`/`waiting` run（现算）；waiting 期间不占并发位、无租约、无超时。
2. 挂起期间零进程、零 Token：回执落库时子进程已退出、进程登记已删、`usage` 不增长。
3. 回答续接：同一 run 回 `queued`、`turn+1`、`resumeSessionId` 取上一轮 `sessionId`；续接被拒仍走执行器「新会话 + 完整历史重试一次」。
4. 重复回答、非 open 卡、选项越界一律拒绝，不产事实、不覆盖已有回答。
5. 卡片文字只作平台/通知 API 参数，不拼进命令行、HTML 或脚本；`notify` 能力门控生效。
6. 投递只补 `pending`，已投递版本不重复打扰；投递失败不影响卡片状态与内核。
7. 事件入账：`hops = 父 run.hops + 1`，`hops > maxHops` 只记 `event.dropped`；事件不直接决定派活。
8. 真相源唯一：卡片、投递、回答只经事实；`cards` 表只有 `projection-apply` 写。
9. 重建等价：`cards` 投影从事实可完整重建；无卡片的历史 waiting run 由对账收口。
10. 依赖边界与质量门禁不放松：覆盖率阈值、改动行 ≥90%、`stage-machine` 分支 100%。

## 验收（退出条件）

- `pnpm check` exit 0；覆盖率不低于基线；`check:diffcov` ≥90%；`pnpm e2e` 全绿（含新增等待期用例）。
- 问答闭环 E2E：等待期间无子进程、`process_registry` 为空、`usage` 为 null；回答后同会话续接（`turn=2`、`session_id` 一致）；重复回答被拒。
- 桌面通知：假通知夹具断言 title/body 只作为参数传入；失败落 `card.delivery_failed` 且卡片仍 open。
- 真 CLI 手工验收：阶段执行触发 `ask` → 卡片投递 → 回答 → 续接执行成功；等待期间任务管理器无子进程。
- 老库副本冒烟：M3 退出库副本首启重建成功、原有 9 表数据逐行不变、`cards` 为空且无卡片相关报错。
- SPEC / CAPABILITY-MAP / refactor-plan 同步（含 D15 已知边界）。

## 风险与对策

| 风险                                         | 影响 | 对策                                                                                        |
| -------------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| 回执块格式无权威定义，智能体产出不稳定       | 高   | 格式写进提示词与 SPEC；解析器对「多块取最后一块、非法即忽略」做确定性单测；E2E 用夹具执行器 |
| `cards` 投影与 9 处清单不同步                | 高   | T2 一次提交全部常量与穷举分支，类型系统兜底；清单类测试同批改                               |
| effects 同步分发被通道拖慢                   | 中   | fire-and-forget + 自捕获 + 超时；投递状态只经事实回写，不阻塞写路径                         |
| 多卡「全部答完才续接」导致部分卡长期悬空     | 中   | `card.resolve` 可手动关闭；回执 `resolves` 由智能体关闭旧卡；卡片默认不超时                 |
| 桌面通道误触发系统通知干扰本机               | 低   | 只在 `card.opened/updated` 且 `desktop` 启用时发；测试用假通知，不真弹                      |
| 无卡 waiting run 重建后卡死                  | 中   | 对账兜底取消（D13），并补对账用例                                                           |
| 回答续接把老 run 排到队尾（`queueSeq` 重写） | 低   | 续接本就重新排队；`why` 链以 `turn` 区分，退出记录注明                                      |

## 评审结论（2026-11-05，已拍板）

1. **回执块格式**：最后一个 ```json 围栏块，对象含 `ask/notices/resolves/later/events` 任一键即算回执块。不改用 HTML 注释。
2. **多卡等待语义**：同一回执多项 `ask` 时**全部答完才续接**；未答完 run 保持 `waiting`，可用 `card.resolve` 关闭悬空卡。
3. **投递状态粒度**：单列 `cards.delivery` = 「已送达至少一个通道」；不新增按通道的投递表。`deliveryRef` 记最后一个成功通道。
4. **最小 UI 进 M4**：ai-workflow 页面顶部「待审批」条，不新增导航、不弹模态；M5 迁 `kernelStore` 时替换读路径。
5. **验收方式**：E2E 用夹具执行器 + 种子 waiting/card，真 CLI 手工一轮作为补充证据；不要求 E2E 跑真 CLI。

以上五条已并入 D1–D15，任务清单按此执行。
