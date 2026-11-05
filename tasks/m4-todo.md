# M4 任务清单（审批与通道）

> 计划说明见 [m4-plan.md](./m4-plan.md)。规则：每个任务结束跑 `pnpm check:fast`；检查点跑完整 `pnpm check` 与 `pnpm e2e`。
> 本阶段把回执里的拍板事项变成 `card.*` 事实与 `cards` 投影，回答走 `card.answer` 命令续接同一会话；新增 `in-app` / `desktop` 通道与 `sdk.notify`；通道投递只补 `pending`。
> 前置：分支 `refactor/m4-cards` @ `3d0c40d` 已开；契约与卡片口径以 m4-plan「架构决议 D1–D15」为准；`floor-guard` 扫描未跟踪文件全文，本文件不得出现关闭检查器/未完成标记/放松测试的写法。

## 阶段 1：契约、结构升级与内核闭环

### T1 SPEC 修订（与 T2 同一提交）

**描述：** 按 D1–D15 修订 `docs/specs/SPEC-kernel.md`（卡片行字段、`card.*` 事实 payload 改为整行、审批流程、`card.answer`/`card.resolve` 输入、`later` 与 `events` 口径）、`docs/specs/SPEC-plugins.md`（`ChannelPlugin`/`ChannelContext`、`Sdk.notify`、回执块格式与解析位置、通道测试口径）、`docs/specs/SPEC-host.md`（effects 卡片分发、通道装配顺序、`cards.open`/`cards.answer` IPC、`main/notify.ts`）、`docs/specs/SPEC-ai-workflow.md`（`cards` 表、`waiting` 流转、IPC 方法）。同步修正 refactor-plan 中 `host/notify.ts` 的文件名口径。

**验收标准：**

- [ ] 四份 SPEC 对卡片字段、事实、命令、通道 API、回执块格式的描述与 D1–D15 一致
- [ ] SPEC 里不再出现「`cards.delivery` 按通道记录」这类单列语义歧义
- [ ] 回执块格式有成文示例（JSON 对象 + 五键）与「解析失败不生效」口径
- [ ] `refactor-plan.md` 的 `host/notify.ts` 更正为 `src/main/notify.ts`

**验证：**

- [ ] 人工对照 `tasks/recon/m4-kernel.md` §1.3 的 9 处清单，确认 SPEC 与代码计划一致

**依赖：** 无　**涉及文件：** `docs/specs/*.md`、`docs/planning/refactor-plan.md`　**规模：** S

### T2 契约与结构：Card / card.* 事实 / cards 投影 / 命令 / 版本

**描述：** `protocol/entities.ts` 增 `Card`、`CARD_STATUSES=['open','answered','resolved']`、`CARD_DELIVERIES=['pending','delivered','failed']`；`protocol/facts.ts` 增 `card.opened/updated/delivered/delivery_failed/answered/resolved` 与 `event.received`/`event.dropped` 的 payload（整行 `card: Card` + 审计字段）；`protocol/commands.ts` 增 `card.answer`（`{cardId, optionIndex, via?}`）、`card.resolve`（`{cardId}`）；`protocol/views.ts` 增 `cards.open`/`cards.byRun`；`protocol/validate.ts` 增两条命令校验与卡片视图参数；`kernel/types.ts` 的 `ProjectionTable` 加 `cards`、`ProjectionRow`、`View.cards`、`IdKind` 加 `'card'`、`KERNEL_VERSION='m4.0.0'`；`kernel/project.ts` 增 cards/event 折叠分支；`kernel/timeline.ts` 增 `card` 作用域；`kernel/view-spec.ts` 增切片；`host/schema.ts` 增 `cards` DDL/索引（进指纹）；`protocol/channels.ts` 新增通道契约；`shared/ai-workflow-api.ts` 与 preload 形状同步（仅类型）。

**验收标准：**

