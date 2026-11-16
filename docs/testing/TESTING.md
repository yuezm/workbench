# 测试与质量保障体系（TESTING）

> 质量门禁的单一入口文档。用例与 SPEC 规则的映射见 [TEST-CASES.md](TEST-CASES.md)。
> 包管理器统一为 **pnpm**（2026-10-30 起），全部命令用 `pnpm` 执行。

## 分层策略

```
            ┌─────────────────────────────┐
            │  E2E  Playwright + Chromium │  真实服务进程 + 构建产物，关键路径冒烟（慢、少而稳）
            ├─────────────────────────────┤
            │  集成/契约                    │  server·HTTP/SSE / web·桥接 / registry·AppPlugin
            ├─────────────────────────────┤
            │  单元                         │  状态机 / audio / cn / button / hooks / 组件
            ├─────────────────────────────┤
            │  静态检查                     │  typecheck + ESLint(+react-hooks) + Prettier
            └─────────────────────────────┘
```

| 层        | 位置                                                        | 工具                                          | 职责                                                       |
| --------- | ----------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| 静态检查  | 根配置                                                      | tsc（node/web 双工程）、ESLint flat、Prettier | 类型、hooks 规则、格式一致                                 |
| 单元      | `tests/**`（与 `src/` 同构）                                | Vitest + jsdom + RTL                          | 纯逻辑与孤立组件；业务规则 100% 落在 machine.ts 并分支全测 |
| 集成/契约 | `tests/host/`、`tests/server/`                              | Vitest（node 环境 + 假 HTTP/SSE）             | 路由、应答信封、SSE 帧与桥接 API 形状不漂移                |
| E2E       | `tests/e2e/*.spec.ts`                                       | Playwright + 每用例独立服务进程               | 构建产物（`out/server` + `out/web`）里真实服务的关键路径   |
| 性质/变异 | 性质用例内联在 `tests/**`；变异范围见 `stryker.config.json` | fast-check / Stryker                          | 不变量穷举 + 断言有效性自检（防假绿）                      |

目录约定（2026-11-04 起）：

- 测试统一放 `tests/`，与 `src/` **同构镜像**：`src/kernel/decide.ts` ↔ `tests/kernel/decide.test.ts`，`src/renderer/src/apps/pomodoro/audio.ts` ↔ `tests/renderer/src/apps/pomodoro/audio.test.ts`。
- `src/` 只放产品代码；测试夹具（如 `test-support.ts`、`fake-kernel.ts`）也随测试放进 `tests/`。
- E2E 放 `tests/e2e/`（`helpers/launch.ts` 按用例起独立服务进程 + Chromium 页面）；没有打包产物冒烟，`tests/e2e-packaged/` 已删除。

约定：

- 契约测试**只守卫不改**：`WorkbenchApi` / `AppPlugin` / `protocol/http` 的载荷形状变更时，先改契约与消费方，再让测试跟随契约走。
- E2E **有意不覆盖**阶段完成与知会（真实等待 ≥60s 且脆），该路径由 machine/usePomodoro 单测 + 手动验收覆盖。
- **E2E 不得碰真实外部身份**（2026-11-16）：`launchApp` 的临时数据目录隔离不到本机 `~/.lark-cli` 的登录态——装过并登录 `lark-cli` 的人跑 e2e，飞书通道会按 legacy 单连接拿到真实 open_id，把种子库里 `delivery='pending'` 的 ask 卡**真的发到本人飞书**。因此每次启动前由 `tests/support/channel-isolation.ts` 往测试库写一条 `plugins.replace`（`feishu` → `enabled:false`），`channels.startAll()` 因而不启动它：不 spawn `lark-cli`、不挂事件长连接、不发卡。隔离在 spec 自己的 `prepare` **之后**执行，种子也没法把它打开；`in-app` 与 `desktop` 留在测试里（前者就是被测对象，后者只经 SSE 推知会）。守则由 `tests/e2e/isolation.spec.ts` 三条断言看着，新增通道先问「它会不会把消息交给一个真人」，会就加进 `ISOLATED_CHANNEL_IDS`。
- **环境按「要不要 DOM」分工**：真正 render 的用例留在默认 jsdom；纯逻辑用例（`kernel` / `protocol` / `host` / `server` / `plugins` / `renderer` 下不 render 的 model 与 lib，以及 server 的 HTTP/SSE 契约测试）首行标 `// @vitest-environment node`。jsdom 是逐文件冷启动（本机 0.7–1.3s/文件），多标一个 node 就少付一份环境成本；`vitest.setup.ts` 也只在有 DOM 时加载 RTL 与 jest-dom。
- **不要用 `pool: 'vmThreads'` 或 `isolate: false` 换速度**：本仓有用例在文件内改 `window.location`、`vi.stubGlobal('document', undefined)`，环境复用后同一 worker 里跨文件互相污染（实测 2 条用例直接失败）。诊断里的 Isolate 提示按此忽略。
- 覆盖率阈值门禁：statements 98 / branches 93 / functions 95 / lines 98；项目基线（2026-11-11 复位复核）**100 / 100 / 100 / 100**（188 测试文件 / 3185 用例；服务端 `kernel`/`protocol`/`host`/`server`/`plugins`/`sdk`/`shared` 与客户端 `renderer` 各自四维 100%），`pnpm test:coverage` 跌破基线即 finding。
- M2 起 `runs` / `run_events` / `conversations` / `messages` 是事实投影：崩溃恢复用例在 `tests/e2e/crash-recovery.spec.ts`（临时数据目录 + 残留 pid + 重启服务），租约/退避/超时在 `tests/kernel/decide.run.test.ts`，调度/取消/帧在 `tests/host/{scheduler,cancel}.test.ts`。

