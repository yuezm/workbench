---
type: plan
status: active
---

# 任务级工作区与并行执行

> 依据：`ARCHITECTURE.md`、`SPEC-ai-workflow.md`、`CAPABILITY-MAP.md`。
> 目标：**一个任务一个工作目录（可选），多个任务并行跑，人不排队，产物靠合并收敛**。
> 起点：`pnpm check` 全绿；任务 cwd = 项目 `path`（`task-effects.ts:160`）；`claimsPerPump` 固定 1（`scheduler.ts:776`）。

## 一、问题

并发与隔离现在互相打架：

- **cwd 只有一处来源**：`cwd: project?.path ?? ownCwd ?? ''`。项目是**人选的、共享的**，于是两个任务并行就是两个 agent 在同一棵树里改文件。
- **并行窗口被连接锁死**：`claimsPerPump` 默认 1，一条运行时连接同时只跑一个 run；`agent.maxConcurrent=5` 名存实亡。
- **靠提示词让 agent 自己 `git worktree add` 不成立**：脚本阶段的 cwd 也取项目 path，闸门会在主树跑（假绿）。
- **绕开办法是「一任务一项目」**，但项目在侧栏顶层定（`SPEC-ui.md:337`），切项目换看板，人找不到自己的卡。

参照 `dsh-superagent-prototype`（一工单一目录 + prepare 命令 + slot 池）与 `agent-autoloop`（lanes + 三层上限 + 交付侧隔离），本方案把「目录」从项目下移到任务，把「并发」从连接上移到槽位池。

## 二、目标与非目标

**目标**

1. 任务级工作区：一个任务可声明自己的目录与一条准备命令
2. 并行：槽位池决定并行度，与运行时连接数解耦
3. 人不排队：人触发的轮次持特权位
4. 收敛：合并单写者，产物读 `run.deliverables` 而不是考古 `git log`
5. 兼容：老任务（无工作区）行为零变化

**非目标**

- 平台不内置 git：`prepare` 是用户配的命令，平台不认识 `worktree`
- 不做系统级沙箱：权限仍由 `permissionMode` 兜底，目录隔离不等于权限隔离
- 不改执行器协议：准备命令复用 `command` 执行器与 `ScriptTarget` 形状
- 平台不删分支、不动远端：清理只回收目录与 `git worktree` 元数据，分支留给合并流程与人判断

## 三、设计

### 3.1 数据模型

```ts
// protocol/entities.ts
export interface TaskWorkspace {
  /** 工作目录（绝对路径）；空 = 不隔离，退回项目 path */
  directory: string | null
  /** 准备命令（快照自工作流模板）；空 = 目录已存在，不需要准备 */
  prepare: string | null
  /** 生命周期：pending → preparing → ready → (merged) → reaped；失败留 failed，放弃留 abandoned */
  status: 'pending' | 'preparing' | 'ready' | 'failed' | 'merged' | 'reaped' | 'abandoned'
  branch: string | null
  preparedAt: string | null
  /** 分支合进主干的提交（合并阶段写入）；只有它能让 reaped 成立 */
  mergedAt: string | null
  reapedAt: string | null
  error: string | null
}
```

- `tasks.execution_json`（TEXT，`ALTER TABLE ADD COLUMN`，旧行 null = 无工作区）。补列走 `schema.ts` 的 `TASKS_ADDED` + `db.ts` 的既有补齐路径，不重建表。
- 变更只发 `task.updated`（整行），不新增事实类型；准备结果同一条事实带 `status / error`，事实日志天然可追溯。
- `RUN_PURPOSES` 增加 `'workspace'`（`entities.ts:745`），准备命令是一个 run，不是宿主里的旁路逻辑——内核不做 IO 的边界不动。

### 3.2 cwd 解析链

```
cwd = task.workspace?.directory ?? project?.path ?? ownCwd ?? ''
```

优先级：任务工作区 → 项目 → 目标自身配置（`agent.workdir` / `script.cwd`）。一行改写 `task-effects.ts:160`，其余调用方（chat / assess）不受影响。

