# M3 测绘：执行器插件化的注入点、测试伪造面与质量门禁

> 范围：M3（执行器插件化）开工前的只读测绘。证据均为 `相对路径:行号`（2026-11-05，master `831f2dd`，工作区干净）。
> 本文只写「现状 + 落点 + 需要拍板的分叉」，不写实现方案细节；不含任何抑制检查器的注释或未完成标记（`scripts/floor-guard.mjs` 也会扫描本文）。

## 0. 结论速览

| 项          | 结论                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注入点      | `scheduler` 只认 `SchedulerExecutors.forRuntime(runtime)`（`src/host/scheduler.ts:36-38,439-441`）；装配根 `src/main/index.ts:106` 传 `createRuntimeExecutors(runtimeDeps)`                                          |
| 路由现状    | 按 `runtime.protocolFamily` 选后端（`src/main/ai-workflow/executor-port.ts:82-93`）；`run.executorKey` 已落库但值就是 `runtime.protocolFamily`（`src/kernel/decide.ts:267,415`，`src/protocol/entities.ts:325-326`） |
| 测试伪造面  | 三分之二用「最大 6 行的对象字面量」当 `ExecutorPort`（`{run}` 即可，`probe/models` 可选：`src/protocol/executor.ts:97-101`）；只有 `tests/host/chat.test.ts:101` 走真实适配层                                        |
| ESLint      | host 段当前明确「只允许依赖 protocol」（`eslint.config.mjs:68-70`），M3 要改写并加 plugins/sdk 两段；「插件互相 import」ESLint 表达不了，要落成源码扫描测试（与 `tests/kernel/purity.test.ts` 同款）                 |
| floor-guard | 搬家后**必须**补 `RELOCATED_TESTS`（`scripts/floor-guard.mjs:118-138` 的 `strip()` 只认「去掉 `src/`/`tests/` 前缀后路径相等」，跨层搬家匹配不到）                                                                   |
| 覆盖率      | 阈值 98/93/95/98（`vitest.config.mts:17-23`）；当前实测 99.74/97.79/100/≈100（`coverage/coverage-final.json`，87 文件）；改动行 ≥90%（`scripts/check-diff-coverage.mjs:14`，M2 为 1024/1031=99.32%）                 |
| 纯类型文件  | 只有 `types.ts` / `*.d.ts` 免改动行覆盖率（`scripts/check-diff-coverage.mjs:103,130-136`）→ `src/sdk` 的纯类型入口**必须**命名为 `types.ts`，否则 diffcov 直接红（同一坑 `tasks/plan.md:54,56` 已记录两次）          |
| E2E         | **不启动真 dsh CLI**：`tests/e2e/ai-workflow.spec.ts` 全是 UI 断言，崩溃恢复用例的子进程是 `node -e setTimeout`（`tests/e2e/helpers/seed-crash.ts:60-70`）                                                           |

## 1. 注入契约与装配顺序

### 1.1 scheduler 怎么拿 ExecutorPort

| 环节       | 位置                              | 行为                                                                                                  |
| ---------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 端口类型   | `src/protocol/executor.ts:97-101` | `ExecutorPort { probe?; models?; run(turn,io) }`，`run` 必选                                          |
| 注入契约   | `src/host/scheduler.ts:36-38`     | `SchedulerExecutors { forRuntime(runtime: Runtime): ExecutorPort }`（结构类型，不 import main）       |
| 注入字段   | `src/host/scheduler.ts:66-72`     | `SchedulerDeps.executors`；注释写明「装配根注入 main 侧实现」                                         |
| 唯一调用点 | `src/host/scheduler.ts:437-441`   | `await deps.executors.forRuntime(runtime).run(turnOf(...), io)`，在 `registry.begin()` 之后、`try` 内 |
| 运行时来源 | `src/host/scheduler.ts:236-238`   | `runtimeOf(run)`：`run.runtimeId === null` 返回 `undefined`，否则从 `deps.runtimes()` 找              |

错误路径（M3 要新增/改的分支都在这里）：

| 分支              | 位置                                       | 现状                                   | M3 影响                                                                                          |
| ----------------- | ------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 运行时不存在      | `src/host/scheduler.ts:485-491`            | `settleFailed(run,'runtime_missing')`  | 不变                                                                                             |
| 运行时停用        | `src/host/scheduler.ts:492-495`            | `settleFailed(run,'runtime_disabled')` | 不变                                                                                             |
| `forRuntime` 抛错 | 无专门分支：异常落到 `:453-479` 的 `catch` | 归 `executor_lost`（未 aborted 时）    | **新增**：未知 `executorKey` 应在 `forRuntime` 抛出或返回 null，需决定 errorCode（见 §7 问题 2） |
| 执行器抛错        | `src/host/scheduler.ts:453-479`            | `run.host_settled{failed               | executor_lost}`/`cancelled`                                                                      | 不变 |
| 无回执 / 兜底     | `src/host/scheduler.ts:392-407,216-224`    | `run.host_settled`                     | 不变                                                                                             |

`ExecutorIO` 三通道（`src/host/scheduler.ts:335-356`，类型 `src/protocol/executor.ts:63-73`）：`emit` → 帧缓冲；`session` → 回执兜底（`:351-353,447-451`）；`process` → `process_registry.attachPid`（`:355`）。插件只能经 `io` 回报，**不能**直接写 `process_registry`（`src/host/process-registry.ts:5-13` 注释即「调度器驱动」）。

