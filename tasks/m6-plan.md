# 实施计划：M6 自动化规则（规则事实 / 事件建任务 / cron / 规则页）

> 依据 [refactor-plan](../docs/planning/refactor-plan.md) M6 行、[SPEC-kernel](../docs/specs/SPEC-kernel.md)「规则」「事实目录」「调度」、[SPEC-plugins](../docs/specs/SPEC-plugins.md)（source / app 事件）、[SPEC-host](../docs/specs/SPEC-host.md)（clock / 启动顺序）。
> 起点：`master` @ `2f06970`（M5 退出后，`refactor/m5-client` 已 fast-forward 合入）。工作分支 `refactor/m6-rules`。
> 目标：**规则命中只建任务**——外部事件 / app 事件 / 派生事件经规则映射成看板任务，任务进入阶段后仍走同一个工作流引擎；cron 是内核规则（单定时器 `clock.tick`），不是插件；规则整批替换、版本递增、非法整批拒绝且旧版继续生效。
> 本阶段不做：线程与线程上下文（M6.5）、source 插件子进程 / webhook / fs（M7）、回执块重写（M6 已知边界，见 M4 记录）、timeline 视图。

## 开工前提（2026-11-05）

- 分支 `refactor/m6-rules` @ `2f06970`；工作树干净。
- 门禁基线：`pnpm check` exit 0；105 文件 / 1330 用例；覆盖率 **99.89 / 98.18 / 100 / 100**；`check:diffcov` 565/565；`pnpm e2e` 8/8。
- `floor-guard` 默认 base 是 `master`，必须在分支上工作；扫描未跟踪文件全文，本计划与任务清单不得出现关闭检查器/未完成标记/放松测试的写法。

## 测绘结论（2026-11-05）

| 事实                                                                                                       | 证据                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `AutomationRule` 只有 SPEC 定义，`src/protocol` 无规则契约；`rules` 表/事实/命令/视图全部不存在            | `docs/specs/SPEC-kernel.md:263-287`、`grep -r AutomationRule src` 为空                   |
| `event.received` / `event.dropped` 只入账、不投影；`app.event` 只落事实、不派活                            | `src/kernel/project.ts:131-134`、`src/kernel/decide.ts:1142-1159`                        |
| `clock.tick` 只处理 run 到期；`nextWakeAt` 只算 run 的租约 / 超时 / `notBefore`                            | `src/kernel/decide.ts:1034-1045`、`src/kernel/next-wake.ts:13-29`                        |
| `Task` 行只有 8 列，没有 origin/ruleId/externalRef/labels；投影表差量升级有 runs/runtimes 先例（建表拷贝） | `src/protocol/entities.ts:243-252`、`src/host/schema.ts:278-349`、`src/host/db.ts`       |
| 设置页只有运行时/智能体/工作流三栏；kernelStore 失效表未登记 `rule.` 前缀（会走未知类型全量失效）          | `components/SettingsNav.tsx:5`、`src/renderer/src/shell/kernelStore.ts:73-96`            |
| 视图装载/查询逐列写死；`PROJECTION_TABLES` 与内核 `kernel/types.ts` 两份清单必须同批改                     | `src/host/store/views.ts:1-9`、`src/host/schema.ts:376-406`、`src/kernel/types.ts:51-62` |

## 架构决议（M6 口径）

