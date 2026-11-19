# Spec: authority（准入 · 授权 · 研判 · 注意力）

> Module id：`authority`。契约在 `packages/core/protocol/src/authority.ts`，纯函数在 `packages/core/kernel/src/scopes/{admission,mandate,assess,attention}.ts`。
> 索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)；总纲见 [ARCHITECTURE.md](../ARCHITECTURE.md)；本文是 [SPEC-kernel.md](./SPEC-kernel.md) 的增补域，域内冲突以本文为准。
> 定位：**纯内核域**。无 IO、无时钟、无随机数、无网络、无产品名。

## Objective

给「谁可以让它干活、凭什么、做到哪、撤了没、什么时候该闭嘴」这五件事一个唯一实现，让它们和任务流转、调度、卡片一样只在内核定义一次：

- **准入（admission）**：一条外部事件该不该进入规则匹配，以什么强度进入。
- **授权（mandate）**：一个任务凭什么被允许做、范围多大、哪版策略、何时失效。
- **研判（assess）**：把「规则字符串匹配不到、需要语义判断」的那一步做成一次可审计的执行，产出证据。
- **注意力（attention）**：哪些事情真的需要人，按什么顺序出现，其余一律不打扰。

**非目标：** 身份认证与凭据（宿主 `auth`）、HTTP 与 SSE（`api-http`）、通道投递（插件 `channel-*`）、面板布局（`app-ai-workflow`）、执行器进程管理（`plugins/executor-*`）。内核只产出事实与视图切片。

**来源：** `dsh-superagent-prototype` 的 Gate / Mandate / Assessment 语义，经事实日志落地；不引入它的 Engine、Store、Effects、轮询 pass 或面板实现。

## 命名纪律（先于一切）

仓库里已有三个近义词，本文的四类概念必须与之区分，代码里不得混用：

| 已有词                      | 现义                              | 落点                                              | 本文对应词                            |
| --------------------------- | --------------------------------- | ------------------------------------------------- | ------------------------------------- |
| `acceptance`                | 阶段验收：产出是否达标            | `scopes/workflow/acceptance.ts`                   | **不重叠**                            |
| `judge` / `GateVerdict`     | 判定阶段的结论（passed / failed） | `scopes/workflow/stage-machine.ts`、`entities.ts` | **不重叠**                            |
| `permissionMode` / `access` | 执行配置：能读、能改、能跑命令    | `entities.ts`（Agent）                            | `mandate.scope.access` 是它的**上限** |
| `approval`                  | 执行器的提权请求（今天只读审计）  | `api/http/run-approvals.ts`                       | `approval.*`，升级为事实              |

规则：**判定「产出」用 acceptance / judge；判定「这件事该不该接、谁授权、做到哪」用 admission / mandate；判定「语义上属于哪一类活」用 assess。**

## 概念

| 概念                         | 是什么                                                                 | 谁写                 |
| ---------------------------- | ---------------------------------------------------------------------- | -------------------- |
| **来源身份（identity）**     | 事件发起者在来源内的稳定标识与是否点名；`kind` 分 human / bot / system | source 插件 → 宿主   |
| **来源策略（SourcePolicy）** | 一个来源的允许名单、机器人名单、准入表                                 | 用户配置（规则集内） |
| **准入（admission）**        | 身份 × 名单 × 准入表 × 接受模式 → `explicit` / `inferred` / 拒绝       | 内核纯函数           |
| **强度（strength）**         | `explicit`（明确请求）/ `inferred`（推断候选）                         | 同上                 |
| **接受模式（mode）**         | `off` 不接推断 / `observe` 只记「本来会接」/ `auto` 允许自动接单       | 用户配置             |
| **授权（Mandate）**          | 任务凭以执行的凭据：范围、强度、依据、策略版本、撤销状态               | 内核                 |
| **研判（assess）**           | 一次 `purpose='assess'` 的运行：对一批候选逐条启用规则给判定与证据     | 执行器回执           |
| **提权请求（approval）**     | 执行器在运行中申请越过当前权限的动作                                   | 宿主观察 → 事实      |
| **注意力（attention）**      | 需要人处理的事项集合（卡、提权、被撤授权、阻塞、失败）                 | 内核派生             |