### 3.3 准备流程

进入第一个 `agent` / `script` 阶段之前：

```
workspace == null            → 直接派阶段 run（现状）
directory == null            → 直接派阶段 run（项目 path）
status == ready              → 直接派阶段 run（cwd = directory）
status == pending|failed     → 先派 purpose='workspace' 的 run
```

「目录已经在了」这件事**内核判不了**（内核不读文件系统）。所以幂等只能写在命令里：`prepare` 必须是 `[ -d "${DIR}" ] || git worktree add …` 这种形状，内核只看退出码。

准备 run 的规格：

| 项   | 取值                                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------- |
| cwd  | 项目的 `path`（准备命令在其下创建目录）                                                                               |
| 命令 | `task.workspace.prepare`，按 `sh -c` / `cmd /c` 执行，复用 `ScriptTarget`（`runtimeId / args / cwd / timeoutMs`）     |
| 超时 | 10 分钟（阶段 `runTimeoutMs` 优先）                                                                                   |
| 环境 | 运行时 env + 项目级 env；**不带 agent 的 secret**                                                                     |
| 成功 | 退出码 0 → `status=ready`、写 `preparedAt`，自动派原阶段 run                                                          |
| 失败 | 非 0 → `status=failed` 并记输出尾部；任务停在原阶段，不自动重试（与 superagent 同口径：重试会把半成品目录当已准备好） |
| 幂等 | 由命令保证（`[ -d "${DIR}" ] \|\| git worktree add …`）；内核只读退出码                                               |
| 占位 | 准备 run 从开始到结束占一个槽位（慢 prepare 只拖自己）                                                                |

命令里可用变量（`${DIR}` / `${NAME}` / `${TASK}`，由宿主替换后注入）：目录、工作树名、任务 id。写成：

```sh
git worktree add "${DIR}" -b "agent/${NAME}" main
```

### 3.4 并发：槽位池

新概念 **slot**：一个执行中的 run 占一个槽。

- 全局 `limits.maxSlots`（默认 4，范围 1–16），落在内核 `Limits`
- 占槽窗口：`workspace` / `stage` / `chat` run 从被领取到终态；`waiting`（等人回答）不占槽
- **特权位**：`by='person'`（user 阶段推进、ask 回答后的续接、`task.rerun`）可用 `maxSlots + 1`，且优先于新 run 使用下一个空位。抄 `WorkerSlots.reserve()` 的同步预留（`dsh.ts:192`），避免两个领取抢最后一个位。
  - 现有 `RunRow` 没有「谁触发」这一列（`entities.ts:847`，actor 只活在事实层），所以要给 `runs` 加 `trigger: 'rule' | 'person' | 'system'`（补列，旧行按 `'rule'`），特权位才有判据
- 连接层两句都要改，只改一句等于没并行：
  1. `limits.claimsPerPump`（默认 1）把宿主 `claimsPerPump` 常量变配置
  2. **脚本 run 的窗口现在是硬编码 `< 1`**（`run.ts:91`：`runningByConnection.get(...) < 1`）。准备、清理、`check:fast` 全是脚本 run，不改这里就永远只有一条脚本在跑，准备命令会和自测抢同一个窗口
- 一次领取量：

```
本次领取 ≤ min(maxSlots − runningSlots, 连接数 × claimsPerPump)
```

于是两种部署都成立：一条连接 + `claimsPerPump=1`（今天的串行）、N 条连接或调大容量（真并行）。内核已有的线程闸门（`thread.concurrency`）保留不动。

### 3.5 工作流级默认

- `workflows` 加 `workspace_json`：`{ prepare: string }`，工作流编辑页一行「工作区准备命令」
- 任务创建时**快照**进 `task.workspace.prepare`：改工作流不影响在跑的任务（取舍同 `agent-autoloop`「领取时用最新规则、已领取保留领取时配置」）
- 新建任务弹窗：工作树名一栏（可选），留空则该任务不隔离，沿用项目 path；填了就快照工作流的准备命令

