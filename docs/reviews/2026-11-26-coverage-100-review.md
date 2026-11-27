---
type: review
status: archived
owner: lead
updated: 2026-11-28
---

# 评审：覆盖率门槛提到 100%（暂存区，125 文件 / +11851 / −558）

- 评审依据：`code-review-and-quality` 五轴（正确性 / 可读性 / 架构 / 安全 / 性能）+ 「测试先行」「验证验证」「变异自检」三节
- 评审者：lead（root），含两路子评审（客户端 diff、测试质量），子评审各自做了定向变异并还原
- 评审对象：全部已暂存改动（`git diff --cached`），基线 `HEAD = 1668039`
- 结论：**Request changes**（2 条 Critical、6 条必修），主体方向正确

---

## 一、我的验证记录（实测，不是读 diff）

| 检查                         | 命令                                                                            | 结果                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 类型                         | `pnpm run verify:types`                                                         | exit 0                                                                                                     |
| 项目 + 改动行覆盖率          | `pnpm run verify:coverage`                                                      | exit 0，48.3s；`All files 100/100/100/100`，改动行 `218/218 = 100%`                                        |
| kernel 预算                  | `node scripts/check-kernel-budget.mjs`                                          | clean（`scopes` 最大 `run.ts` 776/900）                                                                    |
| 服务端产物                   | `pnpm run build:server`                                                         | 成功，993.66 kB / CJS                                                                                      |
| 产物守卫真实形态             | `Select-String out/server/index.js 'import\.meta'`                              | 零命中；rolldown 已把 `import.meta.url` 重写成 `require("url").pathToFileURL(__filename).href`，CJS 下成立 |
| 真起服务                     | `WORKBENCH_PORT=0 WORKBENCH_DATA_DIR=<temp> node out/server/index.js`           | `workbench listening on http://127.0.0.1:58599`，进程存活，SIGTERM 后退出                                  |
| 新增 e2e                     | `npx playwright test tests/e2e/{retry-flow,chat-flow,artifact-restart}.spec.ts` | **3 passed (4.1s)**，均为真服务进程 + Chromium                                                             |
| 格式化                       | `pnpm exec prettier --check`（改动文件抽样）                                    | **13 个文件未过**（见 Nit）                                                                                |
| 变异（子评审实测，均已还原） | 见下方 FYI 变异表                                                               | 2 条语义反转变异在 280 文件 4659 用例下**全绿**                                                            |

未做：完整 `pnpm verify:all` 与 31 条 e2e 全量（只跑了新增三条，全绿）；lint 未单独重跑（`verify:coverage` 与 `verify:types` 已覆盖 test 与类型）。

---

## 二、Critical（阻断合并）

### C1 `packages/host/host/src/commands.ts:302` — 穷尽断言的编译期保护被删，实际已失效

删掉的是：

```ts
      default: {
        // 穷尽断言：`command` 在这里已是 never；漏一条命令，这一行就编不过
        const unhandled: never = command
        return unhandled
      }
```

**实测**：手工删掉 `:307` 的 `case 'review.export':`，`pnpm run verify:types` **exit 0、零报错**。

原因三连：外层签名是 `const valueOf = (command: Command, facts: readonly Fact[]): unknown`（`:213`），`undefined` 是 `unknown` 的合法子集；`tsconfig.{node,web}.json` 均未开 `noImplicitReturns`；`eslint.config.mjs` 未启用 `@typescript-eslint/switch-exhaustiveness-check`。

后果：协议新增一条命令而漏登记 → 宿主把 `undefined` 当命令返回值回给 bridge/UI，全程无闸门。这是「为凑覆盖率把安全网换成空」的教科书案例：覆盖率确实 100%（因为不可达分支被删掉了）。