- [ ] `FACT_TYPES`、`FactPayloads`、`ProjectionTable`、`PROJECTION_TABLES`、`ProjectionRow` 五处清单一致（类型系统强制）
- [ ] `project.ts` / `timeline.ts` / `view-spec.ts` 穷举 switch 均有 cards 分支
- [ ] 新库直接建 `cards` 表；旧库（v2 / M3）首启指纹变化触发一次全量重建后 `cards` 存在且为空
- [ ] `validateCommand` 接受合法 `card.answer`/`card.resolve`，拒绝越界下标、非法 `via`、缺失 `cardId`
- [ ] `validateInput` 对 `event.received`/`event.dropped` 形状放行（内核消费留 T3）

**验证：**

- [ ] `pnpm test tests/protocol tests/kernel/{project,timeline,view-spec,next-wake} tests/host/{schema,db,store}` 绿
- [ ] 旧库副本首启一次：`projection_meta.format` 变化、重建后除 `cards` 外逐表全等

**依赖：** T1　**涉及文件：** `src/protocol/{entities,facts,commands,views,validate,channels}.ts`、`src/kernel/{types,project,timeline,view-spec}.ts`、`src/host/schema.ts`、`src/shared/ai-workflow-api.ts`、`tests/protocol/**`、`tests/host/{schema,db}`　**规模：** L

### 检查点 A（T1–T2）

- [ ] `pnpm typecheck`、`pnpm lint` 绿
- [ ] 清单类断言同批改完（facts/commands/views/view-spec/schema/db/test-support）
- [ ] 旧库副本重建等价，`cards` 为空表

### T3 内核卡片：建卡 / waiting / 回答 / 关闭 / later / events

**描述：** 新增 `kernel/cards.ts`：`cardsFromReceipt(view, run, receipt, now, env)` 产 `card.opened`（含 `key` 去重 → `card.updated`）与 `card.resolved`；`answerFacts(view, input, now, env)` 校验 open/下标/run waiting 并产 `card.answered`，该 run open 卡全部答完时产出 `run.queued`（`turn+1`、`resumeSessionId`、`notBefore=null`、清租约与 `cancelRequested`）；`card.resolve` 产 `card.resolved`。`kernel/prompt.ts` 增 `answerPrompt(cards)`、`laterPrompt()` 与 `receiptBlockHint()`（追加到阶段/聊天提示词末尾）。`kernel/decide.ts`：`run.receipt` 分支先产卡片事实再产 `run.waiting{cardIds}`；`notices` → 空 options 卡片；`later` → 回 `queued`（`notBefore=later`、`turn+1`、`resumeSessionId`、`prompt=laterPrompt`）；`events` → `event.received`（hops+1、summary ≤200、detailRef）或 `event.dropped`；新增 `card.answer` / `card.resolve` 分支。

**验收标准：**

- [ ] 回执带 `ask` → 每条卡 `version=1`、`delivery='pending'`，`run.waiting.cardIds` 等于本次卡片 id
- [ ] 同 run 同 `key` 的 open 卡再出现 → `card.updated`（`version+1`、`delivery` 重置 `pending`）
- [ ] `card.answer`：选项越界 → `invalid_input`；非 open / run 非 waiting → `conflict`；重复回答零事实
- [ ] 全部 open 卡答完 → `run.queued`（同 run、`turn+1`、`resumeSessionId` 取上一轮 `sessionId`、`notBefore=null`）；未答完 → run 保持 waiting、无入队事实
- [ ] `later` 回 `queued` 且 `notBefore=later`，`nextWakeAt` 返回该时刻；`clock.tick` 零事实但调度器到点可领取
- [ ] `events` 每条一事实、`hops=父+1`；超过 `maxHops` 只产 `event.dropped`
- [ ] `notices` 卡片不改变 run 状态；`resolves` 只关同 run 的 open 卡，未知 id 零事实
- [ ] `decide` 仍纯函数（purity 测试绿）

**验证：**

- [ ] 新增 `tests/kernel/decide.card.test.ts`（建卡/去重/回答/重复/越界/多卡/later/events/熔断/notices/resolves）
- [ ] `pnpm test tests/kernel` 绿（`decide.run.test.ts` 既有断言保留，仅把 `cardIds: []` 断言改成实际 id）

