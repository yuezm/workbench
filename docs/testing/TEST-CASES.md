# 测试用例目录（TEST-CASES）

> SPEC 业务规则 ↔ 自动化测试的映射索引。规则本体以 [SPEC-pomodoro](../specs/SPEC-pomodoro.md) / [SPEC-shell](../specs/SPEC-shell.md) / [SPEC-ai-workflow](../specs/SPEC-ai-workflow.md) 为准；改动业务规则时**先改 SPEC，再同步此表与测试**。
>
> 「测试位置」列均相对 `tests/` 根目录（测试与 `src/` 同构镜像，2026-11-04 起）。

## pomodoro（计时状态机与 UI）

| 用例       | SPEC 规则                                                   | 层级 | 测试位置                                                                                                            |
| ---------- | ----------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| TC-POM-001 | START：从就绪/暂停态开始倒计时                              | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts`                                                                  |
| TC-POM-002 | TICK：剩余时间基于时间戳差值递减（非 interval 累加）        | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts`                                                                  |
| TC-POM-003 | 大跨度假时间戳（休眠恢复）后剩余时间仍准确                  | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts`                                                                  |
| TC-POM-004 | PAUSE：冻结剩余时间                                         | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts`                                                                  |
| TC-POM-005 | PHASE_COMPLETE：切下一阶段并暂停等待确认                    | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts`                                                                  |
| TC-POM-006 | focus 自然完成才 `completedRounds += 1`                     | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts`                                                                  |
| TC-POM-007 | SKIP：不响铃、不计轮（跳过 focus 不计入完成轮数）           | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts`                                                                  |
| TC-POM-008 | RESET：全部清零回 idle                                      | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts`                                                                  |
| TC-POM-009 | 下一阶段规则：N 轮后长休 / 否则短休 / break 后回 focus      | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts`                                                                  |
| TC-POM-010 | 配置钳制：focus 1–120 / short 1–30 / long 1–60 / rounds 2–8 | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts` + `renderer/src/apps/pomodoro/components/SettingsPanel.test.tsx` |
| TC-POM-011 | 配置仅在非运行态可改（运行中面板禁用）                      | 单元 | `renderer/src/apps/pomodoro/components/SettingsPanel.test.tsx`                                                      |
| TC-POM-012 | paused 下改配置不影响冻结值，新时长作用于下一阶段           | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts`                                                                  |
| TC-POM-013 | `justCompleted` 恰好一次；SKIP/RESET 清除                   | 单元 | `renderer/src/apps/pomodoro/timer/machine.test.ts` + `renderer/src/apps/pomodoro/hooks/usePomodoro.test.tsx`        |
| TC-POM-014 | 阶段完成响铃（播放器可注入；惰性创建 AudioContext）         | 单元 | `renderer/src/apps/pomodoro/audio.test.ts` + `renderer/src/apps/pomodoro/hooks/usePomodoro.test.tsx`                |
| TC-POM-015 | 系统通知经 `window.workbench.notify`，内容含阶段与分钟数    | 单元 | `renderer/src/apps/pomodoro/hooks/usePomodoro.test.tsx`                                                             |
| TC-POM-016 | TimerDisplay：mm:ss、阶段标签、轮次圆点                     | 单元 | `renderer/src/apps/pomodoro/components/TimerDisplay.test.tsx`                                                       |
| TC-POM-017 | Controls：开始/暂停/重置/跳过触发对应事件                   | 单元 | `renderer/src/apps/pomodoro/components/Controls.test.tsx`                                                           |
| TC-POM-018 | SettingsPanel：修改配置生效、越界回弹                       | 单元 | `renderer/src/apps/pomodoro/components/SettingsPanel.test.tsx`                                                      |
| TC-POM-019 | 页面组装：hook + 三组件接线                                 | 单元 | `renderer/src/apps/pomodoro/PomodoroPage.test.tsx`                                                                  |

## shell（注册机制与跨进程契约）

| 用例       | SPEC 规则                                                                                                          | 层级 | 测试位置                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ---- | --------------------------------------------------------------------------- |
| TC-SHL-001 | registry：id 唯一、必填字段齐全、kebab-case                                                                        | 单元 | `renderer/src/shell/registry.test.ts`                                       |
| TC-SHL-002 | TopBar：渲染全部注册 app 标签、点击切换、高亮当前项（aria-current）、版本号                                        | 单元 | `renderer/src/shell/components/TopBar.test.tsx`                             |
| TC-SHL-003 | Workbench：内容区挂载当前 app                                                                                      | 单元 | `renderer/src/shell/Workbench.test.tsx`                                     |
| TC-SHL-004 | main ipc：在 `NOTIFY_CHANNEL` 注册 handler，payload 完整透传 `Notification`，body 可缺省                           | 契约 | `main/ipc.test.ts`（node 环境 + mock electron）                             |
| TC-SHL-005 | preload：以 `workbench` 名暴露的 API 形状与 `WorkbenchApi` 一致（有且仅有 notify），invoke 的 channel/payload 正确 | 契约 | `preload/index.test.ts`（node 环境 + mock electron）                        |
| TC-SHL-006 | renderer 禁止直接 import electron；`window.workbench` 全局类型与契约一致                                           | 静态 | 编译期保证（`api.d.ts` + tsc）                                              |
| TC-SHL-007 | UI 基元：Button variant/size/基座语义；cn 合并语义                                                                 | 单元 | `renderer/src/components/ui/button.test.tsx`、`renderer/src/lib/cn.test.ts` |

## ai-workflow（工作流与执行）

| 用例       | SPEC 规则                                                                                                                                                                                       | 层级 | 测试位置                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| TC-AIW-001 | 三种 `entry_mode` 的进入效果（none/agent/user）                                                                                                                                                 | 单元 | `shared/stage-machine.test.ts`                                                                                                              |
| TC-AIW-002 | 默认目标解析：完成后下一阶段/终端完成；打回上一阶段/首阶段原地                                                                                                                                  | 单元 | `shared/stage-machine.test.ts`                                                                                                              |
| TC-AIW-003 | 事件转移：RUN_SUCCEEDED / RUN_FAILED；手动 MOVE_TO / COMPLETE                                                                                                                                   | 单元 | `shared/stage-machine.test.ts`                                                                                                              |
| TC-AIW-004 | 建表 9 张（含 `run_events`）、外键开启、schema 幂等、`user_version=2`、外键违反被拒                                                                                                             | 单元 | `main/ai-workflow/db.test.ts`                                                                                                               |
| TC-AIW-005 | repository CRUD、唯一/外键/级联、被引用删除拒绝、阶段回挂；运行时 v2 字段（可空模型/推理强度、启用开关）                                                                                        | 单元 | `main/ai-workflow/repository.test.ts` + `main/ai-workflow/repository.extra.test.ts`                                                         |
| TC-AIW-006 | 阶段目标下标校验（越界/自指）、agent 阶段必须选智能体                                                                                                                                           | 单元 | `main/ai-workflow/repository.extra.test.ts` + `main/ai-workflow/ipc.test.ts`                                                                |
| TC-AIW-007 | 任务创建可指定起始阶段；拖拽落点进入阶段；拖到「已完成」；有活跃 run（queued/running）时拒绝拖动/完成                                                                                           | 契约 | `main/ai-workflow/ipc.test.ts`                                                                                                              |
| TC-AIW-008 | runner：同运行时 `maxConcurrent` 限流、多运行时并行、成功推进、失败退回、取消不推进阶段、超时、resumeQueued                                                                                     | 单元 | `main/ai-workflow/runner.test.ts`                                                                                                           |
| TC-AIW-009 | 协议后端：JSONL 帧解析（ready/session/text/thinking/tool_call/tool_result/usage/result/protocol_error）、`v`/`request_id` 校验、非 JSON 行忽略、usage 累加、终态归一（含 `run_failed`）         | 单元 | `main/ai-workflow/runtime/dsh.test.ts`                                                                                                      |
| TC-AIW-010 | `window.aiWorkflow` 契约：runtimes.*（含 probe/statuses/models）、runs.events、onChanged 与 chat.onEvent 订阅退订                                                                               | 契约 | `preload/index.test.ts`                                                                                                                     |
| TC-AIW-011 | 页面全流程与各错误分支（加载/拖拽/完成/创建/保存/运行记录）                                                                                                                                     | 单元 | `renderer/src/apps/ai-workflow/AiWorkflowPage.test.tsx`                                                                                     |
| TC-AIW-012 | 组件交互：看板拖放、卡片可拖性、起始阶段选择、编辑器与管理面板                                                                                                                                  | 单元 | `renderer/src/apps/ai-workflow/components/*.test.tsx`                                                                                       |
| TC-AIW-013 | 架构边界：renderer 禁 electron/Node、main 禁 import renderer                                                                                                                                    | 静态 | ESLint `no-restricted-imports`（见 CONSTRAINTS.md）                                                                                         |
| TC-AIW-014 | 运行时探测：`--probe` 帧 + `--version`（15s）；ready 需 `v=1`/`protocol_version=1`/`runtime=dsh`；启动失败/超时（60s）/非零退出/无帧/版本不兼容均 unavailable 并写 lastProbe；不产生 run        | 单元 | `main/ai-workflow/runtime/dsh.test.ts`                                                                                                      |
| TC-AIW-015 | 运行时页：健康 pill（可用/不可用/未检测）、CLI 版本/负载/路径、测试按钮 pending/成功/失败、行间独立                                                                                             | 单元 | `renderer/src/apps/ai-workflow/components/RuntimeManager.test.tsx` + `renderer/src/apps/ai-workflow/components/RuntimeStatusBadge.test.tsx` |
| TC-AIW-016 | 聊天持久化：会话顺序（updated_at）、消息顺序（rowid）、级联删除、智能体被对话引用拒绝、`session_id` 落库                                                                                        | 单元 | `main/ai-workflow/repository.chat.test.ts`                                                                                                  |
| TC-AIW-017 | 聊天执行：`resume_session_id` 续接（只发新消息）、`resume_rejected` 清会话后整段历史重试一次、事件→落库→end、失败/取消、并发拒绝                                                                | 单元 | `main/ai-workflow/chat.test.ts`                                                                                                             |
| TC-AIW-018 | IPC 路由：参数透传、写操作触发 changed、`create` 探测失败不落库、`update` 保存后重探、`probe` 写回 lastProbe、`detect` 只读不发 changed、`statuses` 补零、`models` 失败抛错、chat 缺失报错      | 契约 | `main/ai-workflow/ipc.test.ts`                                                                                                              |
| TC-AIW-019 | 两栏布局：默认落在聊天（侧栏切换条 + 会话清单）、切「任务」显示看板与运行记录、设置视图无工作台栏目                                                                                             | 单元 | `renderer/src/apps/ai-workflow/AiWorkflowPage.test.tsx`                                                                                     |
| TC-AIW-020 | ChatPanel：草稿输入、Enter 发送后清空 / 失败不清空、Shift+Enter 换行、发送中停止、空会话与错误提示                                                                                              | 单元 | `renderer/src/apps/ai-workflow/components/ChatPanel.test.tsx`                                                                               |
| TC-AIW-021 | WorkspaceNav：聊天/任务两项切换条、当前项标记、上下文列表槽渲染                                                                                                                                 | 单元 | `renderer/src/apps/ai-workflow/components/WorkspaceNav.test.tsx`                                                                            |
| TC-AIW-022 | ConversationList：智能体选择、新建禁用/触发、会话选中与删除回调                                                                                                                                 | 单元 | `renderer/src/apps/ai-workflow/components/ConversationList.test.tsx`                                                                        |
| TC-AIW-023 | useChat：新建/发送/`event` 流式回显/`end` 落库重载/停止/切换会话隔离/各类错误/卸载退订                                                                                                          | 单元 | `renderer/src/apps/ai-workflow/hooks/useChat.test.tsx`                                                                                      |
| TC-AIW-024 | 取消与进程树：cancel 帧 → 3s 宽限 → SIGTERM → 2s → SIGKILL；Windows `taskkill /T /F`；超时走同一终止流程并归类 `timeout`                                                                        | 单元 | `main/ai-workflow/runtime/dsh.test.ts` + `main/ai-workflow/runtime/process.test.ts`                                                         |
| TC-AIW-025 | 模型目录：`--list-models` 帧投影（id/label/provider/default/thinkingLevels/defaultThinkingLevel）；空目录/超时/启动失败抛错                                                                     | 单元 | `main/ai-workflow/runtime/dsh.test.ts` + `main/ai-workflow/ipc.test.ts`                                                                     |
| TC-AIW-026 | DB 迁移 v1→v2：v1 库重建/数据保留/幂等/版本过高拒绝/结构已是 v2 补版本号；`user_version=2`、删 kind/args_template/prompt_mode、新增 `run_events`、失败 run 归 `exit_nonzero`                    | 单元 | `main/ai-workflow/db.test.ts`（含迁移与 9 表断言）                                                                                          |
| TC-AIW-027 | 运行记录与事件流：runs 新字段（runtime_id/session_id/error_code/exit_code/duration_ms/usage_json）、`run_events` seq 唯一/按 seq 排序/`payload_json` 往返、`runs.events` 增量、output=text 汇总 | 单元 | `main/ai-workflow/repository.test.ts` + `main/ai-workflow/runner.test.ts`                                                                   |
| TC-AIW-028 | RuntimeDialog：命令/profile/权限模式/模型/推理强度/工作目录/并发/启用字段，模型下拉与手填，校验失败留在弹窗                                                                                     | 单元 | `renderer/src/apps/ai-workflow/components/RuntimeDialog.test.tsx`                                                                           |
| TC-AIW-029 | RunLog：事件流渲染（text/thinking/tool 折叠）、运行中轮询 `runs.events`、errorCode 文案、用量/退出码/耗时                                                                                       | 单元 | `renderer/src/apps/ai-workflow/components/RunLog.test.tsx`                                                                                  |
| TC-AIW-030 | AgentDialog：运行时下拉展示健康状态，不可用运行时禁用并提示                                                                                                                                     | 单元 | `renderer/src/apps/ai-workflow/components/AgentDialog.test.tsx`                                                                             |
| TC-AIW-031 | 首阶段 RUN_FAILED 打回原地：保持原阶段且 effects 为空（不重建 run、不无限重试）                                                                                                                 | 单元 | `shared/stage-machine.test.ts`                                                                                                              |
| TC-AIW-032 | 「执行中」派生：agent 阶段失败后无活跃 run，卡片可拖到其它阶段重试、也可拖到「已完成」                                                                                                          | 单元 | `renderer/src/apps/ai-workflow/components/TaskCard.test.tsx`                                                                                |
| TC-AIW-033 | 有活跃 run（queued 或 running）时 `moveToStage`/`complete` 均拒绝，报错文案可读                                                                                                                 | 单元 | `renderer/src/apps/ai-workflow/components/TaskCard.test.tsx` + `main/ai-workflow/ipc.test.ts`                                               |

## E2E（构建产物 + 真实 Electron）

| 用例       | 验证点                                                          | 测试位置               |
| ---------- | --------------------------------------------------------------- | ---------------------- |
| TC-E2E-001 | 启动冒烟：窗口标题 Workbench、顶部栏「番茄时钟」标签且高亮      | `e2e/smoke.spec.ts`    |
| TC-E2E-002 | 默认挂载第一个注册 app：idle 25:00、阶段「专注」                | `e2e/smoke.spec.ts`    |
| TC-E2E-003 | 关键路径：开始 → 递减 → 暂停冻结 → 重置回 25:00，控制区状态切换 | `e2e/pomodoro.spec.ts` |
| TC-E2E-004 | 设置端到端：非法专注时长 999 被钳制为 120，大字显示 120:00      | `e2e/pomodoro.spec.ts` |

## 手动验收清单（感官/系统行为，无法自动化）

| 用例       | 验证点                                                                                       | 来源                             |
| ---------- | -------------------------------------------------------------------------------------------- | -------------------------------- |
| TC-MAN-001 | 阶段自然结束时铃声可闻                                                                       | SPEC-pomodoro Success Criteria 4 |
| TC-MAN-002 | 系统通知在 Windows 通知中心弹出（AppUserModelId 生效，归属正确）                             | 同上                             |
| TC-MAN-003 | 窗口失焦、系统休眠恢复后倒计时仍准确                                                         | SPEC-pomodoro Success Criteria 5 |
| TC-MAN-004 | 各段时长设为秒级，手走完整 4 轮流程：正确进长休、休息后回专注                                | SPEC-pomodoro Success Criteria 2 |
| TC-MAN-005 | 打包版（`pnpm build` 产物）中通知与铃声正常                                                  | SPEC-shell Success Criteria 4    |
| TC-MAN-006 | 添加 DSH 运行时（创建前探测可用）→ 建智能体 → agent 阶段真跑（stdio 协议）并回写事件流与输出 | SPEC-ai-workflow Success 3       |
| TC-MAN-007 | 重启工作台后运行时/智能体/工作流/任务/运行记录仍在（SQLite 落盘）                            | SPEC-ai-workflow Success 1       |
| TC-MAN-008 | 看板拖拽换阶段与拖到「已完成」的手感与落点高亮（执行中卡片不可拖）                           | SPEC-ai-workflow Success 4       |
| TC-MAN-009 | 对真实 DSH 运行时点「测试」得到健康结论（CLI/协议版本、耗时）；改错命令后显示不可用与原因    | SPEC-ai-workflow Success 7       |
| TC-MAN-010 | 工作台聊天：选智能体开新对话、流式输出正常、可停止；重启后对话与消息仍在                     | SPEC-ai-workflow Success 8、9    |
| TC-MAN-011 | 同一对话连发两轮：第二轮只发新消息并续接会话；手动清空会话后仍能正常重试                     | SPEC-ai-workflow Success 9       |

## 质量门禁摘要

| 时机         | 执行                                     | 失败含义                           |
| ------------ | ---------------------------------------- | ---------------------------------- |
| `git commit` | lint-staged + typecheck + commitlint     | 风格/类型/提交信息不合规           |
| `git push`   | `pnpm check`（含覆盖率阈值）+ `pnpm e2e` | 覆盖率回退、契约破坏、关键路径回归 |
| 随时         | `pnpm test:watch`、`pnpm e2e -- --ui`    | 开发期快速反馈                     |

覆盖率阈值（2026-10-30 基线 99.3/95.5/97.9/99.2）：statements **98** / branches **93** / functions **95** / lines **98**。