同时 `commands.ts:284-285` 的注释仍写着「新增一条命令却忘了在这里登记时，下面的穷尽断言会直接编译报错」，`docs/testing/CONSTRAINTS-HISTORY.md` 新增条目第 ③ 条也写「穷尽性由类型系统保证」——这句只对 `lark-admin.ts` 的 `isActionName` 成立（那里是真类型守卫，`asLarkAction` 返回 `LarkAdminAction | null` 不含 `undefined`，漏项必报 TS2366），对 `valueOf` 不成立。

修法（二选一，都保持 100%）：

```ts
// A. 恢复断言 + 显式覆盖豁免（豁免可见、可审计）
      default: {
        /* v8 ignore next 2 */
        const unhandled: never = command
        return unhandled
      }

// B. 表驱动：Record 由类型系统强制穷尽，且天然 100% 覆盖
const VALUE_OF: Record<Command['type'], (c: Command, f: readonly Fact[]) => unknown> = { ... }
```

配套必改：`commands.ts:284-285` 注释、`CONSTRAINTS-HISTORY` 第 ③ 条措辞。否则下一个人会按错误前提改代码。

### C2 `packages/core/kernel/src/scopes/threads.ts:365` — `finishedPhaseOf` 的 cancelled 臂零断言，变异全绿

把函数体改成 `return 'finished'`（三元被整体删掉，v8 仍 100%），全量 `vitest run` → **280 文件 / 4659 用例全绿**。

该函数正是本批第 ④ 类改造（「同一条映射两处要读，收成一处」）的产物，两个调用点 `scopes/commands/run.ts:686`、`scopes/threads.ts:389` 都没有「取消 → `cancelled`」的断言。

后果：`task.finished{outcome:'cancelled'}` 被记成「已完成」，看板 / rollup / 归档文案全跟着错，任何闸门都不响。**这正是 `CONSTRAINTS-HISTORY` M53 条目自己记录过的事故**（「全仓零条 `outcome: 'cancelled'` 断言，1056 个用例全绿」），这次换了个函数名重演。

修法：在**调用点**各补一条反向断言（函数内自测不算）：

- `receiveRun` 收到 `task.finished{outcome:'cancelled'}` → 任务相位 `cancelled`（不是 `finished`）
- `batchTaskPhases` 同批新建卡的父任务 rollup → `cancelled`

---

## 三、必修（无前缀）

### R1 `packages/bundle/base/src/index.ts:383` — 文件末尾的孤儿 JSDoc

```ts
/** 通道/来源 hub 取配置：目录行不在时给空对象（未安装的插件不拿配置） */
```

其后无任何声明，文件到此结束。该注释的内容已由 `catalog.ts:226-229` 的 `hubConfigOf` 承载。这是拆分时漏删的残留，会让读者以为后面少了一段代码。

### R2 `packages/client/app-ai-workflow/src/AiWorkflowPage.tsx:55,191` — 行为改成了「无落点清空栈」，注释仍写「原地不动」

改动前：

```ts
const landing = cardLanding(card)
if (landing.kind === 'task') setTrail([{ kind: 'task', taskId: landing.taskId }]) // 无落点：不动 trail
```

改动后：

```ts
setTrail(trailForCard(card)) // 无落点 → setTrail([])
```

当栈非空（正在任务详情里，通知条 `:422` 是常驻渲染的）时，这是**出栈回看板**，与新增注释「没有落点的卡原地不动（空栈）」自相矛盾。今天不可达全靠 `ApprovalBar.tsx:8` 的 `targetOf` 与 `:96` 的整行 `disabled`——而这个文件 `:15` 的注释仍写着「任务详情 / 会话」两个落点，将来一放开工单，用户会被静默踢出当前页。

修法：把「无落点」表达成 `null` 而不是空栈，语义就与注释一致：

```ts
export function trailForCard(card: Card): TaskRoute[] | null {
  const landing = cardLanding(card)
  return landing.kind === 'task' ? [{ kind: 'task', taskId: landing.taskId }] : null
}

const openCard = (card: Card): void => {
  const next = trailForCard(card)
  if (next === null) return // 没有落点：原地不动
  setView('workspace')
  setTrail(next)
  setFocusCardId(card.id)
}
```

