# 实施计划：A3 研判（assess）

> 规格：[SPEC-authority](../docs/specs/SPEC-authority.md) §研判契约 §事实 §投影；[docs/SPEC.md](../docs/SPEC.md) §4。
> 目标：规则字符串匹配不到时，用一次 `purpose='assess'` 的运行判断「这条事件属于哪一类活、值不值得接」，
> 产出可审计的判定与证据；`observe` 期只记「本来会接」，不自动接单。
> 本阶段不做：注意力面板与提权闸门（A4）。

## 已定口径（施工前先落这些决定）

| #   | 决定                                                                                             | 理由                                                                                  |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| D1  | 研判是**一次普通 run**（`purpose='assess'`），不是常驻主会话                                     | 复用租约 / 续会话 / 回执校验；成本按候选数计；superagent 的常驻主会话正是要避免的形态 |
| D2  | 研判 run 禁止派生副作用：回执只收 `assessments[]`，`events` / `ask` / `spawn` / `later` 一律拒收 | 否则「研判 → 事件 → 研判」自我放大；与 hops 熔断同层防护                              |
| D3  | `assessBatch` / `assessWindowMs` 来自 `Authority`（默认 8 条 / 5s）；同来源同时只跑一个研判      | 攒批降本，避免同源并发互相覆盖结论                                                    |
| D4  | 结论必须覆盖**当前启用的每条规则恰好一次**，`match=true` 必须带非空 `evidence`                   | 缺覆盖/缺证据 → `via='failed'`，该批不接单（宁可漏接，不可瞎接）                      |
| D5  | `observe` 下 `decision` 恒 `ignore`、`wouldAccept=true`；`auto` 下才可能接单                     | 先看影子结论再开自动，是 A1 已落地的模式语义                                          |
| D6  | 研判 run 的 `hops` 恒 0，不计入熔断链                                                            | 它不是「Agent 派生的事件」，是内核发起的一次判定                                      |
| D7  | 研判智能体取 `Authority.assessorAgentId`；为 null 时**不建研判 run**，直接按模式处理             | 没有研判配置就退化成 A1/A2 的行为，不静默吞事件                                       |

## 任务

| #     | 任务           | 落点                                                                                                                                                             | RED                                                                                             | 完成判定                   |
| ----- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------- |
| A3-T1 | 事实与投影     | `protocol/facts.ts`（`assess.decided`，payload `{ assessment }`）、`kernel/types.ts`（第 21 张表 `assessments`）、`host/store`（列形状 / DDL / 写读 / 表数断言） | `tests/kernel/scopes/assess-projection.test.ts`：整行落表、重建等价                             | 全量回归绿；表数断言同步   |
| A3-T2 | 结论折算纯函数 | `kernel/scopes/assess.ts`：`assessmentOutcome(verdicts, rules, mode, wouldAccept)` + 覆盖/证据校验 + `assessBatch` 攒批                                          | `tests/kernel/scopes/assess.test.ts`：漏一条 / 多一条 / 缺证据 / 空规则集 / observe 强制 ignore | 矩阵用例全绿               |
| A3-T3 | 研判 run       | `scopes/assess.ts` 建 `run.queued{purpose:'assess'}`；`view-spec` 装 `rule_sets`/`events`/`tasks`；回执分支只认 `assessments[]`                                  | `tests/kernel/assess-run.test.ts`：从候选到 run.queued、回执结论落 `assess.decided`、越权段被拒 | 副作用被拒的用例必须真失败 |
| A3-T4 | 接线           | `receivedEventFacts`：`inferred` 候选进攒批而不是直接建任务；结论落地后建任务或 `event.denied{no-rule}`                                                          | `tests/kernel/assess-admission.test.ts`：observe 期自动接单数 = 0；auto 期命中才建任务          | 现有 A1 用例不改仍过       |
| A3-T5 | 视图与面板     | `assess.pending` 视图、规则页「本来会接」清单（读 `assessments`）、`usage.byAgent` 增加 `assess` 维度                                                            | `tests/host/store/assess-view.test.ts`、`tests/renderer/.../WouldAcceptPanel.test.tsx`          | 组件用例绿；`check:ui` 过  |

## 执行纪律

- 每个任务：RED → GREEN → 全量回归（`pnpm test`）→ `pnpm build` → 单独 commit，不 `git add -A`。
- 先跑全量再提交：本轮 A2-T4 出现过「先提交后看测试」导致 `task.byId` 分支被误吞，靠下一条提交修；
  A3 起 `pnpm test && pnpm build` 通过后才允许 commit。
- 研判结论只是建议：规则仍是唯一指令入口，`event.denied` 与 `event.skipped` 分开记。