### 3.6 收敛：合并是单写者

- 任务通过闸门后 handoff 到「合并 / 提交」工作流（已有）
- 合并阶段读 `run.deliverables`（`entities.ts:913`：`branch / base / commits / files / gates`），不 `git log` 考古
- 同一仓库的合并 run 串行（线程 `concurrency=1` + 占槽），FIFO；后到者 rebase，冲突交 agent 修，修不动发 ask
- 合并阶段不自动 push（沿用现有边界）

### 3.7 UI

- 任务详情：工作区一块（目录 / 分支 / 状态 / 准备命令输出尾部）
- 看板卡片：分支名小字（有工作区时）
- 项目语义不变：并发任务不再需要「一任务一项目」，看板不用切

### 3.8 工作区生命周期：谁来删、什么时候删

**任务结束不等于可以删。** 工作台的「结束」有三种：进入内置「已完成」/「已取消」阶段（`status=completed`）、归档（`archived_at`）、被拖到「已阻塞」。三者都不代表分支已合进主干——编码完、审查打回、人还没验收时删目录就是丢现场；从没 commit 的改动更是只在那个工作树里。

所以可删条件写在**工作区状态**上，不挂在任务状态上：

| 状态        | 含义                                      | 谁写                                  |
| ----------- | ----------------------------------------- | ------------------------------------- |
| `ready`     | 目录可用，任务在做                        | 准备 run 成功                         |
| `merged`    | **合并阶段声称**已合进主干，记 `mergedAt` | 合并阶段（回执 `deliverables`，见下） |
| `abandoned` | 人明确放弃这条改动                        | 人（详情页按钮）                      |
| `reaped`    | 目录已回收、元数据已 prune                | 清理 run 成功                         |

`merged` 不能当删除凭证。`deliverables` 来自 agent 回执（`entities.ts:894`），是自报：写错、提前写、合到别的分支都可能。真正的删除权在护栏 2 —— `git branch --merged main` 由 git 判定，agent 说什么都不算数。于是「虚报 merged」的最坏后果只是多排一次清理 run，被护栏挡回来。

**触发点**：`merged` 或 `abandoned` 之后，由一条 `cleanup` 命令回收——与 `prepare` 对称，同样是 `purpose='workspace'` 的 run（用 `phase: 'prepare' | 'cleanup'` 区分），内核仍然不碰 IO。

- 时机：合并阶段收尾（该阶段最后一个 run）、或独立「清理」阶段、或完成任务时顺带排队
- 命令：`git worktree remove "${DIR}" && git worktree prune`（用户配，平台不认识 git）
- 护栏，缺一不删，落 `failed` 并发 ask：
  1. `git status --porcelain` 非空 → 有未提交改动，不删
  2. `git branch --merged main` 不含该分支，且状态不是 `abandoned` → 未合并，不删
  3. 该目录仍被别的任务的工作区引用 → 不删
- 幂等：目录不存在或已 `reaped` → 直接成功
- 失败不自动重试：与 prepare 同口径，避免把「人还想看」的现场删掉
- 任务被删除（`task.remove`）时：工作区标 `abandoned` 并排一条清理 run；内核删除前先看有没有未合并分支，有就只标 `abandoned`、留给人处理，不静默删

这样 worktree 峰值 = **同时活跃的任务数**（受 `maxSlots` 约束）+ 未合并/待验收的尾巴，尾巴靠「合并即回收」压住。

### 3.9 不想管清理：工作区池

配 `workspaceMode: 'pool'`，完全不产生清理负担：

- 全局预置 `maxSlots` 个固定目录（`slot-1..N`），首次各装一次依赖，之后复用
- 任务领取时绑定一个空闲槽：`git checkout -B agent/<name> main && git clean -fd`
- 任务进入终态（含等人回答）即归还槽；分支与 commit 留在仓库，目录回池
- 磁盘恒定：N 个目录、N 份 `node_modules`，不随任务数增长
- 代价：被打断后现场不留（未提交改动随 `git clean` 消失）；同一槽的历史互相覆盖，回看只能靠分支
- 与 `maxSlots` 天然对齐：槽位数 = 并行上限