### R3 `tests/support/kernel-view.ts:16-25` — 新建共享夹具抄了一套过期 `Limits`

| 字段            | 夹具      | 生产 `DEFAULT_LIMITS`（`packages/host/store/src/index.ts:47-73`）   |
| --------------- | --------- | ------------------------------------------------------------------- |
| `leaseMs`       | 120_000   | **600_000**（M48 因「模型 thinking 117s/136s 被误判租约过期」放宽） |
| `backoffBaseMs` | 300_000   | **15_000**                                                          |
| `backoffCapMs`  | 3_600_000 | **60_000**                                                          |
| `runTimeoutMs`  | 1_800_000 | **3_600_000**                                                       |
| `maxSpawnItems` | 缺失      | 32                                                                  |

这个夹具是本批新建的共享底座，一旦被采纳，租约 / 退避 / 超时相关分支将永远在「生产不会出现的数值」下被验证——M48 那类回归测不出来，而 100% 门禁对此完全无感。

修法：`testLimits = (over) => ({ ...DEFAULT_LIMITS, ...over })`，并加一条「夹具 == 生产默认」的断言长期防漂。若担心 `tests/kernel` 引 `@workbench/host-store` 破坏层次，那把 `DEFAULT_LIMITS` 挪到 `Limits` 类型旁（`packages/core/kernel/src/core/types.ts`）——默认值是内核契约的一部分，现在挂在 host/store 才导致夹具只能抄数字。

### R4 夹具只迁了 12/22，同批新增的 `stall-branches` 又抄一遍

`tests/**/*-branches.test.ts` 共 22 个，其中 12 个 import 了 `tests/support/kernel-view.ts`；`tests/kernel/scopes/stall-branches.test.ts:22-41` 在同一次提交里自己重写了 `limits()/env()/view()` 约 60 行，且抄的正是 R3 那批过期值（`:26 leaseMs: 120_000`、`:29 backoffBaseMs: 300_000`）。`stall.test.ts`、`task-effects-branches.test.ts` 同理。

一次提交里立两套约定，后来者无法判断该学哪套；抽象没减概念，只多了一层选择。

修法：本次内一次切齐 22 个（机械改动，可脚本化），或者先不引入 `kernel-view.ts`，切齐再落。

### R5 `tests/host/channels.test.ts:1648,1662,1753,1762,1823` — 新增段用固定 `setTimeout` 等异步扇出

同一文件里 `vi.waitFor` 已用 29 次（包括新增段「进展回调自己抛错」那条），新增段却用 `await new Promise((r) => setTimeout(r, 10|20))`。10–20ms 在负载机上不保证微任务与定时回调跑完，失败信息是 `expected [] to equal ['第一句']`，排查成本高；而这个文件现在已进 pre-commit 闸门。

修法：5 处换成 `await vi.waitFor(() => expect(...))`，与文件既有风格一致。

### R6 提交粒度：125 文件 / +11851 行一次提交，评审与回滚粒度都丢了

按 change sizing（~1000 行就要拆）这次至少是四条独立变更：

1. 覆盖率门禁与阈值（`vitest.config.mts`、`check-diff-coverage.mjs`、`.husky/pre-commit`、`CONSTRAINTS.md`）
2. 装配根拆分（`bundle/base` 4 个新模块 + 5 个 `assembly-*.test.ts`，纯搬家 + 补测）
3. 覆盖率补齐（22 个 `-branches`、`kernel-view.ts`、大量既有测试补充）
4. 新增 e2e 三条核心流程

现在混在一起，无法分辨「哪些是门禁逼出来的等价清理、哪些是结构重构」，回滚只能整块撤。若已定稿，至少在提交信息里分节列出这四类。

---

## 四、Optional