## 常用命令

| 命令                                                  | 作用                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm test` / `pnpm test:watch`                       | 全部单测+契约测试（本机 20–22s / 198 文件 / 3489 用例）/ 监听模式                                                    |
| `pnpm test:coverage`                                  | 同上 + 覆盖率阈值门禁                                                                                                |
| `pnpm lint` / `pnpm lint:fix`                         | ESLint（含 react-hooks 规则）                                                                                        |
| `pnpm format` / `pnpm format:check`                   | Prettier 全仓写 / 只检查                                                                                             |
| `pnpm typecheck`                                      | tsc node + web 双工程（含 e2e 与测试文件）                                                                           |
| `pnpm check`                                          | check:fast(type+lint+floor+secrets) + test:coverage + 改动行覆盖率 + 依赖审计（本地全量门禁，数值见 CONSTRAINTS.md） |
| `pnpm e2e`                                            | `pnpm build`（typecheck + `out/server` + `out/web`）→ Playwright 每用例起独立服务进程跑 Chromium                     |
| `pnpm e2e -- --ui`                                    | Playwright UI 模式调试单条用例                                                                                       |
| `pnpm acceptance`                                     | 人工验收前一条命令：`check` + `e2e`（见 [ACCEPTANCE](ACCEPTANCE.md)）                                                |
| `pnpm e2e:ui`                                         | 只跑界面几何审计（含构建），改完 UI 用                                                                               |
| `pnpm exec playwright test tests/e2e/startup.spec.ts` | 只跑启动健康三路径（先 `pnpm build`）                                                                                |

E2E 说明：`tests/e2e/helpers/launch.ts` 用 `WORKBENCH_DATA_DIR` 临时目录 + `WORKBENCH_PORT=0` 起 `out/server/index.js`，解析 stdout 的 `workbench listening on ...` 取实际地址，再用 Playwright Chromium 打开页面；因此**每次先构建再测**；不需要下载任何 Playwright 浏览器（pnpm 默认也阻止了该下载）。

人工验收前另有两关专用 spec：`tests/e2e/startup.spec.ts`（冷启动 / 重载 / 二次冷启动零异常、零兜底页）与 `tests/e2e/ui-geometry.spec.ts`（七类几何判据 + 审计器自检，报告落 `.scratch/acceptance/ui-geometry.md`）。用法、需求覆盖矩阵与 30 分钟走查表见 [ACCEPTANCE](ACCEPTANCE.md)。

> 质量门禁的数值与命令单一来源为根目录 [CONSTRAINTS.md](../../CONSTRAINTS.md)：`check:fast` 供编辑后快跑（秒级），`check` 供任务结束/推送（含改动行覆盖率与依赖审计）。

## Git hooks（husky，提交即门禁）

| Hook         | 内容                                                              | 拦截什么                             |
| ------------ | ----------------------------------------------------------------- | ------------------------------------ |
| `pre-commit` | lint-staged（暂存文件 eslint --fix + prettier）→ `pnpm typecheck` | 风格漂移、类型错误、hooks 违规       |
| `commit-msg` | commitlint（Conventional Commits：`feat:` / `fix:` / `test:` …）  | 不合规范的提交信息                   |
| `pre-push`   | `pnpm check && pnpm e2e`                                          | 推送前全量：类型/风格/覆盖率阈值/E2E |

- hook 文件在 `.husky/`，必须保持 **LF** 行尾（`.gitattributes` 已强制）。
- 覆盖率阈值只在实际跑覆盖率时生效（`check` / `pre-push` 会强制）。

## 何时写哪层测试

1. **新业务规则**（如新的状态转移、钳制规则）→ 先写 machine 单测（假时钟），再实现；UI 只订阅不写规则。
2. **新跨层能力**（`WorkbenchApi` 加方法）→ 三处同步：契约 + 桥接测试（`tests/renderer/src/shared/bridge.test.ts`）+ 服务端路由测试（`tests/server/http.test.ts`），路径与载荷一处定义（`src/protocol/http.ts`）。
3. **新 app** → registry 契约测试自动覆盖（遍历断言）；app 内按 1 执行；E2E 视交互复杂度补关键路径。
4. **新 UI 基元**（`components/ui/`）→ variant/size/语义类名测试，作为后续使用方的契约锚点。
5. **某条分支在产品路径上到不了**（防御守卫、脏投影兜底）→ 优先用**正常业务场景**覆盖；场景不成立时，
   把判定**抽成模块级导出函数**再单测它（产品路径的守卫一字不改，只是判定可测），
   或与别处**等价的守卫合并**到一处。禁止删保护性守卫，也禁止加覆盖率抑制注释（`ignore` 类）来绕过。
   逐条口径见 [COVERAGE-UNREACHABLE](COVERAGE-UNREACHABLE.md)。

## 性质测试与变异测试（假绿防护）

覆盖率到 100% 之后，「覆盖率」这个度量对「测试是否真能抓 bug」的信息量基本归零；而 AI 写的实现与 AI 写的测试容易共享同一个错误理解，全绿的断言并不等于断言有效。因此另有两个**有效性**度量：

| 手段                      | 工具           | 回答的问题                              | 产物                                    |
| ------------------------- | -------------- | --------------------------------------- | --------------------------------------- |
| 性质测试（property test） | fast-check 4.x | 随机输入下内核不变量还成立吗            | 普通 vitest 用例，随 `pnpm test` 一起跑 |
| 变异测试（mutation test） | Stryker 10.x   | 把源码改坏，测试会红吗（红 = 断言有效） | 变异评分，报告落在 `.scratch/mutation/` |

### 已覆盖的性质（2026-11-13）

| 模块                                                   | 不变量                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `kernel/cron.ts`                                       | 解析域、严格晚于、最早命中（逐分钟穷举预言机）、步长 / 区间 / 周 0-7 归一                          |
| `kernel/review.ts#applyAddresses`                      | 只动 open、已处置不被改写、幂等、去重后顺序无关、未知 id / 不合法处置零变化                        |
| `kernel/cards.ts#closeCardsOnFinish`                   | 只收本批结束 run / 任务的开卡、非 open 不收、本批已答已关不收、重复调用幂等                        |
| `kernel/thread-context.ts#headTailSplit` / `dropToFit` | 头尾恰好用满预算、`dropped = len - max`、从低重要性段开始丢、段内保新弃旧                          |
| `kernel/workflow/stage-machine.ts`                     | `completeExits` 幂等且形状封闭、悬空 / 自指 goto 零流转、判定预算累计口径                          |
| `kernel/project.ts#normalizeTask` / `normalizeCard`    | 归一幂等、老字段全部补齐且已有值不改、`kind` 按「有没有选项」兜底                                  |
| `kernel/prompt.ts`                                     | 反馈段顺序无关 / 只留最近 N / 不超预算、来源工单保尾、回答提示词的问答对排序                       |
| `protocol/validate.ts`（负向）                         | 任意值不抛错且结论二元完备、合法命令二次校验逐字相同（封闭）、必填键与形状被破坏必拒且点名到具体键 |