## 类型契约

```ts
// packages/core/protocol/src/authority.ts
import type { Access, Id, Iso } from './entities'

export type SourceKey = 'manual' | 'app' | 'webhook' | 'feishu' | 'github'
export type IdentityKind = 'human' | 'bot' | 'system'

export interface ApprovalRecord {
  id: Id
  runId: Id
  taskId: Id
  tool: string
  reason: string
  withinMandate: boolean
  autoAllowed: boolean
  decided: 'allowed-once' | 'denied' | null
  at: Iso
}

export type AttentionKind = 'ask' | 'approval' | 'revoked' | 'blocked' | 'failed'

export interface AttentionItem {
  /** 稳定键：`<kind>:<cardId|runId|mandateId|taskId>` */
  id: string
  kind: AttentionKind
  since: Iso
  taskId: Id | null
  runId: Id | null
  cardId: Id | null
  title: string
  /** 一句话：为什么需要人（确定性文案，不含模型自由文本） */
  why: string
  action: 'answer' | 'allow-deny' | 'renew' | 'retry' | 'open'
}
```

`Authority` **不单独成表、不单独版本**：它作为 `RuleSetRow.authority` 的一个可选块随 `rules.replace` 整批替换。理由：任何第二份配置都等于第二个真相源，而 `rulesVersion` 已经是「凭什么」的唯一版本号，Mandate 记的就是它。

## 函数

| 函数                                                     | 职责                                                 | 约束                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `admit(view, event, authority): Admission`               | 身份与来源策略 → 强度 / basis / 结论                 | 纯；模式为 `off` 且非 explicit → 拒绝；来源无策略且兼容模式 → `explicit/addressed` |
| `grant(view, taskId, admission, policyVersion): Mandate` | 按命中的规则与任务阶段算出范围，发 `mandate.granted` | 纯；范围缺省来自规则目标与智能体权限，越界字段按上限截断                           |
| `revoke(mandate, reason, at): Mandate`                   | 撤销（人工停止 / 重校验失败 / 策略变化）             | 纯；已撤销幂等返回同值                                                             |
| `revalidate(view, mandate): { ok, reason }`              | 恢复新一轮前、以及换版时校验授权是否仍成立           | 纯；按 `basis` 分支（见 §授权生命周期）                                            |
| `assessmentOutcome(verdicts, rules, mode): Assessment`   | 校验「每条启用规则恰好一次 + 证据齐备」，折算结论    | 纯；缺覆盖或缺证据 → `via='failed'`，不接单                                        |
| `assessBatch(pending, authority, now): Candidate[]`      | 攒批、去重、上限截断                                 | 纯；同事件只进一批，批内按 `receivedAt` 升序                                       |
| `attentionOf(view): AttentionItem[]`                     | 派生需要人的事项并排序                               | 纯；分类规则只在这里，宿主只装切片                                                 |
| `runAccessOf(agent, mandate): Access`                    | 运行期权限取交集                                     | 纯；供 `task-effects` 折算 `run.access`                                            |

**单写入者不变**：以上函数只被 `decide` 的 handler 调用，只产出 `FactDraft[]`；写库仍只在宿主一次事务里。`decide.ts` 只加三行表项，不放业务分支（`decide.ts` ≤220 行预算）。

## 输入