| #   | 缺口         | M6 口径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 规则事实     | 新增事实 `rules.replaced`（payload `{ ruleSet: RuleSetRow }`，整批、版本 +1）与 `rule.fired`（payload `{ fire: RuleFireRow }`，cron 一次触发）。投影新增两张表：`rule_sets`（单行 `id='current'`：version / replaced_at / rules_json）与 `rule_fires`（append：id / rule_id / version / scheduled_for / fired_at / task_id），都进 `PROJECTION_TABLES` 与投影指纹；`KERNEL_VERSION` 升 `m6.0.0` 触发全量重建。                                                                                                                                                |
| D2  | 规则契约     | 新增 `src/protocol/rules.ts`：`AutomationRule`（id / name / when / to / prompt / parallel / merge / enabled）与上限、枚举常量；`to = { workflowId, stageId?, task?: { titleFrom?, labels? }, thread?: { keyFrom, onExisting? } }`。命令 `rules.replace { rules }` 整批替换：内核逐条校验（id 唯一、name、when 二选一、source/type 形状、cron 可解析、workflow/stage 存在且从属、prompt ≤2000、parallel 1–8、merge/enum），任一条非法整批 `reject`，旧版继续生效。                                                                                             |
| D3  | 事件匹配     | `kernel/rules.ts`：source 精确或 `*`；type 精确 / `*` / 前缀 `x.*`；同一事件命中多条规则全部建任务，不排序不取最优。匹配键 `externalRef` = `to.thread.keyFrom`（缺省 `subject`）取 `event.subject` 或 `event.dedupeKey ?? event.subject`；同 `(ruleId, externalRef)` 已有 active 任务 → 不重复建任务（事件仍入账）。任务 `origin='rule'`、`ruleId`、`externalRef`、`labels`；进入阶段后由 `entry_mode` 产 run（run 带 `ruleId/rulesVersion/eventIds=[eventId]/hops`，prompt 追加规则 `prompt` 段）。                                                          |
| D4  | 事件入口     | 新增宿主输入 `event.received`（source 插件 / 宿主 / 测试注入；`hops` 缺省 1），产 `event.received` 事实并立即匹配规则；M5 `app.event` 命令改走同一匹配路径（app 事件也能建任务）；回执 `events[]` 派生的 `event.received` 同样匹配规则。新增命令 `rule.trigger { ruleId }`（手动立即运行一条规则）：直接按规则建任务（不依赖事件，`externalRef=null`），供规则页「立即运行」。                                                                                                                                                                                |
| D5  | cron（tick） | 新增 `kernel/cron.ts`（纯函数）：解析 5 字段（`*` / 数字 / 区间 / 步长 / 列表；dom 与 dow 同时受限按 OR），`nextCronTime(expr, after, timezone)` 按墙钟与时区求下一次；跳过的墙钟时刻不触发，重复的墙钟时刻只触发一次，停机错过只补最近一次。`clock.tick` 对每条 enabled cron 规则：baseline = 该规则上次 `rule.fired`（无则本版 `replacedAt`），若 `(baseline, now]` 内有到点时刻则只补最近一次，产 `task.created` + 入口 run + `rule.fired`；目标工作流/阶段已不存在时只记 `rule.fired`（taskId=null）避免每 tick 重试。`nextWakeAt` 纳入 cron 下一次到点。 |
| D6  | 任务投影扩展 | `Task` 加 `origin: 'manual' \| 'rule'`、`ruleId: string \| null`、`externalRef: string \| null`、`labels: string[]`。`tasks` 表新增列：旧库用 `PRAGMA table_info` 差集 + `ALTER TABLE ADD COLUMN` 一次性补齐（表结构只增不重建，避免外键改名的坑）；老事实 replay 缺字段由 kernel `project` 归一（`origin ?? 'manual'`、`ruleId ?? null`、`externalRef ?? null`、`labels ?? []`）；v2 存量导入按同一默认值。                                                                                                                                                  |
| D7  | 规则页       | 设置页第四栏「规则」；`RulesManager`（列表 / 新建 / 编辑 / 删除 / 启停 / 立即运行，读取 `rules.all`，保存走 `rules.replace` 整批）。模板按钮「Issue 进研发」（`source='github'`、`type='issues.opened'`、`titleFrom='subject'`）与「每日早报」（`cron='0 9 * * *'`、固定 prompt）只做表单预填，不内置真实 GitHub 接入（webhook 属 M7）。                                                                                                                                                                                                                      |
| D8  | 来源边界     | M6 **不落地** source 插件进程：manual 源 = `rule.trigger` 命令，app 源 = M5 `app.event`，外部事件 = `event.received` 宿主输入；`plugins/sources/**` 与 `SourcePlugin` 接口留给 M7 webhook 的首个消费者。理由：为没有传输层的来源建空壳插件会引入第二套事件入口，违反「新增能力先证明确有消费者」。                                                                                                                                                                                                                                                            |
| D9  | 读路径与失效 | 新视图 `rules.all` → `{ version, rules }`（无参数）；宿主视图不动。kernelStore 失效表加 `rules.` → `rules.all`、`rule.` → `rules.all`（tasks 由既有 `task.` 前缀失效）。UI 只读视图、只发命令，不在组件里推导规则命中。                                                                                                                                                                                                                                                                                                                                       |
| D10 | 文档与门禁   | 清单类断言（COMMAND_NAMES / HOST_INPUT_NAMES / VIEW_IDS / PROJECTION_TABLES / SCHEMA_SQL 表数）同批更新；SPEC-kernel / SPEC-host / SPEC-plugins / CAPABILITY-MAP / refactor-plan 同步；覆盖率不低于 M5 基线；`pnpm check` / `check:diffcov` / `pnpm e2e` 全绿。                                                                                                                                                                                                                                                                                               |

## 目标结构

```
src/
├── protocol/
│   ├── rules.ts           # AutomationRule / RuleSetRow / RuleFireRow / 上限（新）
│   ├── commands.ts        # + rules.replace、rule.trigger
│   ├── inputs.ts          # + 宿主输入 event.received
│   ├── views.ts           # + rules.all
│   ├── facts.ts           # + rules.replaced、rule.fired
│   ├── entities.ts        # Task + origin/ruleId/externalRef/labels
│   └── validate.ts        # 新命令 / 事件输入 / 视图校验
├── kernel/
│   ├── rules.ts           # 匹配 / 建任务 / 手动触发（新）
│   ├── cron.ts            # 解析 / 下一次触发 / 时区墙钟（新）
│   ├── decide.ts          # rules.replace / rule.trigger / event.received / app.event / clock.tick / run.receipt
│   ├── project.ts         # rules.*、task 归一
│   ├── next-wake.ts       # + cron
│   ├── prompt.ts          # + 规则 prompt 段
│   ├── types.ts           # View.rules / KERNEL_VERSION / 投影表
│   └── view-spec.ts       # 新输入切片
├── host/
│   ├── schema.ts          # rule_sets / rule_fires DDL、tasks 新列
│   ├── db.ts              # tasks 旧库补列
│   ├── store/projection-apply.ts  # 新表写入、tasks 新列
│   ├── store/views.ts     # 视图装载 / 查询
│   └── store/import.ts    # v2 tasks 默认值
└── renderer/src/
    ├── shell/kernelStore.ts       # 失效表
    └── apps/ai-workflow/
        ├── components/SettingsNav.tsx   # + 规则
        ├── components/RulesManager.tsx  # 新
        └── AiWorkflowPage.tsx           # + 规则栏
```