不写性质的层：`renderer/**` 与 `components/ui/**`（随机 DOM 只添噪声）、桥接契约（枚举穷举比随机准）、`host/**` 装配（要真实 SQLite 时序）、`e2e`（随机化等于制造 flaky）。`protocol/validate.ts` 是例外：合法形状仍以枚举为主，另加一组**负向**性质——枚举写不出「我没想到的坏输入」，而校验层面对的是 renderer 传来的不可信数据，`fc.anything()` 正好覆盖那片空白（见下节）。单文件性质用例预算 < 1s，`numRuns` 50–300，靠生成器质量而不是 runs 数；不进 `pnpm check` 快链。

### 怎么写性质测试

- 性质用例与示例用例**同文件**（例：`tests/kernel/cron.test.ts`），用 `fc.assert(fc.property(...))`。
- **固定种子**：种子写死（`FC_SEED` 环境变量可覆盖）→ 同一份输入永远给出同一条反例，门禁可复现，不会时红时绿。
- 失败时 fast-check 会打印**收缩后的最小反例**，可直接照抄成回归用例。
- fast-check v4 的 `fc.date` **默认会生成 Invalid Date**（`noInvalidDate` 默认 false）；要合法时刻必须显式 `noInvalidDate: true`。
- 性质要挑**内核不变量**（钳制、幂等、单调、解析↔执行往返），不是把实现再写一遍——内核是纯函数、不读时钟，性质才立得住。
- 预言机要与被测实现**走两条路径**：例如「下一次触发时刻」用逐分钟穷举扫墙钟，独立核对内核的「按天→按时→按分」扫描。