### 1.2 boot 装配顺序（`src/main/index.ts`，`app.whenReady` 内）

```
requestSingleInstanceLock（:69）
→ whenReady → setAppUserModelId → registerIpcHandlers（:82-83）
→ openDatabase(userData/ai-workflow.db)（:90）
→ createStore({db,kernel})（:92-93）
→ importLegacyIfNeeded → store.ensureProjection（:96-97）
→ mkdirSync(sessionsDir)（:100-101）→ runtimeDeps={sessionRoot}（:102）
→ backendFor(family)=createRuntimeBackend(...)（:103-104）  ← M3 删除
→ executors = createRuntimeExecutors(runtimeDeps)（:106）    ← M3 换成插件注册表
→ createProcessRegistry(db)（:111）→ reconcile(...)（:112-120）→ console.warn 诊断（:122-126）
→ createEffects({store, scheduler:()=>scheduler, notifyChanged})（:129-133）
→ createClock({..., onTick:()=>scheduler.wake()})（:145-152）
→ createScheduler({dispatch, runtimes, executors, limits, lastFrameSeq, registry, rearmClock,
    onChatStream, onChatStreamEnd, chatFallbackPrompt})（:153-176）
→ activeScheduler = scheduler（:178）
→ registerAiWorkflowIpc({store, dispatch, backendFor})（:179-183）  ← M3 的 backendFor 也变
→ scheduler.wake()（:186）→ clock.start()（:187）
→ createWindow()（:189）→ createTray（:194-198）
```

- 启动期「scheduler 未装配」的两处例外：对账直接 `store.dispatch`（`:109-110,116`），effects 用闭包惰性取 scheduler（`:129-133`，`src/host/effects.ts:26-29`）。
- 固定约束：`tests/host/boot.test.ts:366-379` 断言 `startupOrder` 全序 `['openDatabase','createStore','importLegacy','ensureProjection','registry','reconcile','clock','scheduler','ipc']`；`:348-350` 断言 `createRuntimeExecutors` 收到含 `sessions` 的 `sessionRoot`；`:401` 断言 scheduler 拿到的 `executors` 是同一实例。**M3 改装配必须在同一提交里改这三处断言**，否则 boot 用例红。
- 退出：`before-quit` → `activeScheduler?.cancelAll()`（`:209-213`）。

### 1.3 host→plugins 后要加/改的 ESLint 规则

现有规则原文（`eslint.config.mjs`）：

- `:28-29` `files: ['src/renderer/**/*.{ts,tsx}', 'tests/renderer/**/*.{ts,tsx}']`，禁 `electron` 与 `node:*`/`fs`/`path`/`os`/`child_process`/`crypto`，禁 `**/src/main/**`、`**/main/**`。
- `:55-66` `files: ['src/main/**/*.{ts,tsx}', 'tests/main/**/*.{ts,tsx}']`，`patterns: [{ group: ['**/renderer/**'], message: 'main 不得 import renderer（依赖方向单向）。' }]`。
- `:71-93` `files: ['src/host/**/*.{ts,tsx}']`，`paths: [{name:'electron', message:'host 不直接依赖 Electron：窗口/托盘/IPC 由装配根 main 注入。'}]`，`patterns: ['**/src/main/**','**/main/**']`（'host 不得 import 主进程装配层（依赖方向 main → host 单向）。'）+ `['**/renderer/**']`。**注意段内注释原文（`:68-70`）：「host 是宿主层，只允许依赖 protocol（与 kernel 类型）……M2 起这条边界由 ESLint 强制」——M3 起这句要改写。**
- `:96-140` `files: ['src/kernel/**']`，禁 `electron`/`node:*`/`fs`/…/`https` + `['**/shared/**','**/main/**','**/host/**','**/plugins/**','**/renderer/**']`（'kernel 只允许依赖 src/protocol 的类型。'），另有 `no-restricted-properties`（`Date.now`/`Math.random`）与 `no-restricted-globals`（`fetch`）。
- `:141-149` `files: ['tests/kernel/**/*.test.{ts,tsx}']` 把上面三条 `off`（纯度测试要读盘）。
- `:8` `ignores: ['node_modules/**','out/**','dist/**','release/**','coverage/**','scripts/**']`。

需要加/改（按 ARCHITECTURE 依赖方向原文 `docs/ARCHITECTURE.md:49-55`：`host ──▶ kernel + protocol + sdk + 插件注册表；plugins ──▶ sdk + protocol`）：

| 动作 | 目标段                               | 规则                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 改   | `src/host/**`（`:71-93`）            | 注释与语义改为「host 允许 `sdk` 与 `plugins/registry`（装配），**禁止**具体插件实现」：`patterns` 增 `group: ['**/src/plugins/executors/**','**/plugins/executors/**','**/src/plugins/sources/**','**/plugins/channels/**','**/plugins/apps/**']`，message「host 只通过注册表取插件，不直接 import 具体插件实现」；保留禁 `main`/`renderer`/`electron` |
| 加   | `src/plugins/**`、`tests/plugins/**` | `no-restricted-imports` 禁：`electron`、`node:*`、`fs`、`fs/*`、`path`、`os`、`child_process`、`crypto`、`net`、`http`、`https`（副作用只能来自 sdk）、`**/host/**`、`**/main/**`、`**/renderer/**`、`**/shared/**`                                                                                                                                    |
| 加   | `src/sdk/**`、`tests/sdk/**`         | 只允许 `**/protocol/**`（与 kernel 段同形，但不禁 `Date.now`：sdk 是类型+注入点，clock 由宿主注入）；禁 `host`/`plugins`/`main`/`renderer`                                                                                                                                                                                                             |
| 保留 | `src/kernel/**` `:96-140`            | 已含 `**/plugins/**`，无需改（插件不得被 kernel import）                                                                                                                                                                                                                                                                                               |
| 可选 | renderer 段 `:28-54`                 | 若 `src/sdk` 含 renderer 可见类型，需补「renderer 不得 import `**/sdk/**`、`**/plugins/**`」两条；若 sdk 只在主进程侧使用则不必                                                                                                                                                                                                                        |

