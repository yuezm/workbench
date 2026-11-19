# SPEC — 准入与授权（A1–A4）

> 本文件是**当前工作计划的规格入口**（`/agent-skills-build auto` 只认仓库根 / `docs/SPEC.md` / `spec/`）。
> 长期真相源是 [SPEC-authority](specs/SPEC-authority.md)（契约、事实、投影、视图、模式矩阵、里程碑），本文件是本次施工的规格摘要与验收口径。
> 取代关系：原「飞书话题收敛（M47）」以聊天为承载体，而 `6fbd392` 已把产品切成纯自动化（界面无聊天入口）；该计划随载体消失作废，历史留在 git 里。

## 1. 问题

工作台已经能「收事件 → 按规则建任务 → 派给智能体 → 记账」，但有三处缺口让外部事件不能放心接进来：

1. **没有发起者身份**：`event.received` 只有来源与类型，全库 17 条真实事件没有一条答得出「谁让它做」（`facts.ts:383-396`）。
2. **没有准入与授权**：规则只有 `enabled`，事件命中即建任务；规则换版不通知在跑任务，恢复新一轮也不校验授权是否还成立（`rules.ts:93-105`、`run.ts:99-122`）。
3. **沉默的放行与散落的打扰**：执行器提权恒回 `allowed-once`，只落会话日志（`run-approvals.ts:1-12`）；「需要人」散在 `cards.open` / `runs.waiting` / `run.approvals` 三处，38 张卡里 34 张是 `notice`。

## 2. 目标

把 superagent 的 Gate / Mandate 语义落进现有事实日志，**不新增基础设施**：

- **准入（admission）**：身份 × 名单 × 准入表 × 接受模式 → `explicit` / `inferred` / 拒绝，纯函数，不花 token。
- **授权（mandate）**：任务被授予范围与依据，记规则集版本；恢复新一轮前重校验，换版只通知不中止。
- **研判（assess）**：规则匹配不到时的一次 `purpose='assess'` 运行，每条启用规则给判定与证据；`observe` 期只记「本来会接」。
- **注意力（attention）**：`attention.open` 一个入口，五类排序；`notice` 永不进入。

## 3. 非目标

- 不改阶段语义与 `acceptance` / `judge`（产出达标判定）——准入门与验收门是两件事，不共用事实。
- 不引入 `rules.json` 文件源、配置表或第二版本号：`Authority` 随 `rule_sets` 整批替换，版本号就是 `rulesVersion`；`rules.replace` 省略该块表示**保持现值**，显式 `null` 表示清除（回兼容模式）。
- 不做远端 worker、多机领取、计费结算。
- 不搬 superagent 的 Engine / Store / Effects / 轮询 pass / 面板实现。

## 4. 规格（A1 准入）

完整契约见 [SPEC-authority](specs/SPEC-authority.md)。A1 施工只取其中四块：

### 4.4 接线（`scopes/commands/common.ts` + `view-spec.ts` + store）

- `receivedEventFacts` 在建任务前先判准入：`allow=false` 只产 `event.denied`，不建任务；`allow=true` 产 `event.admitted` 后照旧建任务。
- `View.authority` 新切片（来自 `rule_sets.authority_json`），`viewSpec('event.received'|'app.event'|'rule.trigger'|'clock.tick')` 已有 `rule_sets`，无需新增表。
- 宿主：`rule_sets` 增列 `authority_json`，`rules.replace` 接受 `authority`，投影写入 + 老行归一。

## 5. 验收

- `pnpm check` 全绿（typecheck / lint / floor-guard / kernel 预算 / secrets / ui / packages / paths / 覆盖率 / diffcov / audit）。
- `pnpm build` 成功；`check:kernel` 打印 `core` 行数不增、`admission.ts` ≤420 行。
- 新增用例（`tests/kernel/admission.test.ts`、`tests/protocol/authority.test.ts`）覆盖模式矩阵 7×3 = 21 格。
- **兼容模式零行为变化**：现有 `tests/kernel/commands*.test.ts` 与 `tests/host/*` 一条不改仍过；未配置 `authority` 的规则集，事件照旧建任务。
- 存量数据：老 `event.received` 事实重建后 `identity_kind='system'`；规则集无 `authority` 时视图 `authority.current` 报 `mode='compat'`（A1 后半）。

## 6. 任务清单

见 [tasks/a1-plan.md](../tasks/a1-plan.md)。执行顺序按依赖：T1 契约 → T2 事实 → T3 判定 → T4 接线 → T5 视图 → T6 规则页。
