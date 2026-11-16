# SPEC — 飞书话题收敛（M47）

> 本文件是**当前工作计划的规格入口**（`/agent-skills-build auto` 只认仓库根 / `docs/SPEC.md` / `spec/`）。
> 行为条款在实现落地时同步进 `docs/specs/SPEC-ai-workflow.md`（会话与续接、界面分层）与
> `docs/specs/SPEC-plugins.md`（channel 端口）——那两处才是长期真相源，本文件是本次施工的计划书。

## 1. 问题

飞书里与工作台助手对话，三种情况目前都会散：

1. **顺手接着聊** → 每条入站消息都 `chat.create` 一条新会话（`host/channels.ts#submit`），第二条就丢上下文，会话清单里一堆一行对话。
2. **任务阻塞要人答** → 卡片是独立消息，链不上「这是哪个话题的第几个问题」。
3. **换话题** → 与 1 同形，无法分辨「继续说」与「另起一题」。

## 2. 目标

**收敛单位是话题**。一个话题 = 一条 issue 形状的实体 + 飞书里一条可追溯的线程；消息、任务、卡片、run 都挂在它下面。

- 飞书侧：同一话题的所有回执 / 进展 / 提问落进**同一条话题线程**，重启后仍能认出来。
- workbench 侧：同一话题的会话、任务、卡片收成一个条目，不是三个列表里各散一份。

## 3. 非目标

- 不做 LLM 判「这句是不是新话题」：不可解释、有延迟、误切丢上下文。话题切换由**结构证据**（回复链）与**显式命令**决定，兜底是活跃窗口。
- 不改内核「同一会话同时只跑一轮」的并发规则；聊天忙时的排队在宿主（hub）。
- 不给每个话题建一个群。

## 4. 规格

### 4.1 数据契约

- `Conversation.threadId: Id | null`（投影列 `conversations.thread_id`，老行 / 老事实归一 `null`）。
- `ChatCreateCommand.input.threadId?`：给了就必须存在（`not_found` 拒绝），聊天 run 的 `run.threadId` 继承它（`chatRunRow`）。
  于是智能体在聊天轮里派出来的任务 / 子任务落进同一话题，而不是各开隐式线程。
- `TaskInput.threadId?`：可选的「在哪个话题下建任务」，缺省仍是隐式线程（`source='manual'`）。
- 话题身份沿用 `threads` 的 `(source, externalRef)`：`source='feishu'`、`externalRef` 由 hub 生成（不透明串，内核不认产品名）。

### 4.2 话题判定（优先级固定）

| 级         | 证据                                       | 说明                                  |
| ---------- | ------------------------------------------ | ------------------------------------- |
| 1 结构     | `thread_ref` / `root_ref` / `reply_to`     | 用户回复话题内任一消息 → 必然同一话题 |
| 2 显式     | `/new` `/topic <n>` `/done` `/topics`      | 用户自己声明，命令不进模型            |
| 3 活跃窗口 | 该 chat 最近一个 `open` 话题 + TTL 30 分钟 | 顺手接着聊的兜底                      |

同一 chat 有两个活跃话题时取 `lastActivityAt` 最新者，回执写明「接在『X』下」，不让用户猜。

### 4.3 入站与排队（宿主 hub，不改内核并发规则）

- 命中话题且会话空闲 → `chat.send` 到该会话（续接 `session_id`）。
- 命中话题但会话忙（`queued`/`running`/`waiting`）→ 进 hub 的排队表，run 落终态后排空；回执写「排在当前这轮后面」。
  现在的 `chat.send` 忙时 `conflict` 拒绝会直接丢话，这一条必须补。
- 未命中 → 建话题（`thread.opened`）+ 建会话（`chat.create{threadId}`）+ `chat.send`。

### 4.4 飞书侧

- 新话题发一条**话题头** interactive 卡（标题 / 状态 / 挂的任务数），其 `message_id` 作为话题锚点。
- 之后回执、进展、`ask` 卡一律 `im +messages-reply --reply-in-thread` 挂在话题头下（`--reply-in-thread` 已核实存在于 `lark-cli im +messages-reply`）。
- 收口时 patch 话题头为灰（结论 + 一句话状态）。话题头只在状态迁移时 patch（`running` → `waiting` → 终态），不每轮刷。
- 通道端口 5 → **6**：`submit(text, hints, agent)`，`hints = { ref, chatId, rootRef, threadRef, replyTo }`。通道只交平台结构证据，派给谁与话题归属由宿主决定。

### 4.5 workbench 侧

- 聊天栏的一级清单从「会话」换成「话题」：标题 + 状态徽标（执行中 / 等你 N / 空闲 / 已收口）+ 挂任务数 + 来源 + 最后活动。
- 话题页 = issue 时间线（消息 + run + 卡 + 任务事件混排），沿用 `TaskActivity` 的呈现形状。
- 看板仍按阶段分列，任务卡加话题徽标。

## 5. 任务分解（依赖顺序，每任务一个 RED→GREEN→回归→commit）