ESLint 表达不了的两件事（必须落到测试，见 §4.3）：①插件之间互相 import（相对路径不含 `/plugins/`，`no-restricted-imports` 的 group 匹配不到）；②`capabilities` 声明与源码实际用法的一致性。

## 2. 现有测试如何伪造执行器 + 搬到 tests/plugins 后的 floor-guard 判定

### 2.1 五种伪造方式（按耦合度递增）

| 测试                                            | 伪造物                                                                                                                                                                  | 注入点                                                         | 证据                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `tests/host/scheduler.test.ts`                  | `portOf(handler)`：`{ run: async (turn, io) => handler(turn, io) }` 直接当 `ExecutorPort`（`probe/models` 省略，类型允许）                                              | `executors: { forRuntime: () => port }`                        | `:110-114`、`:129-141`                                            |
| `tests/host/cancel.test.ts`                     | 同上 `portOf`，另有 `cancellablePort`/`stuckPort`（用 `deferred` 卡住）                                                                                                 | `makeScheduler` 的 `executors` 可覆盖                          | `:90-94`、`:189-219`、`:230-250`                                  |
| `tests/host/process-registry.test.ts`           | `portOf` + 真实 `createProcessRegistry`                                                                                                                                 | `executors: { forRuntime: () => port }`                        | `:49`、`:191-196`                                                 |
| `tests/host/chat.test.ts`                       | **真实适配层**：`createExecutorPort(backend)`，`backend` 是按脚本返回 `ExecutorBackendOutcome` 的假后端；IPC 侧再给 `backendFor: () => ({probe,models,execute})` 假后端 | `executors: { forRuntime: () => createExecutorPort(backend) }` | `:97-125`（`:101`）、`:127-144`、`:146-160`                       |
| `tests/host/executor.test.ts`                   | 直接测适配层：`fakeBackend(responses)` 记录 `ExecutorBackendRequest` + `ioRecorder()`                                                                                   | 无 scheduler                                                   | `:45-80`、`:82-193`（归一）、`:195-307`（`resume_rejected` 重试） |
| `tests/host/ipc.test.ts`                        | `backend: RuntimeBackend`（`probe`/`models` 为 `vi.fn`，`execute: vi.fn`）                                                                                              | `createAiWorkflowHandler({ backendFor: () => backend })`       | `:33-37`、`:64-71`、`:94-99`                                      |
| `tests/host/boot.test.ts`                       | `vi.mock('../../src/main/ai-workflow/executor-port', () => ({ createRuntimeExecutors }))`，`executorsMock={forRuntime:vi.fn()}`                                         | 模块级 mock                                                    | `:27`、`:113-114`、`:178-180`、`:401`、`:503`                     |
| `tests/main/ai-workflow/runtime/dsh.test.ts`    | `FakeChild implements SpawnedProcess`（可手推 stdout/stderr/close/error、记录 stdin 写入与 kill 信号）+ `harness()` 假 `SpawnFn`/假 `killTree`                          | 通过 `DshDeps{spawn,killTree,now,timeouts,grace}`              | `:24-100`、`:123-127`                                             |
| `tests/main/ai-workflow/runtime/detect.test.ts` | `vi.mock('node:fs')` 只替换 `statSync`（模拟 POSIX 可执行位），其余真实；用 `await import(...)` 拿到被 mock 后的模块                                                    | 模块级 mock                                                    | `:11-38`                                                          |
| `tests/e2e/**`                                  | 无执行器伪造；崩溃恢复只种一个 `node -e setTimeout` 进程当「残留 pid」                                                                                                  | 真实 DB 种子                                                   | `tests/e2e/helpers/seed-crash.ts:60-70`                           |

### 2.2 floor-guard 的搬家判定（`scripts/floor-guard.mjs`）

| 机制         | 位置       | 语义                                                                                                                                                                                               |
| ------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 逐行规则扫描 | `:79-101`  | 所有新增行（含**未跟踪文件全文**，`:62-75`）按 `SUPPRESSIONS`/`STUBS`/`SKIPS` 三类正则判；`scripts/**` 与 `CONSTRAINTS.md` 例外。**`.md` 不例外**——所以 M3 的计划/测绘文档里也不能出现那三类字面量 |
| 删测试判定   | `:139-144` | `deleted` 里的测试文件：若其被测源码也删了 → 放过；否则要求 `migratedCounterpart` 命中，否则 `test-deleted`                                                                                        |
| 被测源码候选 | `:106-117` | `sourceOf(f)`（同目录同层）+ `tests/x.test.ts → src/x.ts`（跨层）                                                                                                                                  |
| 搬家映射     | `:118-129` | `RELOCATED_TESTS` 显式表（现 4 条，全是「旧测试的行为在新位置重写」）                                                                                                                              |
| 兜底匹配     | `:130-138` | `strip(p)=p.replace(/^(src                                                                                                                                                                         | tests)\//,'')` 相等即算搬家 |
| 断言净减少   | `:145-162` | 同文件删除的 `expect/assert/should` 行数 > 新增行数 → `assertion-removed`                                                                                                                          |