## 任务拆分（写作用域）

| 任务 | 内容                                                                                                     | 写作用域                                                                                                                 | 依赖   | 负责     |
| ---- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------ | -------- |
| T1   | 契约与清单：rules/commands/inputs/views/facts/entities/validate、kernel types/view-spec/KERNEL_VERSION   | `src/protocol/**`、`src/kernel/types.ts`、`src/kernel/view-spec.ts`、`tests/protocol/**`                                 | —      | lead     |
| T2   | 内核：rules/cron/decide/project/next-wake/prompt（含单测）                                               | `src/kernel/{rules,cron,decide,project,next-wake,prompt}.ts`、`tests/kernel/**`、`tests/host/store/test-support.ts` 对齐 | T1     | lead     |
| T3   | 宿主：投影表、tasks 补列、writer、views、import、db 升级（含单测）                                       | `src/host/schema.ts`、`src/host/db.ts`、`src/host/store/{projection-apply,views,import}.ts`、`tests/host/**`             | T1     | host-dev |
| T4   | 宿主接线：命令路由取值 / 装配根 / feed 失效类型（如需）                                                  | `src/host/commands.ts`、`src/main/index.ts`（只动必要处）                                                                | T1、T3 | host-dev |
| T5   | renderer：规则页与表单、模板、kernelStore 失效、组件测试                                                 | `src/renderer/src/**`、`tests/renderer/**`                                                                               | T1、T3 | ui-dev   |
| T6   | 集成测试与门禁：`pnpm check`、覆盖率、diffcov、e2e 适配（无效用例不删）                                  | `tests/**`、`tests/e2e/**`                                                                                               | T2–T5  | lead     |
| T7   | 文档：SPEC-kernel / SPEC-host / SPEC-plugins / CAPABILITY-MAP / refactor-plan 开工与退出记录、TEST-CASES | `docs/**`                                                                                                                | T6     | lead     |

## 验收口径

- 命令：`rules.replace` 合法批次 → `rules.replaced`（版本 +1、旧规则全量替换）；任一条非法 → `reject` 且零事实、旧版继续生效；`rule.trigger` 对不存在/停用规则 `reject`，对启用规则建一条任务。
- 事件：`event.received` 命中一条/多条规则各建一条任务（同一事件多规则不合并）；同一规则 + 同一 `externalRef` 第二次事件不重复建任务；source 不匹配 / type 不匹配零任务。
- 任务：规则任务 `origin='rule'`、`ruleId`、`externalRef`、`labels` 正确，入 agent 阶段产生 run（`ruleId`/`rulesVersion`/`eventIds` 正确）；手工任务默认 `origin='manual'`，行为零变化。
- cron：`nextCronTime` 对 `* * * * *`、`0 9 * * *`、`*/15`、列表/区间、dom/dow OR、时区（Asia/Shanghai 与 America/New_York 的跳过/重复时刻）用例正确；`clock.tick` 同一到点时刻只触发一次；停机错过多个时刻只补最近一次；重建后 `rule_sets` / `rule_fires` 与增量一致。
- 读：`rules.all` 返回当前版本与规则；重建后一致；UI 保存后列表即时更新（事实失效）。
- 门禁：`pnpm check` exit 0；覆盖率不低于 99.89 / 98.18 / 100 / 100；`check:diffcov` ≥90%（目标 100%）；`pnpm e2e` 全绿；改动行无关闭检查器 / 跳过测试。

## 风险

| 风险                                  | 对策                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tasks` 加列让旧库/老事实重建失败     | `project` 归一 + v2 导入默认值 + db 打开时补列；`tests/host/db.test.ts` 覆盖旧库升级与重建逐表等价        |
| cron 时区 / DST 语义做错              | 纯函数 + 假时区单测（UTC、Asia/Shanghai、America/New_York 春/秋调）；`nextWakeAt` 与 tick 共用同一实现    |
| 规则整批替换导致 UI 覆盖别人的编辑    | 单写者（桌面单实例）；保存整批 + 版本号展示；非法整批拒绝不落事实                                         |
| 事件建任务与执行器派生事件互相放大    | `externalRef` 去重 + `hops` 熔断沿用；规则任务不再自动派生事件（M6.5 线程上下文再议）                     |
| 新增事实/命令后清单断言与投影指纹漏改 | T1 同批改 `PROJECTION_TABLES` / `COMMAND_NAMES` / `INPUT_NAMES` / `VIEW_IDS`；`pnpm check` 首次失败即暴露 |