| #   | 任务                                                                                                                     | RED 落点                                                                                                  | 提交                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| T1  | `Conversation.threadId` + `chat.create{threadId}` + 聊天 run 继承话题（列 / DDL / 补列 / `KERNEL_VERSION=M47.0.0` 重建） | `tests/kernel/decide.chat.test.ts`、`tests/host/store/columns.test.ts`、`tests/host/db.test.ts`           | `feat(kernel): 会话挂在话题线程上，聊天 run 继承话题`   |
| T2  | 读视图：`threads.open`（按 `lastActivityAt` 倒序）+ `conversations.byThread`                                             | `tests/host/views.test.ts`（或既有 views 用例文件）                                                       | `feat(host): 话题线程与按话题取会话的读视图`            |
| T3  | hub 话题路由 + 忙时排队 + 回执文案（活跃窗口 TTL）                                                                       | `tests/host/channels.test.ts`                                                                             | `feat(channels): 入站消息按话题收敛，忙时排队不丢话`    |
| T4  | `InboundText` 增 `rootRef` / `threadRef` / `replyTo`（纯函数解析）                                                       | `tests/plugins/channels/feishu-inbound.test.ts`                                                           | `feat(feishu): 入站消息带上回复链证据`                  |
| T5  | 通道端口 6：`submit(text, hints, agent)`，飞书传结构证据，hub 优先用结构证据命中话题                                     | `tests/protocol/channels.test.ts`、`tests/host/channels.test.ts`、`tests/plugins/channels/feishu.test.ts` | `feat(channels): 入站提交带上平台结构证据（端口 6）`    |
| T6  | 飞书侧：`reply(..., {inThread})` / `replyCard`、话题头、进展与回执进线程、收口 patch                                     | `tests/plugins/channels/feishu.test.ts`                                                                   | `feat(feishu): 回执与进展落进话题线程，话题头承载状态`  |
| T7  | 话题命令：`/new` `/topics` `/topic <n>` `/done` `/help`                                                                  | `tests/host/channels.test.ts`                                                                             | `feat(channels): 话题命令（新建 / 列表 / 切换 / 收口）` |
| T8  | workbench 话题清单与话题页                                                                                               | `tests/renderer/...`（`ConversationList` 同位置）                                                         | `feat(ui): 聊天栏换成话题清单`                          |

每个任务完成时：`pnpm check`（类型 / lint / floor / kernel 预算 / secrets / ui + 覆盖率 + 改动行 + 审计）exit 0，再单独 commit。

### 施工记录（2026-11-16）

按依赖实际落地顺序 **T1 → T2 → T4 → T5 → T3**（原表里 T3 排第三是笔误：hub 的话题判定要用
T4 的回复链证据与 T5 的线索对象，先做会拿不到 chatId）。为此多出一片基础设施：

- `thread.open` 命令（T3 的入口）：话题原先只由事件归并或建任务时顺带产生，IM 入站需要
  「不带任务的起点」。命令面 39 → 40。
- 通道端口 6 的线索对象里补 `scope`（连接 / 应用标识）：话题前缀是 `<scope>:<chatId>:`，
  两个机器人各自的私聊因此不串台。

| 原编号                   | 状态   | 提交                                                  |
| ------------------------ | ------ | ----------------------------------------------------- |
| T1 会话挂在话题上        | 完成   | `feat(kernel): 会话挂在话题线程上，聊天 run 继承话题` |
| T2 读视图                | 完成   | `feat(host): 话题清单与按话题取会话的读视图`          |
| T4 入站回复链证据        | 完成   | `feat(feishu): 入站消息带上回复链证据`                |
| T5 端口 6                | 完成   | `feat(channels): 入站提交带上平台线索（端口 6）`      |
| — `thread.open`          | 完成   | `feat(kernel): thread.open——先有话题、后有任务`       |
| T3 hub 话题路由 + 排队   | 完成   | `feat(channels): 入站消息按话题收敛，忙时排队不丢话`  |
| T6 飞书侧落线程 + 话题头 | 未开始 | —                                                     |
| T7 话题命令              | 未开始 | —                                                     |
| T8 workbench 话题清单    | 未开始 | —                                                     |

### 修复记录（2026-11-16）

T1 漏了一处：`chat.create` 校验 `threadId` 必须存在，但 `view-spec` 里这条命令的切片只有
`agents` / `projects`——装载视图时 `threads` 是空表，hub 刚 `thread.open` 的话题立刻被判
`话题不存在: <id>`，飞书里每一句入站消息都回「没派出去：话题不存在」。切片补上 `threads`，
回归用例 `tests/host/store/chat-create-thread.test.ts`（真实 `viewSpec` + 真实投影；只走
`decide` 单测手搓 view 发现不了，`tests/kernel/scopes/view-spec.test.ts` 的期望值同批改正）。

## 6. 验收

- `pnpm check` exit 0（覆盖率不下降，改动行 ≥90%）。
- `pnpm e2e` 关键路径不回归（T8 之后跑）。
- 有真机飞书可用时人工走一遍：连发两句 → 同一话题；`/new` → 新话题；任务 ask 出现在话题线程里。

## 7. 已知边界

- 私聊里 `--reply-in-thread` 的客户端可见形态需真机确认；不支持则退回「话题头 + 普通 reply 链」，命中判据改为按 `reply_to` 反查锚点表。
- 话题头 `message_id` 是唯一跨重启锚点；内存里的活跃表只做加速，启动从 `threads.open` 补。
- `card.answer` 是单选语义，多个问题不合成一张卡；话题头只做索引。
- 群聊仍默认不收纯文本（沿用既有策略）。