结论：`tests/main/ai-workflow/runtime/dsh.test.ts → tests/plugins/executors/dsh/dsh.test.ts` 的 `strip()` 结果是 `main/ai-workflow/runtime/dsh.test.ts` vs `plugins/executors/dsh/dsh.test.ts`，**匹配不到**；若 `src/main/ai-workflow/runtime/dsh.ts` 同时删除，则「源码与测试一起删」的豁免会盖住（`:141`），但仍然拿不到「新位置已被覆盖」的证据。M3 应两种都做：加 `RELOCATED_TESTS` 条目 + 保证源码删除与测试新增在同一提交。

需要新增的映射（最小集，见 §6 全表）：

```js
// scripts/floor-guard.mjs 的 RELOCATED_TESTS 追加
'tests/main/ai-workflow/runtime/dsh.test.ts': 'tests/plugins/executors/dsh/dsh.test.ts',
'tests/main/ai-workflow/runtime/detect.test.ts': 'tests/plugins/executors/dsh/detect.test.ts',
'tests/main/ai-workflow/runtime/registry.test.ts': 'tests/plugins/registry.test.ts',
'tests/main/ai-workflow/runtime/executor-port.test.ts': 'tests/plugins/executors/dsh/port.test.ts',
'tests/main/ai-workflow/runtime/process.test.ts': 'tests/host/process.test.ts',
'tests/main/ai-workflow/runtime/executable.test.ts': 'tests/host/executable.test.ts',
```

（`host/executor.test.ts` 若随 `src/host/executor.ts` 一起删除则不需要；若适配层保留在 host 而只搬测试，则同样需要一条映射。）

## 3. 质量门禁现状