|            | 一任务一工作区（默认）     | 工作区池                   |
| ---------- | -------------------------- | -------------------------- |
| 磁盘       | 随任务增长，靠回收压尾巴   | 恒定 N 份                  |
| 现场可恢复 | 是（等人回答期间目录保留） | 否（归还即重置）           |
| 实现       | prepare + cleanup 两条命令 | 一次预置 + 领取时 checkout |
| 适合       | FULL 需求、长链路、要回看  | FAST 小改、高频短任务      |

默认选「一任务一工作区」：它保住了「等人回答期间目录还在」这个能力，而人回答往往是几分钟到几小时。FAST 那条工作流单独配池模式。

### 3.10 子任务的工作区

spawn 出来的子任务继承父任务的 `projectId`，但**不能默认继承父任务的目录**——同一目录并发写就是回到起点。规则按「要不要写」分，判据是阶段的 `access`（`runAccessOf`），不是提示词自觉：

- 写类子任务（要 commit）：从父分支再开一棵，`git worktree add "${DIR}" -b "agent/${PARENT}/${NAME}"`，`deliverables.base = agent/<父>`
- 读类子任务（调查 / 评审 / 取证据）：共用父目录，`permissionMode` 收到 `read-only`，不占工作区、不参与清理

还有一道闸门容易被忽略：`thread.concurrency` 缺省 1（`run.ts:98`），子任务继承父任务的线程 → **同一线程的子任务本来就被串行**。想让「一个需求 spawn 3 个子任务并行」，得把那条线程的 `concurrency` 调大，否则槽位池再宽也用不上。

## 四、实施切片

每片独立可验证，完成后跑 `pnpm check`。

| 切片                    | 内容                                                                                                       | 主要文件                                                                                                                                | 验收                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **S1 数据与解析**       | `TaskWorkspace` 类型；`tasks.execution_json` 建表 + 补列 + 投影；cwd 解析链；`tasks.create` 接受可选工作区 | `protocol/entities.ts`、`host/store/{schema,db,projection-apply}.ts`、`kernel/scopes/task-effects.ts`、`kernel/scopes/commands/task.ts` | 老任务与老库零变化（空 = 走项目）；新字段写入/读出往返；cwd 链三档各一条 kernel 单测                             |
| **S2 准备 run**         | `RUN_PURPOSES` 加 `workspace`；派活前先排队；退出码定 `ready/failed`；失败停阶段不重试；幂等写在命令里     | `protocol/entities.ts`、`kernel/scopes/{task-effects,decide}.ts`、`host/scheduler.ts`                                                   | 假执行器：成功→自动进原阶段；失败→任务停在原阶段且 `status=failed`；重复准备不失败（命令幂等）；内核不 stat 目录 |
| **S3 槽位池**           | `limits.maxSlots` / `claimsPerPump`；`runs.trigger` 补列；脚本 run 窗口从硬编码 `< 1` 变可配；领取量公式   | `kernel/core/types.ts`、`kernel/scopes/run.ts`、`host/{scheduler,store}`、`bundle/base`、`protocol/entities.ts`                         | 3 槽 5 任务→2 个排队且顺序稳定；人的推进不等槽；两条脚本 run 能同时跑；`claimsPerPump=1` 时与今天逐条一致        |
| **S4 工作流默认 + UI**  | `workflows.workspace_json`；快照；弹窗一栏；详情一块                                                       | `protocol/{entities,inputs,facts}`、`kernel/scopes/commands/workflow.ts`、`host/store`、`client/app-ai-workflow`                        | 编辑保存往返；建任务快照；详情可读；老工作流（无字段）不受影响                                                   |
| **S5 合并收敛**         | 合并阶段读 deliverables；写 `mergedAt`；单写者 FIFO；冲突 ask；合并享特权位                                | 模板 `sop-templates.ts` + 客户端                                                                                                        | 两条并行分支先后合并：第二条 rebase 后通过；`gates` 空时拒放行；槽位全被长任务占满时合并仍能被领取               |
| **S6 工作区回收**       | `cleanup` 命令（`phase='cleanup'`）；三条护栏；幂等；失败发 ask；详情页「回收」按钮与 `abandoned`          | `kernel/scopes/{task-effects,decide}.ts`、`host/scheduler.ts`、`client/app-ai-workflow`                                                 | 已合并 → 目录被删且 `reaped`；未合并 → 拒删并 ask；有未提交改动 → 拒删；重复清理幂等                             |
| **S7 工作区池（可选）** | `workspaceMode='pool'` + 预置 N 槽 + 领取时 checkout + 归还                                                | `kernel/scopes/run.ts`、`host/scheduler.ts`、`client/app-ai-workflow`                                                                   | 连跑 10 个任务：目录数恒为 N；同时最多 N 个执行；归还不丢分支                                                    |
| **S8 子任务工作区**     | 写类子任务从父分支另开一棵；读类共用父目录并降 `read-only`；线程 `concurrency` 可调                        | `kernel/scopes/{task-effects,spawn}.ts`、`client/app-ai-workflow`                                                                       | 一个父任务 spawn 2 个写类子任务：两棵工作树、互不污染；读类子任务不新建目录                                      |