### 怎么跑变异测试

| 命令                    | 范围                                                             | 何时                              |
| ----------------------- | ---------------------------------------------------------------- | --------------------------------- |
| `pnpm mutation:cron`    | `src/kernel/cron.ts`（`stryker.config.json` 的 `mutate` 默认值） | 单模块快速复核 / 合并前 / CI 定时 |
| `pnpm mutation:changed` | 本次改动涉及的内核模块（由 `scripts/mutation-scope.mjs` 圈定）   | MR / CI 每次跑                    |
| `pnpm mutation:scan`    | 内核全部 + `protocol/validate.ts`（33 个文件）                   | 定期 / 夜间                       |

- 增量与预演不单开脚本，直接透传标志：`pnpm mutation:cron -- --incremental`、`pnpm mutation:changed -- --incremental`（命中 `.scratch/mutation/incremental.json` 缓存，迭代复验用）、`pnpm mutation:scan -- --dry-run`（只打印范围）。

- 报告落在 `.scratch/mutation/`（一次性产物，已 git 忽略）。
- 变异测试比单测慢一个数量级（每个变异体跑一遍相关测试），**不进 `pnpm check` 快链**，只在合并前 / CI 定时跑。
- pnpm 的隔离布局下 Stryker 从 core 包自己的同级目录找插件、找不到 runner，`stryker.config.json` 里用显式路径声明插件（`./node_modules/@stryker-mutator/vitest-runner/dist/src/index.js`）。

- 成本与被变异代码量近似线性：`src/kernel/cron.ts`（251 行 / 278 个变异体）单轮约 5 分钟；`src/kernel` 全部 8315 行按此推算是小时级，所以**必须用 `--mutate` / 增量模式限定范围**，不要全仓跑。
- 范围圈定：`pnpm mutation:changed` 只变异「本次改动碰过的内核模块」（`scripts/mutation-scope.mjs` 按 git diff 圈定，未触及内核就跳过并放行）；CI 里用 `MUTATION_BASE=origin/main` 把分支差异也算进来。

### 变异范围分层

### CI 下的范围解析

CI 里代码已经提交、工作区是干净的，**`git diff HEAD` 查不到任何东西**——范围必须以 MR 的目标分支为基准来算，否则「查不到改动」会被误判成「没改内核」而放行。

基准解析顺序（`scripts/mutation-scope.mjs`）：

| 顺序 | 来源                             | 说明                             |
| ---- | -------------------------------- | -------------------------------- |
| 1    | `--base <ref>`                   | 显式指定，最可控                 |
| 2    | `MUTATION_BASE`                  | 环境变量写法                     |
| 3    | `CI_MERGE_REQUEST_DIFF_BASE_SHA` | GitLab MR 流水线（目标分支提交） |
| 4    | `CI_COMMIT_BEFORE_SHA`           | GitLab 普通流水线（上次提交）    |
| 5    | `GITHUB_BASE_REF`                | GitHub Actions（PR 目标分支）    |
| 6    | 工作区改动                       | 仅本地：已改 + 已暂存 + 未跟踪   |