| 项                      | 内容                                                                                                                                                        | 证据                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm check`            | `check:fast`（typecheck + lint + check:floor + check:secrets）→ `test:coverage` → `check:diffcov` → `audit`                                                 | `package.json:28`、`:27`、`:21-26`                                                       |
| 覆盖率阈值              | statements 98 / branches 93 / functions 95 / lines 98                                                                                                       | `vitest.config.mts:17-23`、`CONSTRAINTS.md:21`                                           |
| 当前基线（实测）        | 99.74 / 97.79 / 100 / ≈100（`coverage/coverage-final.json`，87 文件）；M2 退出记录 99.73/97.78/100/100                                                      | 本文件同时刻重算；`CONSTRAINTS.md:40,68`                                                 |
| 分模块薄弱点            | `src/host/scheduler.ts` st 97.19% / br 87.97%；`src/main/ai-workflow/runtime/dsh.ts` st 99.40% / br 94.67%；其余执行链 100%                                 | 同上重算（`coverage/coverage-final.json`）                                               |
| 改动行门槛              | ≥90%，默认 base `master`；不可执行的纯类型文件只认 `types.ts` / `*.d.ts`；**改动源码文件若没被任何测试加载过 → 直接判未覆盖**（`:130-136`）                 | `scripts/check-diff-coverage.mjs:14,101-103,130-136`                                     |
| M2 改动行实测           | 1024/1031 = 99.32%                                                                                                                                          | `CONSTRAINTS.md:68`、`check-run.log` 尾部                                                |
| stage-machine 分支 100% | 目标写在验收表；当前 `src/kernel/workflow/stage-machine.ts` 100/100/100/100                                                                                 | `docs/ARCHITECTURE.md:255`；覆盖率数据同上                                               |
| E2E                     | `pnpm e2e` = `build:compile` + Playwright（`testDir tests/e2e`，workers 1，无重试）；`pnpm e2e:packaged` 单独配置                                           | `package.json:31-32`、`playwright.config.ts:7-16`、`playwright.packaged.config.ts:11-21` |
| 提交流程                | pre-commit = lint-staged + typecheck；pre-push = `check && e2e`；commit-msg = commitlint                                                                    | `.husky/pre-commit`、`.husky/pre-push`、`.husky/commit-msg`                              |
| 门禁脚本的两个坑        | ① 在 `master` 上直接改，`merge-base master HEAD` 退化成无改动 → 假绿，必须开分支或用 `CONSTRAINTS_BASE`；② 沙箱内 `execFileSync('git')` EPERM → 脚本 exit 2 | `tasks/plan.md:62,63`                                                                    |

E2E 是否会打真 CLI：**不会**。

- `tests/e2e/ai-workflow.spec.ts:16-58`：点标签、切栏目、打开运行时/智能体/工作流设置页，纯 UI。
- `tests/e2e/crash-recovery.spec.ts:27-79`：种子库 + 残留 pid（`seed-crash.ts:60-70` 的 `node -e setTimeout`）+ 对账/拖动/重启。
- `tests/e2e/{smoke,pomodoro}.spec.ts`、`tests/e2e-packaged/packaged-sqlite.spec.ts` 与执行器无关。
- 因此 M3 后保持绿的充要条件是：`out/main/index.js` 能构建并启动（`pnpm e2e` 先 `build:compile`）、boot 装配不因缺插件抛错、`seed-crash.ts:78-95` 的 `runtime.create` 仍被接受（若 `executorKey` 变必填，这里必须给默认值）、UI 文案/`aria` 不动（`ai-workflow.spec.ts:37-46` 依赖「运行时」「新建运行时」「运行时名称」）。

## 4. src/sdk 最小能力面

### 4.1 SPEC 草案 vs 宿体现有 helper

SPEC 草案：`src/sdk/index.ts` 的 `Sdk { log, now, config, emit, process.spawn, fs.read/write }`（`docs/specs/SPEC-plugins.md:44-68`），能力枚举 `'net'|'fs.read'|'fs.write'|'spawn'|'notify'`（`:74`）。

| sdk 能力                         | 宿体现有实现                                                                                                                             | 执行器插件实际需要                                                                                        | 建议注入方式                                                                                                                                                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log(line)`                      | 无（宿主各处 `console.warn/error`）                                                                                                      | dsh 插件**不打印**（诊断全走 `probe.output`/回执 error）                                                  | `createSdk` 注入带插件 id 前缀的 `console.warn`；v1 只允许 warn/error（ESLint 已允许）                                                                                                                                              |
| `now()`                          | `dsh` 的 `deps.now`（`runtime/dsh.ts:44,316-319,642`）、scheduler `now`（`host/scheduler.ts:185`）、clock `now`（`host/clock.ts:32,95`） | 需要（`durationMs`、`checkedAt`、`elapsedMs`）                                                            | `() => Date.now()`（插件内部只拿毫秒数，ISO 由回执载体决定）                                                                                                                                                                        |
| `config<T>()`                    | 运行时行（`protocol/entities.ts:64-86`）+ `sessionRoot`（`main/index.ts:100-102`）                                                       | `sessionRoot`（写入 `MULTICA_DSH_SESSION_ROOT`，`runtime/dsh.ts:199`）、超时/宽限覆盖（测试用，`:48-51`） | `sdk.config<{sessionRoot:string}>()`：**注意** `sessionRoot` 是宿主全局路径，不是插件 manifest 的 `config` 字段；建议拆成 `sdk.paths.sessionRoot`，manifest 的 `config` 只放插件自有配置                                            |
| `emit(events)`                   | 不存在；执行器用 `io.emit`（`protocol/executor.ts:63-73`）                                                                               | **不需要**（执行器只能 `io.emit`，不能产原始事件）                                                        | 不给 executor 插件 `sdk.emit`（source 插件才需要）；executor 的 sdk 面裁掉它，避免绕过 `io`                                                                                                                                         |
| `process.spawn(argv, opts)`      | `host/process.ts:4-21`（`SpawnedProcess`/`SpawnOptions`/`SpawnFn`）、`:24-48 defaultSpawn`                                               | 必须（dsh 三处启动：`runtime/dsh.ts:194-206,224-241`）                                                    | `sdk.process.spawn(command, args, {cwd, env, shell})` 返回同形状 `Spawned`；宿主用 `defaultSpawn` 实现，测试注入假实现                                                                                                              |
| `process.killTree(pid, signal?)` | `host/process.ts:54-84`（Windows `taskkill /T /F`、POSIX 进程组）                                                                        | 必须（取消/超时/终止，`runtime/dsh.ts:258,757-766,889`）                                                  | `sdk.process.killTree`                                                                                                                                                                                                              |
| 可执行文件解析                   | `host/executable.ts:98-126 resolveExecutable`、`:129-133 needsShell`、`:33-39 defaultScanDirs`、`:65-83 findInDirs`                      | 必须（探测/启动要绝对路径 + shell 判定，`runtime/dsh.ts:194-205,321`；detect 要扫目录）                   | `sdk.process.resolve(command) → {path, shell}` + `sdk.process.scanDirs()`；**不要**把 `findInDirs/statSync` 直接暴露成裸 fs（见下）                                                                                                 |
| `fs.read/write`                  | 无插件消费者（`sessionRoot` 由 dsh 子进程自己写）                                                                                        | 执行器**不需要**读写文件；`detect` 只需要「判断某路径是可执行文件」                                       | v1 最小面：不给裸 `fs.read/write`；detect 需要的能力由 `sdk.process.resolve` / `sdk.process.scanDirs` 覆盖。若仍要 fs，只开 `fs.stat(path) → {isFile, mode}`（capability `fs.read`），并把 `read/write` 推后到 M4/M6 的 source 插件 |
| `process_registry`               | `host/process-registry.ts:24-37`                                                                                                         | 插件**不能**碰；只能 `io.process(pid)`                                                                    | 不暴露                                                                                                                                                                                                                              |

### 4.2 宿主如何注入（落点）

- `src/sdk/index.ts`：`export function createSdk(host: SdkHost, manifest: PluginManifest): Sdk`，`SdkHost` 是宿主能力原件（`spawn`/`killTree`/`resolve`/`scanDirs`/`now`/`log`/`paths`/`config`）。
- `SdkHost` 的唯一实现放 `src/host/`（它是「唯一有副作用的层」，`docs/ARCHITECTURE.md:163`）：`host/sdk-host.ts`，用 `defaultSpawn`/`killProcessTree`/`resolveExecutable`/`defaultScanDirs` 组装——**这样 `host/process.ts`、`host/executable.ts` 一行不改**（它们的测试 `tests/main/.../process.test.ts`、`executable.test.ts` 只改路径，见 §6）。
- 插件只经 sdk 拿 spawn/fs 的保证：ESLint 禁 `node:child_process`/`node:fs`（§1.3）+ 源码扫描测试（§4.3）+ `createSdk` 的能力门控。三层里前两层是编译/测试期，第三层是运行期。