依赖：S1 → S2 → S3；S4 依赖 S1；S5 依赖 S2；S6 依赖 S5；S7 依赖 S3；S8 依赖 S2。

## 五、测试与门禁

- 内核纯逻辑单测：cwd 解析、准备状态机、槽位账本（`tests/kernel/*`）
- 宿主集成：假执行器跑准备命令（`tests/server/*`）
- E2E：`tests/e2e/api-only.spec.ts` 加一条「两任务并行、各自目录、互不污染」
- 覆盖率与门禁强度不动（`CONSTRAINTS.md` 的 98/93/95/98）；不为过关删断言、改预期、加抑制注释
- `pnpm check` 每片必跑；`check:packages` 校验依赖方向（新字段不引入反向依赖）

## 六、风险与取舍

| 风险               | 说明                                       | 处置                                                                           |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------ |
| 网关并发           | 历史实测：同一连接并行两个子进程会挤到 503 | `maxSlots` 从 2 起，观察到稳定再加；`claimsPerPump` 默认保持 1                 |
| 每工作区一次装依赖 | worktree 不共享 `node_modules`             | 准备命令里写 `pnpm install --frozen-lockfile`；面板提示耗时                    |
| 目录堆积           | 未合并/待验收的任务会留着工作树            | 合并即回收（S6）；不想管就配池模式（S7）；详情页显示每个工作区的状态，堆积可见 |
| 误删现场           | 回收删掉人还在看的目录                     | 三条护栏 + 失败发 ask + 不自动重试；回收前详情页确认                           |
| 权限误判           | 目录隔离被当成沙箱                         | 文档与 UI 明写：权限仍由 `permissionMode` 决定；要更强隔离用专用系统账号       |
| 迁移期混淆         | 老任务仍共享项目目录                       | 详情页把「工作区：继承项目」写出来                                             |

## 七、收益评估

| 能力               | 现在                   | 零改动（多连接 + 一任务一项目） | 本方案                                  |
| ------------------ | ---------------------- | ------------------------------- | --------------------------------------- |
| 多任务并行         | 否（一条连接一次一个） | 是（并行度 = 连接数）           | 是（`maxSlots` 配，连接数只是其中一项） |
| 目录隔离           | 否（共享项目 path）    | 是（worktree 当项目）           | 是（任务级）                            |
| 脚本阶段跑在隔离树 | —                      | 是（项目 path 就是 worktree）   | 是                                      |
| 不用切看板找卡     | —                      | 否                              | 是                                      |
| 人不等批量任务     | 否（排队在后面）       | 否                              | 是（特权位）                            |
| 工作区自动回收     | —                      | 人手动                          | 是（S6）                                |
| 子任务各写各的     | 否                     | 否（同一项目目录）              | 是（S8）                                |

