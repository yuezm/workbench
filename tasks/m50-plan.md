# Plan: thread-topics（M50）

> Spec：[SPEC-thread-topics](../docs/specs/SPEC-thread-topics.md)。按 spec 的 D1–D8 落地。
> 约束：不建 git 提交（用户未要求）；每步改完跑对应测试，收尾跑 `pnpm check`。

## 1. 组件与依赖

```
① protocol（StageHandoff.thread + validate）
        │
② kernel/归一（handoffThreadOf、sameHandoffs、两处 normalizeStage）
        │
③ kernel/派单事实（handoff.ts 选线程）────────┐
        │                                     │
④ kernel/事件复用（rules.ts 收窄）             │
        │                                     │
⑤ kernel/上下文裁剪（thread-context.ts）       │
        │                                     │
⑥ client UI（WorkflowEditor 下拉 / ThreadDetailPage 徽标·文案）
        │
⑦ e2e + 文档（SPEC 实现记录、SPEC-ai-workflow、SPEC-kernel、TEST-CASES）
```

依赖方向单向：②不改行为（只补默认值），③才是行为改变点；④⑤必须有③才有观察对象，所以 ③ 先落。

## 2. 实施顺序与理由

| 步  | 内容           | 为什么这个顺序                                                                                |
| --- | -------------- | --------------------------------------------------------------------------------------------- |
| S1  | 契约 + 归一    | 先把「策略字段怎么读」定死，后续四处消费方共用一份判据                                        |
| S2  | 派单事实选线程 | 唯一真正改变数据形状的一步；`withTask` 的 `parentInThread` 判据已能处理父子关系，不用改线程行 |
| S3  | 事件复用收窄   | 依赖 S2（同线程出现多卡后复用才会错位）                                                       |
| S4  | 上下文裁剪     | 依赖 S2（否则没有跨工作流同线程场景）                                                         |
| S5  | UI             | 依赖 S1（下拉提交形状）与 S2（徽标才有意义）                                                  |
| S6  | e2e + 文档     | 依赖全部                                                                                      |

S3 与 S4 互不依赖，可并行；其余串行。

## 3. 风险与缓解

| 风险                                  | 影响                           | 缓解                                                                                |
| ------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| 归一漏在某一处 → 增量与重建折出不同行 | 投影漂移、离线重建后配置丢失   | 两处 `normalizeStage` 同批改；补「重建与增量同形」用例                              |
| `sameHandoffs` 漏比新字段             | 编辑器改话题后保存无效（静默） | 用例断言「只改 thread 也判不等」                                                    |
| 同话题串行导致审查 run 排队           | 体感像「没起来」               | 不改闸门（`waiting` 不占位）；卡片已有「排队中」状态；写进 SPEC                     |
| 裁剪过度，审查拿不到必要上下文        | 审查质量下降                   | 只裁 `author='agent'` 笔记；任务树/产出路径/待修复清单/来源工单段保留，用例逐项断言 |
| 存量线程与新语义并存被误读            | 用户以为 bug                   | SPEC 写明存量不迁移；任务详情「子任务」区跨线程可达                                 |
| 覆盖率门槛                            | `pnpm check` 失败              | 每个新分支配用例；收尾跑 `test:coverage` + `check:diffcov`                          |

## 4. 验证检查点

- **CP1（S1 后）**：`pnpm test tests/kernel/scopes/workflow/stage-handoffs.test.ts tests/host/store` 通过；投影用例断言行内 handoff 带 `thread`。
- **CP2（S2 后）**：`tests/kernel/scopes/handoff.test.ts` 新增 inherit/new 两条主用例；`tests/kernel/scopes/threads.test.ts` 的根判定用例不变即通过（回归证明不用改线程行）。
- **CP3（S3/S4 后）**：`rules.test.ts` 与 `thread-context.test.ts` 新用例通过；`prompt.test.ts` 断言跨流程段序不变。
- **CP4（S5 后）**：`tests/renderer` 相关两文件通过；`pnpm check:ui` exit 0。
- **CP5（S6 后）**：`pnpm e2e` 的 `handoff.spec.ts` 通过；`pnpm check` exit 0。

## 5. 不做

- 不改 `pickClaims` 的线程闸门（D5），不做线程并发编辑。
- 不迁移历史事实、不提供存量合并命令（D6）。
- 不保证「一张卡跨工作流」（非目标）。