### 4.3 capabilities 的静态检查（不新增基础设施）

| 层次                  | 做法                                                                                                                                                                                                                                                                                                      | 落点                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 编译期（import 面）   | ESLint 段：`src/plugins/**` 禁 `node:*`/`electron`/`host`/`main`/`renderer`/`shared`，只允许 `sdk` + `protocol` + 相对路径                                                                                                                                                                                | `eslint.config.mjs`（新增段，§1.3）   |
| 测试期（插件间边界）  | 复用 `tests/kernel/purity.test.ts:49-139` 的 `strip()`（去注释、保留字符串定位、去字符串定位符号）+ `importsOf()`，新写 `tests/plugins/boundary.test.ts`：扫 `src/plugins/**/*.ts`，任何 specifier 解析后落在**自己的插件目录之外**（除 `../../shared/**`、`../../sdk/**`、`../../../protocol/**`）即失败 | 新增 `tests/plugins/boundary.test.ts` |
| 测试期（能力 ↔ 用法） | 同一文件里：对每个 `src/plugins/<kind>/<id>/`，用 `strip().withoutStrings` 统计 `sdk.process.` / `sdk.fs.` 的出现，断言「用到但 manifest 未声明」与「声明但没用到」**双向为空**（`docs/specs/SPEC-plugins.md:66,260-263` 的要求）                                                                         | 同上                                  |
| 运行期（拒绝）        | `createSdk` 的 `process`/`fs` 用 getter：未声明 capability 时 `throw new Error('capability_not_declared: spawn')`；正向路径由 `tests/sdk/index.test.ts` 断言                                                                                                                                              | 新增 `tests/sdk/index.test.ts`        |

`manifest` 校验本身（`docs/specs/SPEC-plugins.md:71-84`）落 `tests/plugins/registry.test.ts`：id kebab-case + 全局唯一、`kind` 在枚举内、`version` 非空、`capabilities ⊆ 枚举`、executor 插件 `id === executorKey` 且 `run` 是函数、**目录 ↔ 注册表双向一致**（扫描 `src/plugins/executors/*` 与 registry 清单对比，防漏注册/幽灵注册）。这份用例的写法可直接照抄 `tests/renderer/src/shell/registry.test.ts:4-25`（现成的 registry 契约测试范式）。

## 5. 「新增一个假运行时协议只写插件即跑通」的验收路径

### 5.1 需要的测试文件