1. **`apps/server/src/lifecycle.ts:90` 是死分支，而新增测试专门把它固化下来**：`deps.notify` 的唯一 HTTP 调用点（`packages/api/http/src/http.ts:283`）已把 `body` 补成必有字符串，所以 `payload.body ?? ''` 走不到。正确修法是把它声明为非可选（或在 `http.ts` 侧只在有值时传），删掉这层兜底；`tests/server/lifecycle-wiring.test.ts` 的标题就叫「覆盖率补口」，为死分支写测试是把这个方向坐实了。本批应当用 `/* v8 ignore */` 或删代码，而不是加测试。
2. **`packages/core/kernel/src/scopes/commands/workflow.ts:32` 的 `stageRow` 导出只为测试**：注释自陈「产品路径上不可达」，`rg 'stageRow\('` 只有 `:257,:269` 两个内部调用。测试因此证明的是「归一器容忍畸形输入」，而校验器哪天被放松，「校验器拒绝」的语义就没人守了。改为在 `updateWorkflow` 层断言「被 reject + 不落行」，导出可以收回。
3. **`packages/bundle/base/src/wiring.ts:23` 的 `passthroughDispatch`**：收益是把 3 处 `(input) => effects.dispatch(input)` 收成 1 处，成本是多一个导出 + 一份测试。概念数没减，属可删的透传包装。
4. **`scripts/check-diff-coverage.mjs:57` 在 pre-commit 里判定的是 merge-base → **工作区** 的 diff**，含未暂存改动；部分暂存（`git add -p`）时门禁判定对象不是「即将提交的内容」。90% 时代误伤有限，100% 之后任何一行未覆盖都会拦。建议钩子内按 `git diff --cached` 取行（或 `git stash --keep-index` 包一层）。
5. **`review-text.ts:45` 的 `truncate` 变异幸存**：把 `return text` 改成不截断，`tests/kernel` 1210 用例全绿——没有任何用例断言截断内容与后缀 `…`。补一条即可（提示词预算超标是线上真会踩的）。
6. **`tests/kernel/scopes/stall.test.ts:205-217`**：通过 patch `Map.get` 的读次数构造并发窗口，与内部读取顺序强耦合；读取顺序一变测试红得莫名其妙。改成「行缺失」的纯函数级用例更稳。
7. **`tests/server/index.test.ts:5-9` 头注释过时**：仍写「守卫的判据是 `require.main === module`」，实现已是路径比较。
8. **13 个文件未过 prettier**：`packages/bundle/base/src/{catalog,index}.ts`、11 个 `-branches.test.ts`、`tests/renderer/.../TaskActivity.test.tsx`。`lint-staged` 提交时会自动修，但暂存区现状与仓库格式基线不一致。

---

## 五、Nit

1. `packages/core/kernel/src/scopes/threads.ts:359-360`：`/**` 连续出现两行（既有缺陷，但本次改到该文件，顺手修）。
2. `tests/renderer/src/apps/ai-workflow/components/TaskActivity.test.tsx:110`：`it('多阶段任务…', async () => {    const first = makeRun({` —— 标题与语句同一行。
3. `packages/bundle/base/src/catalog.ts:164`：`/** … */export function adapterOptionsOf(` 注释与声明同行。

---

## 六、死代码清单（重构后确认无引用）

| 符号                                     | 位置                                         | 状态                             |
| ---------------------------------------- | -------------------------------------------- | -------------------------------- |
| 孤儿 JSDoc（hub 取配置）                 | `packages/bundle/base/src/index.ts:383`      | 无后续声明，可直接删             |
| `payload.body ?? ''` 兜底                | `apps/server/src/lifecycle.ts:90`            | 唯一调用方已保证非空，分支不可达 |
| `default: const unhandled: never` 的注释 | `packages/host/host/src/commands.ts:284-285` | 描述的代码已不存在               |
| `PassthroughDispatch` 的独立意义         | `packages/bundle/base/src/wiring.ts:23-27`   | 可选回收                         |