**依赖：** T2　**涉及文件：** `src/kernel/{cards,decide,prompt}.ts`、`tests/kernel/**`　**规模：** L

### T4 回执块解析与执行器接线

**描述：** 新增纯函数 `plugins/shared/receipt-block.ts`：`parseReceiptBlock(output)` 取最后一个 ```json 围栏块，`JSON.parse` 后仅当对象含 `ask/notices/resolves/later/events` 至少一键时返回字段，未知键忽略；非法 JSON 或非对象返回 `null`。dsh 插件在 `buildOutcome`/`toReceipt` 用 output 解析并填入 `Receipt`；`command` 插件用 stdout 解析；两处解析失败都不改终态。校验复用 `protocol/validate` 的 receipt 字段检查（插件允许 import protocol）。

**验收标准：**

- [ ] 多块取最后一块；块内缺五键 → 不产字段；`ask` 选项为空/超限/标题超限 → 整个块忽略
- [ ] 回执块不改 `output` 原文、不改终态、不抛错
- [ ] dsh 与 command 各有一条「解析成功 → Receipt 五字段齐全」用例；解析失败用例断言字段缺失

**验证：**

- [ ] `pnpm test tests/plugins/shared/receipt-block.test.ts tests/plugins/executors` 绿

**依赖：** T2　**涉及文件：** `src/plugins/shared/receipt-block.ts`、`src/plugins/executors/dsh/{run,frames}.ts`、`src/plugins/executors/command/run.ts`、`tests/plugins/**`　**规模：** M

### T5 投影写路径与读路径

**描述：** `host/store/projection-apply.ts` 增 `Card` 列清单与 upsert/删除/清空分支；`host/store/views.ts` 增 `readCards`（`cards.open` / `cards.byRun`，逐列 SELECT）、`loadView` 装载 `View.cards`；`host/store/import.ts` 对 v2 无卡片数据不导入（保持空表）；`host/reconcile.ts` 对「waiting 且无 open 卡」的 run 补 `run.host_settled{cancelled}`（D13）。

**验收标准：**

- [ ] `cards` 表只有 `projection-apply` 写入；重建与实时投影逐行全等
- [ ] `cards.open` 按 `createdAt` 升序、只含 `status='open'`；`cards.byRun` 按 `createdAt` 升序
- [ ] 对账兜底：伪造无卡 waiting run → 启动后落 `run.cancelled`（`errorCode='cancelled'`），有卡的不动
- [ ] 关掉数据库后重建仍从事实得到相同 `cards`

**验证：**

- [ ] 新增 `tests/host/cards-projection.test.ts`；`pnpm test tests/host/{store,reconcile}` 绿

**依赖：** T2　**涉及文件：** `src/host/store/{projection-apply,views,import}.ts`、`src/host/reconcile.ts`、`tests/host/**`　**规模：** M

## 阶段 2：通道、sdk 与 IPC

### T6 sdk `notify` 能力

**描述：** `sdk/types.ts` 增 `notify(title, body): void`（`Sdk` 与 `SdkHost`）；`sdk/index.ts` 按 `capabilities` 含 `notify` 才暴露，否则抛 `capability_not_declared`；新增 `src/main/notify.ts` 用 Electron `Notification` 实现（标题/正文只作参数），经 `createSdkHost` 注入；`tests/plugins/boundary.test.ts` 增「声明 ↔ 用法」notify 规则。

**验收标准：**

- [ ] 未声明 `notify` 的插件调用即抛 `capability_not_declared`
- [ ] `src/host/**` 与 `src/plugins/**` 仍不 import electron（ESLint 绿）
- [ ] fakeSdk 补齐 `notify`，现有插件测试不回归

**验证：**

- [ ] `pnpm test tests/sdk tests/host/sdk-host.test.ts tests/plugins/boundary.test.ts` 绿

**依赖：** T2　**涉及文件：** `src/sdk/{types,index}.ts`、`src/host/sdk-host.ts`、`src/main/notify.ts`、`tests/{sdk,host,plugins}`　**规模：** S

### T7 通道宿主：hub、effects 接线、装配与补投

**描述：** 新增 `host/channels.ts`：`createChannels({ store, effects, entries, now })` 提供 `startAll/stopAll/dispatch(facts)/answer(cardId, optionIndex)`；`dispatch` 只处理 `card.opened/updated`，按 registry 顺序调用通道 `onCard`（fire-and-forget、异常隔离、单次超时），首个成功回 `card.delivered{ref:channelKey}`，全失败回 `card.delivery_failed`；启动时查询 `cards` 中 `delivery='pending'` 的 open 卡补投；`answer` 经 `effects.dispatch({type:'card.answer', commandId: 'card:'+cardId+':'+version, cardId, optionIndex, via:'channel'})`。`host/effects.ts` 增 `channels: () => Channels` 惰性 getter 并在 `card.*` 后调用；`plugins/registry.ts` 增 `channels` 清单与 `channelById`；`main/index.ts` 在 effects 之后、scheduler 之前 `startAll`，退出 `stopAll`。

**验收标准：**

- [ ] 通道抛错/超时不影响写路径，另一通道仍收到；失败落 `card.delivery_failed`
- [ ] 重启后只补 `pending`；已 `delivered` 的版本不重复投递
- [ ] `card.*` 分发发生在事务提交之后，IPC/调度返回值不受通道延迟影响（单测用慢通道验证）
- [ ] 装配顺序断言在 `tests/host/boot.test.ts` 同批更新
- [ ] `channelById` 未知 key 抛可读错误，装配时不启动未知通道

**验证：**

- [ ] 新增 `tests/host/channels.test.ts`、`tests/plugins/registry.test.ts` 扩 channels 目录一致性；`pnpm test tests/host/{effects,boot,channels}` 绿

**依赖：** T5,T6　**涉及文件：** `src/host/{channels,effects}.ts`、`src/plugins/registry.ts`、`src/main/index.ts`、`tests/host/**`、`tests/plugins/registry.test.ts`　**规模：** L

### T8 通道插件：in-app 与 desktop

**描述：** `plugins/channels/in-app/`：`manifest`（`kind:'channel'`、`capabilities:[]`）+ `index` 的 `start` 订阅 `onCard` 并立即 `delivered(card.id, card.version, 'in-app')`（投影即送达），返回 dispose；`plugins/channels/desktop/`：`manifest`（`capabilities:['notify']`）+ `start` 订阅 `onCard`，调 `sdk.notify(title, [text, ...options].join('\n'))`，成功 `delivered(..., 'desktop')`、失败 `card.delivery_failed`（经 hub 回调），返回 dispose。两者都不拼 HTML/脚本。

**验收标准：**

- [ ] 假通道场景：in-app 收到卡片即 ack；desktop 只在被选中时通知
- [ ] 通知内容只作为 `notify(title, body)` 参数；卡片正文不进命令行/模板
- [ ] 通道 `start` 抛错不影响启动，`stop` 可重复调用
- [ ] 契约测试覆盖「manifest 校验 → 注册 → 启动 → 收到卡片 → 回报」

**验证：**

- [ ] 新增 `tests/plugins/channels/{in-app,desktop}.test.ts`；`pnpm test tests/plugins` 绿

**依赖：** T6,T7　**涉及文件：** `src/plugins/channels/**`、`tests/plugins/channels/**`　**规模：** M

### T9 IPC 与最小 UI

**描述：** `main/ai-workflow/ipc.ts` 增 `cards.open`（`store.query('cards.open')`）与 `cards.answer`（`dispatch({type:'card.answer', commandId: nextCommandId(), ...})`）；`preload/index.ts` 与 `shared/ai-workflow-api.ts` 同步方法；renderer 新增顶部「待审批」条组件（读 `cards.open`、按钮调 `cards.answer`、回答失败显示后端文案），在 `AiWorkflowPage` 挂载并经既有 `onChanged` 重拉。

**验收标准：**

- [ ] `window.aiWorkflow.cards.open()` 返回 open 卡列表；`cards.answer(cardId, index)` 成功后 changed 推送、卡片消失
- [ ] 重复回答/越界返回可读文案，UI 不崩、不关闭列表
- [ ] 组件测试：有卡渲染标题/选项、点击调用 API、无卡不渲染条
- [ ] preload 契约测试同步

**验证：**

- [ ] `pnpm test tests/host/ipc.test.ts tests/preload tests/renderer/src/apps/ai-workflow` 绿

**依赖：** T3,T5　**涉及文件：** `src/main/ai-workflow/ipc.ts`、`src/preload/index.ts`、`src/shared/ai-workflow-api.ts`、`src/renderer/src/apps/ai-workflow/**`、`tests/**`　**规模：** M

## 阶段 3：验收与收尾

### T10 E2E：等待期零进程、回答续接、重复回答

**描述：** 新增 `tests/e2e/approval.spec.ts`：用种子（真 store）写入「waiting run + open card + process_registry 空」，启动应用后经桥查询 `runs`/`cards`，轮询断言 `lease_id`/`deadline_at`/`usage_json` 为空、`process_registry` 无行、`run_events` 不增长；调 `cards.answer` 后断言 `turn=2`、`status='queued'/'running'`、`resumeSessionId` 一致；再答一次断言拒绝。`helpers/seed-crash.ts` 扩一个 approval seed，供桌面通知断言用（假通知不真弹）。

**验收标准：**

- [ ] 新增用例通过且不依赖真 CLI
- [ ] 等待期断言覆盖「无子进程、无 Token 增长、租约已释放」
- [ ] 回答续接断言覆盖同会话与 `turn` 递增；重复回答断言拒绝且零新事实
- [ ] 桌面通知文字只作参数：用假通知记录 `notify` 参数并断言不拼进其他调用

**验证：**

- [ ] `pnpm e2e` 全绿（原 6 例 + 新例）

**依赖：** T7,T8,T9　**涉及文件：** `tests/e2e/**`　**规模：** M

### T11 覆盖率与门禁收口

**描述：** 补齐新分支用例（`records` 未知卡片、通道全失败、补投 pending、hop 熔断、`card.updated` 版本、`delivery_failed` 重投）；更新清单类断言与 `tests/host/store/test-support.ts` 的 `PROJECTION_COLUMNS`；跑 `check:diffcov` 确认改动行 ≥90%；`check:floor` 与 `check:secrets` 干净。

**验收标准：**

- [ ] `pnpm check` exit 0；覆盖率不低于 99.81/97.92/100/100
- [ ] `check:diffcov` ≥90%
- [ ] `check:floor` clean（文档与测试无门槛放松）

**验证：**

- [ ] `pnpm check`、`node scripts/floor-guard.mjs`

**依赖：** T2–T10　**涉及文件：** `tests/**`　**规模：** M

### T12 验收与退出记录

**描述：** 真 CLI 手工一轮：复制实库副本到临时 `--user-data-dir`，阶段执行产生 `ask` → 卡片 → 回答 → 续接成功，记录等待期间进程列表为空；老库副本首启重建与数据比对；更新 `refactor-plan.md` 退出记录、`CAPABILITY-MAP.md` 状态行、`docs/testing/TEST-CASES.md`；在退出记录写明 D15（回执块重写留 M6）、单列 delivery 语义、`main/notify.ts` 更正与兼容层去留。

**验收标准：**

- [ ] `pnpm check` / `pnpm e2e` 证据写入退出记录（命令、退出码、覆盖率、用例数）
- [ ] 真 CLI 证据：`ask` → 卡片 → 回答 → 续接成功；等待期无子进程
- [ ] 老库副本：重建成功、原 9 表逐行一致、`cards` 空、无报错
- [ ] SPEC / CAPABILITY-MAP / refactor-plan 同步完成

**验证：**

- [ ] 人工按退出记录逐条复核

**依赖：** T11　**涉及文件：** `docs/**`、`tasks/m4-todo.md`　**规模：** M