- **CI 里解析不到基准 → 直接失败（exit 2），不放行。** 范围不可知就不能让门禁假绿；请显式传 `--base` 或设 `MUTATION_BASE`。
- 浅克隆会算不出差异：GitHub Actions 的 `actions/checkout` 要 `fetch-depth: 0`，GitLab 要 `GIT_DEPTH: 0`；否则报「无法与基准比较」。
- 「值得做变异测试的代码集合」= (`src/kernel` ∪ `src/protocol`) − 排除名单。`src/host`、`src/server`、`src/renderer` 不在内：IO 密集，变异大多被 mock 吸收。只改这些层的 MR 会打印「范围内没有可变异的产品代码」并跳过——这是有意的，不是漏跑。
- 空范围分两种：**算出来的空**（确实没改内核）→ exit 0 跳过；**算不出来的空**（CI 缺基准）→ exit 2 失败。

固定只盯一个文件是错的用法——范围要**随改动自动扩张**。三层分工：

| 层         | 命令                                  | 范围                                           | 何时        | 成本     |
| ---------- | ------------------------------------- | ---------------------------------------------- | ----------- | -------- |
| MR 门禁层  | `pnpm mutation:changed`               | 本次改动碰过的模块（git diff 自动圈定）        | 每次 MR     | ∝ 改动量 |
| 定点复核层 | `pnpm mutation:cron -- --incremental` | 指定模块 + 增量缓存                            | 迭代复验    | ~45s     |
| 全量扫描层 | `pnpm mutation:scan`                  | 内核全部 + `protocol/validate.ts`（33 个文件） | 定期 / 夜间 | ~110min  |

先用 `pnpm mutation:scan -- --dry-run` 打印扫描范围再决定要不要跑。

扫描范围**排除**纯类型 / 纯常量 / 纯路由（变异只产噪音）：`kernel/types.ts`、`kernel/decide.ts`（规则都在 `commands/*`）、`kernel/view-spec.ts`、`protocol/{entities,facts,commands,inputs,ipc,views,plugins,rules,review,thread,task-comment,receipt-keys,channels,manifest,executor,worker,model-id,plugin-host}.ts`。

### e2e 没有变异测试器：两条替代手段（2026-11-13）

Stryker 只能变异**被测源码**再跑单测 runner（vitest/jest 一类）；`tests/e2e/*.spec.ts` 靠 Playwright 起真实服务进程与 Chromium，没有任何变异测试器能驱动它。于是「e2e 全绿」这件事本身不被自己证明——断言写歪、选择器恒真、等错元素都会得到一片绿。补两处：

| 手段                         | 抓什么                                                                                                                 | 命令 / 位置                                                         | 进快链 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| 断言强度 lint                | 空断言、漏 `await` 的断言、`force: true`、被跳过（skip / fixme）的用例、**没有断言的用例**、`isVisible()` 取布尔再断言 | `pnpm lint`（`eslint.config.mjs` 末两段：playwright / vitest 插件） | 是     |
| `protocol/validate` 负向性质 | 任意不可信输入下不抛错、结论二元完备、必填键与形状被破坏必拒且点名到键                                                 | `pnpm test`（`tests/protocol/validate.test.ts` 末尾的负向性质组）   | 是     |

两条 lint 门槛只对测试文件生效，严重度沿用上游 recommended，只有两处按本仓库口径调整：`vitest/valid-expect` 放开 `maxArgs: 2`（`expect(value, message)` 是合法签名，用来标注「哪个键、哪条规则」）、`vitest/no-conditional-expect` 降到 warn（性质用例与表驱动用例按生成物形状分支断言是真的，逐条改写成不断言的形态只会更难读；真·空转用例由 `expect-expect` 兜住）。`expect-expect` 是这两段里唯一**加严**的地方：提升到 error，并认 `expectDispatched` 这类包装断言。

### 哪些模块值得优先覆盖

按仓库事实排序（规则密度 = 条件表达式数，改动/修复 = git 历史）：