| 输入                                | 来源                         | 前置校验                                                                                                                                     | 事实                                                                                                                                     |
| ----------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `event.received`（扩字段）          | source 插件 / 回执派生 / app | `identity` 必填：`webhook` / `github` / `feishu` 缺失即拒收；`manual` / `app` / 回执派生缺省 `{kind:'system', id:'unknown', addressed:true}` | 原事实 + `identity`；随后按准入结论产 `event.admitted` 或 `event.denied`                                                                 |
| `rules.replace`（扩字段）           | owner（规则页整批保存）      | `authority` 可选块：模式枚举、来源 id 唯一、名单 ≤200 条、单元格枚举、`assessBatch` 1–20、`assessWindowMs` 0–60000                           | `rules.replaced`（版本 +1）；省略 `authority` = 保持现值；显式 `null` = 清除（回兼容模式）；换版时对在跑任务逐条产 `mandate.revalidated` |
| `run.receipt`（`purpose='assess'`） | 执行器插件                   | `assessments[]` 形状校验；**禁止 `events[]` / `ask[]` / `spawn[]`**（研判 run 不得派生副作用）；`leaseId` + `turn` 匹配                      | `assess.decided` + 终态事实；被拒时 `run.receipt_rejected{reason}`                                                                       |
| `approval.request`                  | 宿主（执行器桥接转交）       | run 属于该任务、`approvalId` 未出现过                                                                                                        | `approval.requested`；范围内 → 同时 `approval.decided{allowed-once}`；越界 → `card.opened` + `run.waiting`                               |
| `approval.decide`                   | owner（UI）或通道回答        | `approvalId` 存在且未决、run 处于 `waiting`                                                                                                  | `approval.decided{allowed-once\|denied}` + 续接 `run.queued`（deny 时 run 落 `blocked`）                                                 |
| `task.stop`（扩语义）               | owner                        | 同现状                                                                                                                                       | 现有 `run.cancel_requested` + 新增 `mandate.revoked{reason:'stop'}`                                                                      |

## 事实

新增 9 类，扩展 1 类；每条仍遵守「一行事实 → 一行投影」。

| 事实                   | payload 关键字段                                                                                                         | 投影                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `event.received`（扩） | 原字段 + `identity: EventIdentity`                                                                                       | `events` 增 3 列（§投影）                                           |
| `event.admitted`       | `eventId, ruleId, strength, basis, mode, policyVersion`                                                                  | —（审计；匹配与去重仍由 `task.created` 表达）                       |
| `event.denied`         | `eventId, ruleId \| null, reason: 'not-listed'\|'mode-off'\|'bot-not-listed'\|'no-rule'\|'assess-failed', policyVersion` | —（审计；与「规则停用」的 `event.skipped` 严格区分）                |
| `mandate.granted`      | `mandate: Mandate`（整行）                                                                                               | `mandates`                                                          |
| `mandate.revoked`      | `mandate: Mandate`（整行，`revokedAt/Reason` 已填）                                                                      | `mandates` + `tasks.mandate_*`                                      |
| `mandate.revalidated`  | `mandateId, taskId, ok, reason, policyVersion`                                                                           | —（审计；`ok=false` 同时产 `mandate.revoked{reason:'revalidate'}`） |
| `assess.decided`       | `assessment: Assessment`（整行）                                                                                         | `assessments`                                                       |
| `approval.requested`   | `approval: ApprovalRecord`（整行，`decided=null`）                                                                       | `approvals`                                                         |
| `approval.decided`     | `approval: ApprovalRecord`（整行，`decided` 已填）                                                                       | `approvals`                                                         |
| `policy.impacted`      | `version, taskIds: string[], kinds: ('rule-changed'\|'rule-removed'\|'requester-unlisted'\|'mode-narrowed')[]`           | —（审计；驱动一条聚合通知）                                         |

事实名总数以 `FACT_TYPES`（`packages/core/protocol/src/facts.ts`）为准，当前 71 项。`FACT_TYPES`、`FactPayloads`、`validate.ts` 的命令名/输入名白名单三处同步，缺一处即编译期失败。

## 投影