需要我一并删掉前三条，说一声即可（会同时补 R6 的提交分节说明）。

---

## 七、FYI

**变异自检表（子评审实测，均已还原，`git diff` 干净）**

| 变异                                                | 范围                                    | 结果                     |
| --------------------------------------------------- | --------------------------------------- | ------------------------ |
| `threads.ts:366` → `return 'finished'`              | 280 文件 / 4659 用例                    | 全绿（幸存）→ C2         |
| `review-text.ts:45` → `return text`                 | `tests/kernel` 1210 用例                | 全绿（幸存）→ Optional 5 |
| `commands.ts` 删 `case 'review.export'`             | `verify:types`                          | exit 0（幸存）→ C1       |
| `lifecycle.ts:245` `===` → `!==`                    | `tests/server/index.test.ts`            | 3 failed（抓到）         |
| `catalog.ts:93` 内置覆盖判定 → `if (false)`         | `tests/server/assembly-catalog.test.ts` | 2 failed（抓到）         |
| `stage-draft.ts:136` 越界臂 → `return moved[index]` | stage-draft 单测                        | 2 failed（抓到）         |
| `WorkflowEditor.tsx:827` `> 0` → `>= 0`             | WorkflowEditor 单测                     | 1 failed（抓到）         |

**方向正确的改造**（记录在案，避免下次被当成「待清理」）：`mandate.ts` 的 `REASON_TEXT` 查表（`Record<AdmissionReason,string>` 由类型强制穷尽，优于 switch + 不可达 arm）、`lark-admin.ts` 的 `isActionName` 类型守卫、`threads.ts#finishedPhaseOf` 的单一来源（只缺断言）、`stage-draft.ts` 的 `NormalizedStage` 把不变量显式化并删掉下游 `?? []`、`apps/server/src/index.ts` 的入口守卫（旧写法在 ESM 下真分支永远测不到，这是真 bug 修复）、`bundle/base` 的四模块拆分（`index.ts` 662 → 374 行，判断可逐条测）。

**手工冒烟会外连真实飞书**：临时数据目录隔离不到 `~/.lark-cli` 的登录态，我这次冒烟就真连上了 `feishu_workbench` 并起了 bus daemon。e2e 已用 `tests/support/channel-isolation.ts` 挡住（`launch.ts:110` 的位置也是对的：`prepare` 之后、`startAll` 之前），但运维冒烟文档应写明这一点，并考虑给「纯本地冒烟」一个关通道的 env 开关。

**e2e 是这批改动里质量最高的部分**：隔离靠 `mkdtemp` + `WORKBENCH_PORT=0`，停机先 SIGTERM 再 5s SIGKILL，Windows 删目录 `maxRetries:10`；三条新 spec 零 `waitForTimeout`，全部条件等待，断言是「库里 + 盘上 + 看板三处一致」，`retry-flow` 直接读假智能体自己的 `attempts.txt` 证明跑了两轮——是行为证据而不是调用次数。实测 3 passed / 4.1s。

**门禁本体是真的**：266 个产品文件四元组全 100，产品 `src` 下 267 个 `.ts/.tsx`，分母没有靠 `exclude` 缩水（唯一 0 语句的是 `plugins/registry/src/manifest.ts`，纯类型重导出）；`coverage/` 在 `.gitignore` 内。pre-commit 追加 `verify:coverage` 后单次提交约 +50s，与 `CONSTRAINTS.md` 的「≤ ~90s」自述一致——但 pre-commit 现在是 types + guards + 全量测试约 2 分钟，`--no-verify` 会成为常态化风险，可考虑把全量测试挪到 pre-push、pre-commit 只留改动行门禁。

**这套测试证明的是什么**：100% 是「每条语句都被跑到」，不是「改坏了会被发现」。两条语义反转变异全绿就是证据。补强方向不是再抬阈值，而是给每个新抽出的单一来源函数（`finishedPhaseOf` 这类）在**调用点**配一条反向断言。