| 模块                                   | 行数 | 规则数 | 改动 | 修复 | 估算变异体 | 判断                                            |
| -------------------------------------- | ---- | ------ | ---- | ---- | ---------- | ----------------------------------------------- |
| `src/protocol/validate.ts`             | 1264 | 264    | 33   | 0    | ~1390      | **最高**：规则密度全仓第一，校验错=放行非法输入 |
| `src/kernel/commands/run.ts`           | 559  | 95     | 14   | 1    | ~615       | 高：运行生命周期（预算/租约/退避/超时）         |
| `src/kernel/thread-context.ts`         | 590  | 100    | 11   | 0    | ~649       | 高：上下文截断/预算段规则密                     |
| `src/kernel/commands/workflow.ts`      | 414  | 94     | 13   | 1    | ~455       | 高：阶段校验与转移                              |
| `src/kernel/review.ts`                 | 467  | 79     | 4    | 1    | ~514       | 高：评审闭环判定                                |
| `src/kernel/rules.ts`                  | 471  | 71     | 8    | 0    | ~518       | 高：规则触发（cronDue 恰好一次）                |
| `src/kernel/commands/task.ts`          | 374  | 61     | 13   | 1    | ~411       | 高：任务派生与 rollup                           |
| `src/kernel/run.ts`                    | 382  | 59     | 11   | 2    | ~420       | 高：修复密度第一（2 次）                        |
| `src/kernel/prompt.ts`                 | 428  | 33     | 24   | 1    | ~471       | 中高：改动最频繁                                |
| `src/kernel/workflow/stage-machine.ts` | 280  | 50     | 11   | 0    | ~308       | 中：阶段状态机                                  |
| `src/kernel/project.ts`                | 277  | 28     | 21   | 1    | ~305       | 中：项目维度（改动频繁）                        |

`src/renderer/**` 与 `src/host/**` **不做变异测试**：IO 密集，变异大多被 mock 吸收，噪音远大于信号；那里的价值用**性质测试**（纯函数的格式化/裁剪不变量）拿更划算。

### 性能实测（`src/kernel/cron.ts`，278 个变异体，2026-11-13）

| 方式                                    | 耗时  | 说明                             |
| --------------------------------------- | ----- | -------------------------------- |
| `concurrency: 2`                        | 5m15s | 初版配置，机器基本空转           |
| `concurrency: 10`                       | 3m10s | 本机甜点：20 逻辑核留一半给系统  |
| `concurrency: 19`（Stryker 默认 cpu-1） | 6m37s | 过载反而更慢：并发不是越高越好   |
| `concurrency: 10` + `--incremental`     | 44.6s | 命中增量缓存（测试与源码都没变） |

- **并发别写死 2**：Stryker 默认是 `cpuCount - 1`，但本机 20 逻辑核下 19 个 worker 过载，比 10 慢一倍。`stryker.config.json` 里固定 `concurrency: 10`。
- **增量缓存是迭代场景的大杀器**：缓存文件在 `.scratch/mutation/incremental.json`（一次性产物，已 git 忽略），源码与测试都没变时 3m10s → 44.6s；改了测试只会重跑受影响的变异体。
- **高并发需要更宽的 per-test 超时**：每个变异体都要起一次 vitest 进程，并发 10 时单个变异体墙钟约 5 秒，vitest 默认 5 秒的 per-test 超时会把「跑得慢」误判成「用例失败」，而 Stryker 把超时计作 killed、评分会虚高。变异测试用独立的 `vitest.mutation.config.mts`（继承主配置的 include / setupFiles，只放宽 `testTimeout` 到 30s）。
- **换机器要重新标定**：`concurrency` 与超时是本机实测值，不是通用最优。

### 试点实测（`src/kernel/cron.ts`，2026-11-13）

| 轮次                                                                              | 性质用例数 | 变异评分 | 说明                                                  |
| --------------------------------------------------------------------------------- | ---------- | -------- | ----------------------------------------------------- |
| 仅示例用例                                                                        | 0          | 82.73%   | 已有用例看似全绿，48 个变异体存活                     |
| + 边界 / 严格性断言（严格晚于 / 分钟对齐 / 字段升序 / domStar 语义 / 正则与越界） | 20         | 85.61%   | 多杀 8 个变异体：排序、domStar 语义、越界与正则校验类 |
| + 夏令时切换日断言（非重叠墙钟恰好一个瞬间）                                      | 28         | 85.61%   | 未再杀新变异体——剩余存活项经人工判定为等价变异体      |

存活下来的多数是**等价变异体**（V8 二分插入排序下恒正比较器不改顺序、时区偏移采样冗余、魔数 ±1），不是断言漏洞；但 106–110 行那批（墙钟一致性校验）在切换日确实能被改坏而无人发现——这类缺口正是变异测试要暴露的东西。

## 与 SPEC 的关系

- SPEC-shell 的 Testing Strategy 写明「v1 不做 E2E」；2026-10-30 按需求**升级**为引入 Playwright E2E，本文件为准。SPEC 中其余测试要求（registry 遍历断言、machine 分支全覆盖、知会走 mock）全部保持有效。
- 服务启停、知会轻提示、铃声等真实感官行为仍以手动验收为准，清单见 [TEST-CASES.md](TEST-CASES.md)。