**真收益三件**

1. 墙钟：N 个互不相交的改动从 sum 变 max。三个 20 分钟的任务，串行 60 分钟、三槽约 25 分钟。
2. 上下文干净：每个任务只看见自己的树，`git status` 不再混着别人的半成品。
3. 人不再被插队：人推进的轮次有特权位。

**不算收益的**：「不用切项目」是体验不是能力；「自动清理」省手工不省时间。

**成本**：S1–S3 核心可跑约 3.5–4 人日，S4–S6 再约 3 人日，S7/S8 按需；新代码要喂到 98/93/95/98 的覆盖率，实际留 7–10 人日。

**什么时候不值得做**：同时活跃任务 ≤ 2 且改动落在同一片文件时，串行更快——并行换来的是准备开销与合并冲突。并行成立的前提是任务按文件域正交。

## 八、回滚

- 新列可空，回滚只需回退代码：老库多一列上空值不影响读
- `RUN_PURPOSES` 加值后，回滚前必须确认没有 `purpose='workspace'` 的 run 在跑或排队（回滚窗口由人确认）
- 事实日志不需要重写：变更全走 `task.updated` 整行，投影可从日志重建

## 九、开放问题

1. **工作区根目录**：建议默认 `<项目 path>/../.worktrees`（与仓库同级，`git worktree` 友好），是否改成独立配置待定
2. **工作树名与分支名的生成**：由人填还是从任务标题转 kebab-case（superagent 是模型给英文短名 + 12 字符工单后缀）
3. **合并队列的归属**：合并放在「提交与推送」工作流内，还是独立一条「合并」工作流串行跑

## 附录 A：零改动版（已落地 2026-11-20）

不写代码就先拿到「并行 + 隔离」，代价是每次开工手工建工作树。

**工具**

| 命令                                      | 作用                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pwsh scripts/wt-new.ps1 -Name fix-label` | 建 `<repo 父目录>/.worktrees/fix-label`、分支 `feat/fix-label`、装依赖、打印要填的项目路径；目录已存在直接返回（幂等） |
| `pwsh scripts/wt-rm.ps1 -Name fix-label`  | 三条护栏（未提交改动 / 未合并 / 不存在）；只回收目录与 `worktree` 元数据，不删分支；`-Force` 表示明确放弃              |

两个脚本都实测过：建树、幂等重跑、脏树拒删、未合并拒删、合并后回收、重复回收成功。

**配置（已建）**

- 运行时 `DSH-2`（`executorKey=dsh`、`profile=multica`，探测 ready）
- 智能体 `Engineer-2`（绑 `DSH-2`，`maxConcurrent=1`，`danger-full-access`）
- 工作流 `FAST需求交付` 三阶段：直接改（Engineer-2）→ 自测（NPM，`run check:fast`，护栏 2 次）→ 修复（Engineer-2）；自测通过进「已完成」，未通过回「修复」，修好回「自测」

**并行怎么发生**

`FULL需求交付` 绑 `Engineer`（DSH-1）、`FAST需求交付` 绑 `Engineer-2`（DSH-2）；调度器每条连接一次领 1 个 run，于是大小需求各走一条，互不排队。

**用法**

1. `pwsh scripts/wt-new.ps1 -Name fix-label`
2. 侧栏新建项目 `wt-fix-label`，路径填脚本打印的那条
3. 切到该项目建任务，走 FAST 工作流
4. 合并后 `pwsh scripts/wt-rm.ps1 -Name fix-label`，再删工作台里的项目

**观察一周，决定要不要上 S1–S3**

- 同时有几个任务在等（>1 才值得改代码）
- 有没有两个任务撞过同一文件（撞了就说明任务没按文件域正交，并行不划算）
- 自测排队多久（脚本连接串行，`check:fast` 一次多久就堵多久）