| 文件                                                   | 作用                                                                                                                                                              | 关键断言                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/plugins/registry.test.ts`                       | manifest 契约 + 注册表唯一性                                                                                                                                      | 见 §4.3；另断言 `executorById('fake')` 命中、`executorById('nope')` 抛可读错误、同一 key 重复注册抛错                                                                                                                                                                                               |
| `tests/plugins/support/fake-plugin.ts`（夹具，非用例） | 假执行器插件：`manifest{id:'fake',kind:'executor',capabilities:['spawn']}` + `run` 只 `io.emit` 两帧后返回回执（`probe/models` 返回常量）；`detect` 返回固定候选  | 被下面两个用例复用；夹具放 `tests/`（`docs/testing/TESTING.md:30` 的约定）                                                                                                                                                                                                                          |
| `tests/plugins/acceptance.test.ts`                     | 端到端：内存库 + 真 `store` + 真 `scheduler` + **真 registry（含 fake 插件）**；`runtime.create{executorKey:'fake'}` 建运行时 → 智能体 → 工作流 → 任务 → `wake()` | ① `run.executorKey==='fake'` 落库（`run_events`/`runs` 行）；② `run.frames` 两批帧 seq 从 1 起单调；③ 终态 `succeeded` 且 `run.receipt` 在帧之后；④ 另一个 `executorKey:'dsh'` 的运行时不被 fake 插件处理（用 spy 计调用次数 0/1）；⑤ 全流程**没有** import 任何 `main/**` 实现（暗示「只写插件」） |
| `tests/plugins/boundary.test.ts`                       | import 与能力声明边界（§4.3）                                                                                                                                     | 违规样本必须被抓（照 `tests/kernel/purity.test.ts:180-210` 的「护栏自检」写法）                                                                                                                                                                                                                     |
| `tests/sdk/index.test.ts`                              | sdk 能力门控                                                                                                                                                      | 未声明 `spawn` 时 `sdk.process` 抛错；`log/now/config` 恒可用；`config` 缺省值；`spawn` 透传 cwd/env/shell                                                                                                                                                                                          |
| `tests/plugins/executors/dsh/*.test.ts`                | 搬迁后的 dsh 用例（§6），覆盖帧/终态/取消/探测/模型/detect                                                                                                        | 与现 `tests/main/ai-workflow/runtime/dsh.test.ts` 逐例等价（帧解析、`ready` 校验、终态归一、取消 3 段时序、`resume_rejected`）                                                                                                                                                                      |

### 5.2 「只写插件即跑通」的判定方式

1. 新增一个 `src/plugins/executors/fake/`（真实目录，M3 可作内置演示插件，id 用 `command` 更符合 SPEC 清单 `docs/specs/SPEC-plugins.md:239`）+ `registry.ts` 一行；
2. `git diff --stat` 限制在 `src/plugins/**`、`src/plugins/registry.ts`、必要的 `src/protocol/entities.ts`（若新增 executorKey）——kernel/host 的 diff 只允许「路由键改读 `runtime.executorKey ?? runtime.protocolFamily`」这两行（`src/kernel/decide.ts:267,415`）；
3. 验收用例见上表；`tests/plugins/acceptance.test.ts` 里用**真** registry，而不是注入假 port——这是与现有 `tests/host/*` 用例的关键区别（现有用例全部注入假 port，见 §2.1）。

### 5.3 必须保持不动的测试（现有协议帧/终态/取消全绿）

| 文件                                                                                          | 保持方式                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/main/ai-workflow/runtime/dsh.test.ts`（1080 行，帧/终态/取消/探测/模型）               | 内容与断言不变，只改 import 路径搬走；逐例对得上 `docs/testing/TEST-CASES.md:55,60,70,71`（TC-AIW-009/014/024/025）                                                     |
| `tests/host/scheduler.test.ts`、`tests/host/cancel.test.ts`                                   | 用例体不动（仍注入假 port）；若 `executors` 契约改成「按 executorKey 取」，只在 `makeScheduler` 的 `executors` 字面量处改一行（`:136`、`:204`）                         |
| `tests/host/reconcile.test.ts`、`tests/host/clock.test.ts`、`tests/kernel/decide.run.test.ts` | 不动（与执行器选路无关）                                                                                                                                                |
| `tests/protocol/*.test.ts`                                                                    | 不动，**除非**放开 `PROTOCOL_FAMILIES`（`tests/protocol/entities.test.ts:336` 断言 `[...PROTOCOL_FAMILIES]` 恰为 `['dsh']`，`validate.test.ts:306` 断言非法族报错文案） |
| `tests/host/chat.test.ts`                                                                     | 用例不动；只把 `createExecutorPort` 的 import 从 `src/host/executor` 换成插件侧适配层位置                                                                               |

## 6. 需要新建/搬迁的测试文件清单

| 源 → 目标                                                                                           | 动作                            | floor-guard                                    | 备注                                                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `tests/main/ai-workflow/runtime/dsh.test.ts` → `tests/plugins/executors/dsh/dsh.test.ts`            | 搬（改 import）                 | 补映射                                         | 1008+ 行；`FakeChild`/`harness` 原样（`:24-100`），`DshDeps` → sdk 注入                          |
| `tests/main/ai-workflow/runtime/detect.test.ts` → `tests/plugins/executors/dsh/detect.test.ts`      | 搬                              | 补映射                                         | `node:fs` 的 `statSync` mock（`:11-38`）在插件侧仍可用；断言 `supported` 的来源改为 registry     |
| `tests/main/ai-workflow/runtime/registry.test.ts` → `tests/plugins/registry.test.ts`                | 合并                            | 补映射                                         | 现 2 例（未知族报错、dsh 委托）迁移为「未知 key 报错 + 注册表查询」                              |
| `tests/main/ai-workflow/runtime/executor-port.test.ts` → `tests/plugins/executors/dsh/port.test.ts` | 搬                              | 补映射                                         | 4 例；`createRuntimeExecutors` 换成插件 `createExecutorPlugin()`                                 |
| `tests/main/ai-workflow/runtime/process.test.ts` → `tests/host/process.test.ts`                     | 搬（就位对齐被测源码）          | 补映射                                         | 现路径测的是 `src/host/process`（`:10`），层级本就错位                                           |
| `tests/main/ai-workflow/runtime/executable.test.ts` → `tests/host/executable.test.ts`               | 搬                              | 补映射                                         | 同上（`:35`）                                                                                    |
| `tests/host/executor.test.ts` → `tests/plugins/shared/adapter.test.ts`                              | 搬（若适配层进 plugins/shared） | 若 `src/host/executor.ts` 同删则免映射，否则补 | 12 例：归一 + `resume_rejected` 重试                                                             |
| `tests/host/{scheduler,cancel,chat,process-registry,ipc,boot}.test.ts`                              | 原地改 import/mock              | 无                                             | `boot.test.ts:178-180` 的模块 mock 目标必须换成新装配模块                                        |
| `tests/plugins/{registry,acceptance,boundary}.test.ts`                                              | 新建                            | 无                                             | §5.1                                                                                             |
| `tests/sdk/index.test.ts`                                                                           | 新建                            | 无                                             | §4.3 运行期门控                                                                                  |
| `tests/e2e/helpers/seed-crash.ts`                                                                   | 原地改                          | 无                                             | 若 `executorKey` 必填，`:78-95` 补默认值                                                         |
| `tests/renderer/**/Runtime*`                                                                        | 原地改                          | 无                                             | 运行时表单若加执行器选择（`RuntimeDialog`/`RuntimeManager.tsx:330` 现在只显示 `protocolFamily`） |

tsconfig 与 vitest 接线（漏了会红）：

- `tsconfig.node.json:19-37` 的 `include` 需加 `src/sdk/**/*`、`src/plugins/**/*`、`tests/plugins/**/*`、`tests/sdk/**/*`（双工程 `composite`，漏配报 TS6307；`tasks/todo.md` T1 的验收条目同款经验）。
- `vitest.config.mts:14` 的 `include: ['tests/**/*.test.{ts,tsx}']` 已覆盖新目录，无需改。
- `scripts/check-diff-coverage.mjs:101` 的 `isSource` 已覆盖 `src/sdk`、`src/plugins`。

### 6.1 M3 新代码的覆盖缺口（必须补的用例）

| 新代码                                      | 缺口分支                                                                                                     | 归属用例                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `src/plugins/registry.ts`                   | 空注册表 / 重复 id / 重复 executorKey / 未知 key 查询 / `kind` 非法 / `capabilities` 越界 / 目录与清单不一致 | `tests/plugins/registry.test.ts`                                           |
| `src/sdk/index.ts`                          | 未声明 capability 时抛错 / 已声明时透传 / `config` 缺省 / `now` / `log` 前缀                                 | `tests/sdk/index.test.ts`                                                  |
| `src/host/sdk-host.ts`（新）                | `resolve` 失败分支 / `scanDirs` 缺 PATH 兜底 / `killTree` 返回 false                                         | `tests/host/sdk-host.test.ts`（新）                                        |
| `src/host/scheduler.ts`（改）               | `forRuntime` 抛错或空 → 兜底终态（现无分支，落在 `:453-479`）；`run.executorKey` 与运行时不一致时的处理      | `tests/host/scheduler.test.ts` 增 2-3 例                                   |
| `src/kernel/decide.ts`（改 2 行）           | `runtime.executorKey ?? protocolFamily` 两处（`:267,415`）                                                   | `tests/kernel/decide.run.test.ts`、`decide.chat.test.ts` 各加或改 1 条断言 |
| 装配（`src/main/index.ts` 改）              | 顺序变化 / registry 注入 / 缺插件时降级                                                                      | `tests/host/boot.test.ts`（`:366-379` 必改）                               |
| 插件侧适配层（若搬 `src/host/executor.ts`） | 原 12 例全部保留（这是唯一覆盖 `timeout`→`failed` 与重试一次的地方）                                         | `tests/plugins/shared/adapter.test.ts`                                     |
| `dsh` 插件包装层                            | `sdk` → `DshDeps` 的映射（`spawn`/`killTree`/`now`/`sessionRoot`）                                           | `tests/plugins/executors/dsh/plugin.test.ts`（新，2-3 例）                 |

## 7. 待拍板（3–5 条，按影响面排序）

1. **`executorKey` 放哪**：给 `Runtime` 加可选 `executorKey`（`ALTER TABLE runtimes ADD COLUMN`，`decide` 读 `executorKey ?? protocolFamily`），还是放开 `PROTOCOL_FAMILIES` 枚举（`src/protocol/entities.ts:28`、`:21` 的 DB `CHECK (protocol_family IN ('dsh'))`、`src/kernel/decide.ts:60,191-193,464-466,497-502`、`src/protocol/validate.ts:212`、`tests/protocol/entities.test.ts:336`、`RuntimeManager.tsx:330` 五处硬编码）。前者改动小、旧测试基本不动，但「新增协议」仍要能写入新值；后者符合 SPEC「四处硬编码全部消失」但会牵动 DB 重建与 protocol 测试。
2. **执行器缺失的归类**：`forRuntime` 找不到插件时用 `runtime_missing`（零协议改动，文案改成「执行器插件缺失」）还是新增 `executor_missing`（改 `RUN_ERROR_CODES`，`src/protocol/entities.ts:1-12` 附近，牵动 validate/测试）。
3. **适配层归属**：`src/host/executor.ts`（`timeout` 归一 + `resume_rejected` 重试一次，`:110-165`）搬 `src/plugins/shared/` 作纯函数复用，还是留在 host 继续由装配根注入。前者让插件直接实现 `ExecutorPort`（SPEC `:143`、`:198` 的口径）；后者能保住 `tests/host/executor.test.ts` 原位与 host 的可测性。
4. **sdk 的 fs/process 面**：detect 归插件后必须能扫目录（`host/executable.ts:33-83`）——是暴露 `sdk.process.resolve/scanDirs`（推荐，插件拿不到裸 fs），还是按 SPEC 草案给 `sdk.fs.read/write` 再让插件自己 stat（能力面更大，且 `fs.stat` 的 mode 语义跨平台易错）。
5. **M2 兼容层是否随 M3 删除**：`src/host/db.ts:106` 原文「旧库一次性升级与 v2 存量迁移是 M2 兼容层……M3 再删」。删除会连带 `host/store/import.ts`、`legacyRunsCopySql`、`RUN_M2_ADDED_COLUMNS` 与 `tests/host/store/import.test.ts`、`tests/host/schema.test.ts`、`tests/host/boot.test.ts` 的 mock，属于额外工作量，需要确认 M3 排期是否包含。

## 8. 给 M3 开工的三条硬约束

1. 必须开分支或用 `CONSTRAINTS_BASE=<起点 commit>`，否则 floor-guard / diffcov 在 master 上假绿（`tasks/plan.md:62`）；门禁脚本要在非沙箱终端跑（`:63`）。
2. 任何新 `src/**` 文件都必须被测试加载（`scripts/check-diff-coverage.mjs:130-136`），纯类型入口命名 `types.ts`。
3. 本文与 M3 计划文档都会被 floor-guard 逐行扫描（`scripts/floor-guard.mjs:62-75,91-101`，`.md` 无豁免）：不要出现抑制检查器的注释、未完成标记、测试跳过标记的字面量，否则 `pnpm check:fast` 直接红。