---

## 七、修复记录（2026-11-26，同批落地）

| 条目    | 修法                                                                                                                                                       | 验证                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| C1      | `commands.ts#valueOf` 的穷尽断言移到 `switch` **之后**（`never` 赋值 + `/* v8 ignore */`）：switch 里不再有「走不到的 default」分支，漏登记命令仍 `TS2322` | 删 `case 'review.export'` → `error TS2322: Type 'ReviewExportCommand' is not assignable to type 'never'`，已还原 |
| C2      | `batchTaskPhases` 补 `outcome=done → finished` / `cancelled → cancelled` 的相位断言（两个消费点的唯一来源）                                                | 变异成 `return 'finished'` → **1 failed**，已还原                                                                |
| R1      | 删 `bundle/base/src/index.ts` 末尾孤儿 JSDoc                                                                                                               | `prettier --check` 无该文件告警                                                                                  |
| R2      | `trailForCard` 无落点返回 `null`、`openCard` 早退；`openCard` 的早退臂用 `/* v8 ignore */`（通知条 disabled 使其不可达）                                   | `AiWorkflowPage.test.tsx` 断言改 `toBeNull()`                                                                    |
| R3      | `DEFAULT_LIMITS` 上移到 `kernel/core/limits`，`host/store` 就地 re-export；夹具与 `decide.test.ts` 改取契约默认值                                          | `verify:coverage` 四元组 100%                                                                                    |
| R4      | `assess-` / `stall-` / `task-effects-branches` 三处本地 `limits()` 切到 `testLimits()`                                                                     | 三文件 24 用例通过                                                                                               |
| R5      | `channels.test.ts` 新增段 5 处固定 `setTimeout` → `vi.waitFor` 或删除（progress 扇出是同步的）                                                             | `channels.test.ts` 80 用例通过                                                                                   |
| Opt 1   | `api/http#notify` 入参收紧成 `{ title, body }`；删 `lifecycle.ts` 的 `payload.body ?? ''` 与专门测它的用例                                                 | `lifecycle-wiring` / `lifecycle` 23 用例通过                                                                     |
| Opt 2   | `stageRow` 保留导出，但补一条「`validateStageSet` 先挡住这两种畸形输入」的断言：拒绝与容忍各有测试                                                         | `workflow-branches` 8 用例通过                                                                                   |
| Opt 4   | `check-diff-coverage.mjs` 新增 `--staged`；pre-commit 改判暂存区                                                                                           | `CONSTRAINTS-HISTORY` 记录口径                                                                                   |
| Opt 5   | `truncate` 补超长 claim/验收截断断言                                                                                                                       | 变异成不截断 → **1 failed**                                                                                      |
| Nit 1/2 | `threads.ts` 双 `/**`、`TaskActivity.test.tsx` 标题与语句同行                                                                                              | prettier                                                                                                         |
| Nit 3   | `catalog.ts` JSDoc 与声明同行                                                                                                                              | prettier                                                                                                         |

**没做（附理由）**：`passthroughDispatch` 仍保留——回收要动 3 个调用点，diff 噪声大于收益；`stall.test.ts` 的 `Map.get` 读次数构造——改成别的写法会失去「两次读之间行被删」这一支的构造能力；R6 提交拆分——本次仍是一批，提交说明按「门禁变更 / 装配根拆分 / 覆盖率补齐 / e2e 新增」四节写。

**新发现的工具冲突**：`prettier --write CONSTRAINTS.md` 会重排表格，而 `floor-guard` 按行比较、把空白变化判成 `rule-removed`（门槛被删）。所以该文件的「提交前」行未改，`--staged` 口径写进 `.husky/pre-commit` 注释与 `CONSTRAINTS-HISTORY`。要么让 floor-guard 忽略表格行的空白差异，要么把这份表拆到非规则文件。