| 表                  | 列（除通用 id/timestamps）                                                                                                     | 说明                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `mandates`（新）    | `task_id, scope_json, strength, basis, policy_version, rule_ids_json, by_json, granted_at, revoked_at, revoked_reason, legacy` | 一任务一行（最新一次授予）；`legacy=1` 的存量任务在 UI 标「历史任务，无授权记录」 |
| `assessments`（新） | `event_id, policy_version, rule_ids_json, verdicts_json, decision, would_accept, via`                                          | 一事件一行（最新一版）；`would_accept=1` 供 `observe` 期复盘                      |
| `approvals`（新）   | `run_id, task_id, tool, reason, within_mandate, auto_allowed, decided, at`                                                     | 一 `approvalId` 一行                                                              |
| `events`（扩）      | `+ identity_kind, identity_id, addressed`                                                                                      | 供准入视图与列表筛选；老行为 `system/unknown/1`                                   |
| `tasks`（扩）       | `+ mandate_id, mandate_strength`                                                                                               | 看板与详情页免 join；`legacy` 任务两列为空                                        |

重建与指纹照 [SPEC-kernel.md](./SPEC-kernel.md#重建与指纹) 执行。**顺序铁律**：先加 `normalizeIdentity` / `normalizeAuthority` / `normalizeMandate`（读旧 payload 补缺省），再改 DDL 与契约；颠倒会让老库首启重建失败。`KERNEL_VERSION` 升一档即触发全量重建；投影表清单以 `PROJECTION_TABLES`（`packages/core/kernel/src/core/types.ts`）为准，当前 21 张。

## 视图

| 视图                | 参数         | 内容                                                                                   |
| ------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `attention.open`    | 无           | `AttentionItem[]`，见 §注意力分级。**唯一**「需要我」入口                              |
| `mandates.byTask`   | `{ taskId }` | 授权整行 + 校验结论（是否仍成立、为什么）                                              |
| `authority.current` | 无           | 当前 `mode`、各来源名单/准入表、研判智能体、`policyVersion`、`wouldAccept` 近 7 天计数 |
| `assess.pending`    | 无           | 待研判候选（`assessWindowMs` 内攒着的事件），供 UI 解释「为什么还没接单」              |

`VIEW_IDS` 当前 47 项（`packages/core/protocol/src/views.ts`）；`attention.open` 与 `assess.pending` 尚未落地（见「里程碑」A4）。每个新视图必须在 `viewSpec` 里声明最小切片（`attention.open` 落成时只装 `cards`/`runs`/`tasks`/`mandates`/`approvals` 的活跃行，`tasks` 用索引切片，不全表）。

## 模式矩阵

行是事件类别（由身份 × 是否点名 × 名单决定），列是 `mode`。`explicit` 在所有模式下都成立；差异只在推断候选。

| 事件类别                        | off                            | observe（建议缺省）              | auto               |
| ------------------------------- | ------------------------------ | -------------------------------- | ------------------ |
| 名单内 · 点名                   | 接单（explicit）               | 接单（explicit）                 | 接单（explicit）   |
| 名单内 · 未点名（receiveAll）   | `event.denied{mode-off}`       | 候选 → 研判 → 只记 `wouldAccept` | 候选 → 研判 → 接单 |
| 名单外 · 点名                   | `event.denied{not-listed}`     | 同上（inferred）                 | 同上（inferred）   |
| 名单外 · 未点名                 | `event.denied{not-listed}`     | `event.denied{not-listed}`       | 同上（inferred）   |
| 机器人（在 bots 名单）          | `event.denied{mode-off}`       | 只记 `wouldAccept`               | 候选（inferred）   |
| 机器人（不在名单）              | `event.denied{bot-not-listed}` | 同左                             | 同左               |
| 手工 / 系统（`manual` / `app`） | 接单（explicit, basis=manual） | 同左                             | 同左               |

**兼容模式**：规则集没有 `authority` 块时，上表退化为「全部接单（explicit, basis=manual）」，即今日行为；统计视图显示 `mode='compat'`，提示「准入未开启」。

## 准入表

- 作用域按来源定义：`webhook`（每个 webhook 端点）、`github`（issues / pull_request / comment / ci 四类）、`feishu`（每个会话：仅 @ / 全部消息）、`app`（每个 app 事件类型）、`manual`（不参与准入）。
- 单元格缺省值见类型契约注释；`listedUnaddressed` / `unlistedUnaddressed` 仅在 `receiveAll=true` 时生效，否则一律按「点名」格判定（与 SPEC-kernel 的「事件必须点名」口径一致）。
- 准入表属于 `authority` 块，随 `rules.replaced` 一次提交；**新增来源必须显式列入 `sources`**，未列入的来源在非兼容模式下按 `not-listed` 拒绝并记 `event.denied`。

## 授权生命周期

```
（事件准入通过）──grant──▶ active ──stop──▶ revoked(stop)
                            │ ──revalidate 失败──▶ revoked(revalidate)
                            │ ──换版后 basis 不再成立──▶ revoked(policy)
                            └──任务完成──▶ active（授权随任务保留，供追溯；不再派活）
存量任务 ──不补发──▶ legacy
```

| 规则          | 口径                                                                                                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 授予          | 只在 `task.created` 的同一批事实里；范围取规则目标（工作流/阶段/项目）+ 智能体权限上限；`maxRuns` / `maxTokens` / `expiresAt` 缺省 null（不限）                                                                                     |
| 撤下          | 只有三种：`task.stop`（人）、恢复前重校验失败、换版后 basis 不再成立。任务完成**不**撤销                                                                                                                                            |
| 恢复前重校验  | 新一轮 `run.claim` 之前判：来源仍在 `sources`、规则仍启用、`basis` 仍成立（见下表）、未过期、未超 `maxRuns` / `maxTokens`。失败 → `mandate.revalidated{ok:false}` + `mandate.revoked` + 该任务后续输入转 `event.denied{no-mandate}` |
| 换版          | 逐条算影响，只对受影响任务产事实与一条聚合通知（`policy.impacted`）；**不中止在跑的 run**，下一轮领取时按新版本校验                                                                                                                 |
| 手工任务      | `basis='manual'`，撤销只有人；重校验恒过                                                                                                                                                                                            |
| 暂停/停用规则 | 等价 `mode='off'` + 对应规则停用：已授出的授权在下次领取时按新版本重校验                                                                                                                                                            |

`basis` → 重校验条件（缺一不可）：

| basis       | 重校验要求                                                        |
| ----------- | ----------------------------------------------------------------- |
| `addressed` | 该身份仍在 `allowed`                                              |
| `followup`  | 该身份仍在 `allowed`，或来源策略的 `unlistedAddressed='explicit'` |
| `table`     | 今天同一类别单元格仍给出 ≥ 原强度                                 |
| `bot`       | 该机器人仍在 `bots` 名单，且 `mode='auto'`                        |
| `manual`    | 恒过                                                              |

## 研判契约

1. **攒批**：候选（准入为 `inferred` 且未被拒绝的事件）按来源攒批，最多 `assessBatch` 条或等满 `assessWindowMs`，同来源同时只有一个研判 run。
2. **执行**：`purpose='assess'`、`hops=0`、智能体 = `authority.assessorAgentId`（null → 跳过研判，直接按模式记 `wouldAccept` 或接单）。提示词由 `scopes/prompt.ts` 新增 `# 研判（本轮只做判定，不做工作）` 段生成，段内只有：启用的规则清单（id + 名称 + 说明）、候选事件字段（**已校验**的 type/subject/link）、资料文件路径。规则说明是用户写的配置文本，事件正文只以资料文件出现。
3. **回执**：只接受 `assessments[]`，每条形如 `{ ruleId, match, evidence }`；`asked/notices/events/spawn/later/verdict` 一律拒收并记 `run.receipt_rejected`。
4. **校验**（`assessmentOutcome`）：必须覆盖当前启用的**每条**规则恰好一次；`match=true` 必须带非空 `evidence`；顺序不限。任一不满足 → `via='failed'`，该批不接单，候选按 `notBefore` 重试一次，二次失败记 `event.denied{assess-failed}`。
5. **结论**：`decision='accept'` 需至少一条 `match=true`；`observe` 下强制 `decision='ignore'` 且 `wouldAccept=true`，UI 在规则页显示「本来会接」清单。
6. **副作用禁令**：研判 run 不得产生 `task.created`、`run.queued`、`event.received`；断言由 `event.denied{no-rule}` 兜底（命中不到规则也算不接单）。
7. **预算**：研判 run 计入 `usage.*`，按 `assessorAgentId` 单独可见；`usage.byAgent` 新增一行 `purpose='assess'` 维度，便于看「研判一个月花了多少」。

## 提权

1. 执行器遇到需提权的工具调用 → 桥接层改为**先问宿主**（不再恒回 `allowed-once`）→ 宿主发 `approval.request{runId, tool, reason}`。
2. 内核判定：`withinMandate = mandate.scope.access` 覆盖该动作 **且** 工具在 `autoAllow` 列表（随 `authority` 配置）**且** 授权未撤销未过期。
3. 范围内 → `approval.decided{allowed-once}` + 记事实，run 继续；**不打扰人但必须留痕**（今天 `run-approvals` 只读会话日志，正是「无声」的来源，这一步把它变成事实）。
4. 越界 → `card.opened{kind:'ask', key:'approval:<approvalId>'}` + `run.waiting`（释放租约与并发位，口径同 SPEC-kernel §审批）。人答「拒绝」→ `approval.decided{denied}` + run 落 `blocked`（终态 `failed{errorCode:'approval_denied'}`），不留半改状态。
5. 卡片 20 分钟超时（`cards.ts` 现有规则）到点按「拒绝」处理，原因记 `timeout`。
6. 审计视图 `run.approvals` 保留（读会话日志），但**事实成为权威**；两者不一致时以事实为准，日志只作执行器侧证据。

## 注意力分级

`attentionOf(view)` 只做五类，`notice` 卡**永不进入**（信息卡留在任务详情与顶部条的次要区）。

| 顺序 | kind       | 来源                                                                                  | `why` 文案（确定性）                     | action     |
| ---- | ---------- | ------------------------------------------------------------------------------------- | ---------------------------------------- | ---------- |
| 1    | `ask`      | `cards.status='open' && kind='ask'`                                                   | 「等你回答：<卡标题>」                   | answer     |
| 2    | `approval` | `approvals.decided IS NULL`（或已开卡待答）                                           | 「<工具> 超出授权范围，等你放行」        | allow-deny |
| 3    | `revoked`  | `mandates.revoked_at IS NOT NULL` 且任务未完成                                        | 「授权已撤（<原因>），后续输入不会再接」 | renew      |
| 4    | `blocked`  | `runs.status='failed' && error_code IN ('approval_denied','run_failed')` 且任务未完成 | 「任务受阻，等你决定重试或放弃」         | retry      |
| 5    | `failed`   | `runs.status='failed' && error_code='executor_lost'` 且在 24 h 内                     | 「执行器失联，已停」                     | retry      |

- 排序：kind 序 → `since` 升序 → `id`；同一任务多条 `ask` 合并为一条并带 `count`（UI 展开）。
- 上限 200 条，超出按顺序截断并在视图里给 `truncated: true`。
- 「不打扰」硬规则：`notice`、已 `resolved` 的卡、`task.completed` 的任务、人自己点的完成，一律不进。

## 兼容、重建与迁移

| 情况                                      | 口径                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 规则集无 `authority` 块                   | 兼容模式：全部 explicit，行为等价 M45；`authority.current` 显示 `compat`                                      |
| 老 `event.received` payload 无 `identity` | 归一为 `{kind:'system', id:'unknown', addressed:true}`，`events.identity_kind='system'`；**不伪造**真实发起者 |
| 存量任务（A1 前创建）                     | 不补发 `mandate.granted`；`mandates` 无行，UI 标 `legacy`；`attention.revoked` 不对其触发                     |
| 存量的 `run.approvals`（只读日志）        | 不迁移为事实（保持「导入不伪造因果」原则），仅后续新提权入账                                                  |
| `KERNEL_VERSION`                          | 升一档；投影表随之变化（清单见 `PROJECTION_TABLES`）；首启全量重建，历史行为由事实日志保留                    |
| 契约演进顺序                              | 先 `normalize*` 再改 DDL/契约（同 [SPEC-kernel.md](./SPEC-kernel.md#重建与指纹) 的教训）                      |

## 约束与预算

- **纯度**：本域的四个文件不得出现 `node:*`、`Date.now`、`Math.random`、`fetch`、跨层 import；`tests/kernel/purity.test.ts` 的扫描范围扩到这四文件。
- **行数**：`scripts/check-kernel-budget.mjs` 定两个预算——`core/` ≤2000 行、单个 `scopes/<域>` ≤900 行、`decide.ts` ≤220 行；不设逐文件细表（`admission.ts` / `mandate.ts` / `assess.ts` 各自落在 `scopes/` 的 900 行上限内）。`decide.ts` 只加表项。
- **禁止**：新增配置表或配置文件（`authority` 只在 `rule_sets` 行内）；新增插件类型；在 `admit` 里调用模型；把 `assess` 结论直接写成 `task.created` 而不经 `admission`/`mandate`。
- **性能**：`attention.open` 的装载 + 派生 p99 ≤ 8 ms（与「装载 + decide」同一预算口径）；单批研判 ≤20 条候选、≤80k 字符提示词。

## 错误

| code            | 触发                                                                  |
| --------------- | --------------------------------------------------------------------- |
| `invalid_input` | `identity` 缺失（外部来源）、`authority` 形状非法、`assessBatch` 越界 |
| `forbidden`     | 非 owner 调 `approval.decide`；对已撤销任务派活                       |
| `not_found`     | `approvalId` / `mandateId` 不存在                                     |
| `conflict`      | `approvalId` 已决、`card` 非 open、`turn` 或 `leaseId` 不匹配         |
| `unsupported`   | 研判 run 的回执带 `events[]` / `ask[]` / `spawn[]`                    |

准入拒绝**不是**错误：它是 `event.denied` 事实（审计可见，不打断来源）。

## 测试

| 测试                                         | 覆盖                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/kernel/admission.test.ts`             | 模式矩阵每格一条（7 类 × 3 模式）；名单/机器人/receiveAll；兼容模式退化为 explicit；`identity` 缺失拒收                                          |
| `tests/kernel/scopes/mandate.test.ts`        | 授予范围计算（阶段/项目/权限上限）、`runAccessOf` 取交集、五种 basis 的重校验、`stop` 撤销、换版影响面、存量任务 legacy 不触发注意力             |
| `tests/kernel/scopes/assess.test.ts`         | 攒批与上限、覆盖校验（漏一条/多一条/证据缺失）、`via='failed'` 的重试与 `denied{assess-failed}`、observe 的 `wouldAccept`、研判 run 派生事件被拒 |
| `tests/kernel/attention.test.ts`（A4，未建） | 五类排序、notice 不进入、同任务 ask 合并与 count、200 条截断、完成/已解卡片排除                                                                  |
| `tests/protocol/authority.test.ts`           | `authority` 校验边界（名单条数、枚举、上限）、`identity` 白名单、事实 payload 全等                                                               |
| `tests/host/approval.test.ts`（A4，未建）    | 范围内自动放行留痕、越界开卡并释放租约、拒绝回执行器、20 分钟超时按拒绝                                                                          |
| `tests/host/schema.test.ts`（扩）            | 22 表重建等价；老事实归一后 `events.identity_*` 为 `system`                                                                                      |
| `tests/e2e/api-only.spec.ts`（扩）           | 「webhook 事件 → 无权 → 拒绝」与「有权 → 研判 → 接单 → 越界提权 → 卡片 → 放行」两条端到端                                                        |
| `tests/kernel/purity.test.ts`（扩）          | 新四文件纯度扫描                                                                                                                                 |

**决策黄金测试不变式**：同一 `(view, input, now, env)` 重复决策结果全等；`attentionOf` 同输入同序；准入与研判都不读时钟（`now` 由边界传入）。

## 里程碑与验收

> 状态（2026-11-19）：**A1 / A2 / A3 已落地**（scopes/{admission,mandate,assess}.ts、mandates / ssessments 投影、uthority.current 视图、规则页授权编辑区）；**A4 未开工**——ttention.ts、ttention.open、ApprovalRecord / AttentionItem 全仓零实现，
> un-approvals.ts 仍是只读日志。

| 里程碑                             | 内容                                                                                                                                    | 验收                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **A1 准入**（约 2 周）             | `authority.ts` 契约、`admission.ts`、`event.received.identity`、`event.admitted/denied`、`authority.current` 视图、规则页「授权」编辑区 | 模式矩阵 21 条用例全绿；兼容模式零行为变化（现有 e2e 一条不改仍过）；`pnpm check` 全绿                           |
| **A2 授权**（约 2 周）             | `mandate.ts`、`mandates` 投影、`tasks` 两列、恢复前重校验、换版影响面 + 聚合通知、任务详情「授权」面板                                  | 任一任务能答五问（谁/凭哪条/什么强度/多大范围/哪版）；换版后 `policy.impacted` 列出受影响任务；存量任务标 legacy |
| **A3 研判**（约 2–3 周）           | `assess.ts`、`purpose='assess'` run、提示词段、`assessments` 投影、`assess.pending` 视图、observe 复盘清单                              | 覆盖/证据校验用例全绿；研判 run 无法派生副作用；`observe` 期自动接单数 = 0                                       |
| **A4 注意力与提权**（约 1.5–2 周） | `attention.ts`、`attention.open` 视图、`AttentionPanel`、`approval.*` 事实与桥接改造、`run.approvals` 降级为证据                        | 五类排序用例全绿；提权 100% 有事实；`notice` 不进顶部条；`pnpm check` + `e2e` 全绿                               |

每个里程碑的完成门槛固定：`pnpm check` 全绿（含 `check:kernel` 预算与 `check:diffcov`）、新增测试文件进 `docs/testing/TEST-CASES.md`、`docs/testing/ACCEPTANCE.md` 补人工走查行、无新增第三方依赖。

## 不吸收的部分

| 明确不做                                               | 理由                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `dsh-superagent` 的 Engine / Store / Effects / 2s pass | 本仓已有事实日志 + 投影 + 租约 + 单定时器；换过去等于丢掉重建与纯度 |
| 它的 Thread / Subscription 模型                        | 本仓线程已是状态实体（`threads` 投影 + 串行闸门 + 派生上下文）      |
| 它的常驻主 Session 研判                                | 改为 `purpose='assess'` 的一次 run，成本与打断都更低                |
| 它的面板与迁移脚本                                     | 只用信息架构；本仓迁移是 `format` 重建                              |
| `agent-autoloop` 的 `rules.json` 文件源                | 规则只从 DB 事实来，避免双真相源                                    |
| 远端 worker / 多机领取                                 | 本域不引入新传输；`approval` 与失败恢复都在本机闭环                 |
