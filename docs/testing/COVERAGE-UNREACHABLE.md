# 覆盖率不可达分支登记（COVERAGE-UNREACHABLE）

> 用途：登记 `pnpm test:coverage` 里**构造不出输入**的语句/分支，逐条写清"为什么到达不了"以及"覆盖它需要付出什么"，避免下次复核时重复调查，也避免有人为了让数字好看而删守卫或放宽阈值。
>
> 复核方式：`pnpm test:coverage` 后解析 `coverage/coverage-final.json`，把 `s`（语句）与 `b`（分支）里计数为 0 的项对照本表；本表之外出现未覆盖项即为**新增缺口**，要补测试或补登记。
>
> 最后复核：2026-11-09（覆盖率补口到 **100 / 100 / 100 / 100**，本表清空）。

## 判定口径

一条分支/语句登记为不可达，必须同时满足：

1. 公共 API、注入点、命令入口穷举后仍不存在能触发它的输入；
2. 触发它需要伪造「同一同步段内可变的内部状态」——即改产品代码才能构造；
3. 守卫本身是防御性的（时序双保险、类型收窄、历史数据兜底），删掉它会让某条异常路径变得不可控。

只满足"测试写起来麻烦"的，一律不算不可达。

## 当前登记（0 项）

2026-11-09 起本表**为空**：全项目覆盖率 **100 / 100 / 100 / 100**，零未覆盖语句、零未覆盖分支。

下面两节记录**不可达分支怎么变成可达**，供后续同类缺口复用；判定口径与禁止事项继续有效。

## 不可达防御分支的三种处理（2026-11-09 定）

不可达分支 ≠ 可以删。三种处理，优先级从高到低：

1. **正常业务场景能触发** → 直接补测试（首选）。例：任务经过两个都会耗尽预算的闸门阶段，
   第二个闸门耗尽时任务已带 `gate:degraded` 标签 → `withLabel` 的「已存在」臂自然被走到。
2. **守卫与别处的守卫等价（重复）** → **合并到一处**，保留可达的那一处，行为逐字等价。
   - `host/scheduler.ts`：`flushBuffered` 与 `flushFrames` 各有一道「空数组」早退 → 只留 `flushFrames` 那道
     （空数组进 `flushFrames` 直接返回，不写事实也不动 `frameSeq`，与原来在调用点早退完全一致）。
   - `host/scheduler.ts`：`settleCancelledRun` 的 `finished` 守卫与调用点（强杀回调）的
     `cancelTimers === null` 守卫**严格等价**（`clearCancelTimers` 只在 `finishOnce` 里调用，
     而 `finishOnce` 必先置 `finished`）→ 保留调用点那道，删掉重复的那一道。
   - `host/store/projection-apply.ts`：`normalizeTask` 已把 `gateFails` 归一成数字，写列处又兜一次
     `?? 0` → 写列处直接用归一后的值（返回类型收窄为 `Task & { gateFails: number }`）。
3. **守卫只可能在一处状态成立、但该状态不可构造** → **把判定抽成模块级导出函数**，
   由单测用构造输入直接覆盖；产品路径上的守卫**一字不改**（仍然在、仍然生效），只是判定本身可测了。
   抽出来的函数只吃状态、不碰 IO / 时钟 / 随机，仍满足内核纯函数铁律。

   | 抽出的判定            | 位置                                 | 覆盖方式                        |
   | --------------------- | ------------------------------------ | ------------------------------- |
   | `settleCancelledOnce` | `host/scheduler.ts`                  | 终态后不再写兜底终态            |
   | `startCancelChain`    | `host/scheduler.ts`                  | 迟到取消 / 重复取消不重启链路   |
   | `scheduleKill`        | `host/scheduler.ts`                  | 链路已收口不再排强杀等待        |
   | `degradedCommentText` | `kernel/commands/run.ts`             | 闸门配置缺省时次数按 0 算       |
   | `indexTarget`         | `kernel/commands/workflow.ts`        | 下标越界归 null                 |
   | `sameInstructions`    | `kernel/commands/workflow.ts`        | 缺省与空串视为同值              |
   | `dropToFit`           | `kernel/thread-context.ts`           | 所有段落已空但仍超上限时停下    |
   | `moveStageInList`     | `renderer/.../WorkflowEditor.tsx`    | 阶段重排的越界早退              |
   | `cardLanding`         | `renderer/.../AiWorkflowPage.tsx`    | 卡片的落点判定                  |
   | `numberFieldErrors`   | `renderer/.../PluginsManager.tsx`    | 数字字段缺省按空值处理          |
   | `withTimeout`         | `plugins/registry.ts`                | 定时器实现返回 undefined 时不崩 |
   | `jsonText`            | `plugins/executors/claude/frames.ts` | 工具入参不是 JSON 值时归空串    |
   | `providerOf`          | `plugins/executors/dsh/models.ts`    | 模型 id 不是字符串时归空串      |
   | `clearExecutorTimers` | `plugins/executors/dsh/run.ts`       | 定时器没设置时跳过清理          |

   另有三处「守卫与另一处守卫等价」按第 2 种处理：`kernel/commands/run.ts` 的交接目标缺失判断
   （收进 `handoffOnExit`，脏投影不交接）、`host/scheduler.ts` 的 `cancelAll`
   （改为直接遍历 `entries`，controller 就是 Map 里的值，「取不到」在构造上不存在）、
   `renderer/.../WorkflowEditor.tsx` 的「阶段N」兜底（`validateDraft` 先做名称必填检查，
   走到该分支时阶段名必非空 → 删掉死表达式，行为等价）。

**禁止**：为了让数字好看删掉保护性守卫，或加覆盖率抑制注释（`ignore` 类）来绕过——两者都按 `CONSTRAINTS.md` 的 Floor 处理（禁用清单已列明）。
两者都按 `CONSTRAINTS.md` 的 Floor 处理。

## 变化记录

- 2026-11-07：TDD 补口后从 90 项降到 22 项；本轮新增 47 个用例，全部为既有行为护栏（首跑即绿），除 `src/host/db.ts` 为覆盖「外键已关」分支补了 3 个 `export`（无行为变化）。
- 2026-11-08：新增 `claude`（Claude Code stream-json）与 `hermes`（ACP over stdio）两个执行器插件，登记项 22 → 23；`kernel/decide.ts` 的 4 条随 `cf26a8c` 的按命令域拆分迁到 `kernel/commands/{workflow,run}.ts`（位置更新、条数不变）。
- 2026-11-08：P1 线程上下文分段后登记项 23 → 24（`thread-context.ts` 的丢弃循环早退）。
- 2026-11-09：**覆盖率补口到 100 / 100 / 100 / 100，本表清空**。原 24 项登记逐条按上面第 2 / 3 种方式关闭（守卫语义与产品行为均未改变）；同时把 2026-11-09 新出现的缺口一并补齐：全量 52 项未覆盖语句 / 分支按判定抽成模块级导出函数 22 项、重复守卫合并 3 项、守卫构造化 2 项、删证明不可达的表达式 1 项、正常业务场景与脏投影兜底补测试 24 项处理完。全项目 164 个测试文件 / 2653 个用例全绿。
- 本表只登记，不驱动实现。删守卫来换覆盖率数字属于降低门槛，按 `CONSTRAINTS.md` 的 Floor 处理。
