# 测试用例目录（TEST-CASES）

> SPEC 业务规则 ↔ 自动化测试的映射索引。规则本体以 [SPEC-pomodoro](../specs/SPEC-pomodoro.md) / [SPEC-shell](../specs/SPEC-shell.md) / [SPEC-ai-workflow](../specs/SPEC-ai-workflow.md) 为准；改动业务规则时**先改 SPEC，再同步此表与测试**。

## pomodoro（计时状态机与 UI）

| 用例       | SPEC 规则                                                   | 层级 | 测试位置                                               |
| ---------- | ----------------------------------------------------------- | ---- | ------------------------------------------------------ |
| TC-POM-001 | START：从就绪/暂停态开始倒计时                              | 单元 | `timer/machine.test.ts`                                |
| TC-POM-002 | TICK：剩余时间基于时间戳差值递减（非 interval 累加）        | 单元 | `timer/machine.test.ts`                                |
| TC-POM-003 | 大跨度假时间戳（休眠恢复）后剩余时间仍准确                  | 单元 | `timer/machine.test.ts`                                |
| TC-POM-004 | PAUSE：冻结剩余时间                                         | 单元 | `timer/machine.test.ts`                                |
| TC-POM-005 | PHASE_COMPLETE：切下一阶段并暂停等待确认                    | 单元 | `timer/machine.test.ts`                                |
| TC-POM-006 | focus 自然完成才 `completedRounds += 1`                     | 单元 | `timer/machine.test.ts`                                |
| TC-POM-007 | SKIP：不响铃、不计轮（跳过 focus 不计入完成轮数）           | 单元 | `timer/machine.test.ts`                                |
| TC-POM-008 | RESET：全部清零回 idle                                      | 单元 | `timer/machine.test.ts`                                |
| TC-POM-009 | 下一阶段规则：N 轮后长休 / 否则短休 / break 后回 focus      | 单元 | `timer/machine.test.ts`                                |
| TC-POM-010 | 配置钳制：focus 1–120 / short 1–30 / long 1–60 / rounds 2–8 | 单元 | `timer/machine.test.ts` + `SettingsPanel.test.tsx`     |
| TC-POM-011 | 配置仅在非运行态可改（运行中面板禁用）                      | 单元 | `components/SettingsPanel.test.tsx`                    |
| TC-POM-012 | paused 下改配置不影响冻结值，新时长作用于下一阶段           | 单元 | `timer/machine.test.ts`                                |
| TC-POM-013 | `justCompleted` 恰好一次；SKIP/RESET 清除                   | 单元 | `timer/machine.test.ts` + `hooks/usePomodoro.test.tsx` |
| TC-POM-014 | 阶段完成响铃（播放器可注入；惰性创建 AudioContext）         | 单元 | `audio.test.ts` + `hooks/usePomodoro.test.tsx`         |
| TC-POM-015 | 系统通知经 `window.workbench.notify`，内容含阶段与分钟数    | 单元 | `hooks/usePomodoro.test.tsx`                           |
| TC-POM-016 | TimerDisplay：mm:ss、阶段标签、轮次圆点                     | 单元 | `components/TimerDisplay.test.tsx`                     |
| TC-POM-017 | Controls：开始/暂停/重置/跳过触发对应事件                   | 单元 | `components/Controls.test.tsx`                         |
| TC-POM-018 | SettingsPanel：修改配置生效、越界回弹                       | 单元 | `components/SettingsPanel.test.tsx`                    |
| TC-POM-019 | 页面组装：hook + 三组件接线                                 | 单元 | `PomodoroPage.test.tsx`                                |

## shell（注册机制与跨进程契约）

| 用例       | SPEC 规则                                                                                                          | 层级 | 测试位置                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------- |
| TC-SHL-001 | registry：id 唯一、必填字段齐全、kebab-case                                                                        | 单元 | `shell/registry.test.ts`                                 |
| TC-SHL-002 | Sidebar：渲染全部注册 app、点击切换、高亮当前项                                                                    | 单元 | `shell/components/Sidebar.test.tsx`                      |
| TC-SHL-003 | Workbench：内容区挂载当前 app                                                                                      | 单元 | `shell/Workbench.test.tsx`                               |
| TC-SHL-004 | main ipc：在 `NOTIFY_CHANNEL` 注册 handler，payload 完整透传 `Notification`，body 可缺省                           | 契约 | `src/main/ipc.test.ts`（node 环境 + mock electron）      |
| TC-SHL-005 | preload：以 `workbench` 名暴露的 API 形状与 `WorkbenchApi` 一致（有且仅有 notify），invoke 的 channel/payload 正确 | 契约 | `src/preload/index.test.ts`（node 环境 + mock electron） |
| TC-SHL-006 | renderer 禁止直接 import electron；`window.workbench` 全局类型与契约一致                                           | 静态 | 编译期保证（`api.d.ts` + tsc）                           |
| TC-SHL-007 | UI 基元：Button variant/size/基座语义；cn 合并语义                                                                 | 单元 | `components/ui/button.test.tsx`、`lib/cn.test.ts`        |

## ai-workflow（工作流与执行）

| 用例       | SPEC 规则                                                                     | 层级 | 测试位置                                            |
| ---------- | ----------------------------------------------------------------------------- | ---- | --------------------------------------------------- |
| TC-AIW-001 | 三种 `entry_mode` 的进入效果（none/agent/user）                               | 单元 | `src/shared/stage-machine.test.ts`                  |
| TC-AIW-002 | 默认目标解析：完成后下一阶段/终端完成；打回上一阶段/首阶段原地                | 单元 | `src/shared/stage-machine.test.ts`                  |
| TC-AIW-003 | 事件转移：RUN_SUCCEEDED / RUN_FAILED；手动 MOVE_TO / COMPLETE                 | 单元 | `src/shared/stage-machine.test.ts`                  |
| TC-AIW-004 | 建表 6 张、外键开启、schema 幂等、外键违反被拒                                | 单元 | `src/main/ai-workflow/db.test.ts`                   |
| TC-AIW-005 | repository CRUD、唯一/外键/级联、被引用删除拒绝、阶段回挂                     | 单元 | `repository.test.ts` + `repository.extra.test.ts`   |
| TC-AIW-006 | 阶段目标下标校验（越界/自指）、agent 阶段必须选智能体                         | 单元 | `repository.extra.test.ts` + `ipc.test.ts`          |
| TC-AIW-007 | 任务创建可指定起始阶段；拖拽落点进入阶段；拖到「已完成」；执行中拒绝拖动/完成 | 契约 | `src/main/ai-workflow/ipc.test.ts`                  |
| TC-AIW-008 | runner：单并发串行、成功推进、失败退回、取消、resumeQueued                    | 单元 | `runner.test.ts`                                    |
| TC-AIW-009 | DSH adapter：参数模板/`{prompt}`/stdin、输出捕获、退出码                      | 单元 | `runtime/deepseek-harness.test.ts`（真实 spawn）    |
| TC-AIW-010 | `window.aiWorkflow` 契约：方法转发、onChanged 订阅/退订                       | 契约 | `src/preload/index.test.ts`                         |
| TC-AIW-011 | 页面全流程与各错误分支（加载/拖拽/完成/创建/保存/运行记录）                   | 单元 | `AiWorkflowPage.test.tsx`                           |
| TC-AIW-012 | 组件交互：看板拖放、卡片可拖性、起始阶段选择、编辑器与管理面板                | 单元 | `components/*.test.tsx`                             |
| TC-AIW-013 | 架构边界：renderer 禁 electron/Node、main 禁 import renderer                  | 静态 | ESLint `no-restricted-imports`（见 CONSTRAINTS.md） |

## E2E（构建产物 + 真实 Electron）

| 用例       | 验证点                                                          | 测试位置               |
| ---------- | --------------------------------------------------------------- | ---------------------- |
| TC-E2E-001 | 启动冒烟：窗口标题 Workbench、侧边栏「番茄时钟」且高亮          | `e2e/smoke.spec.ts`    |
| TC-E2E-002 | 默认挂载第一个注册 app：idle 25:00、阶段「专注」                | `e2e/smoke.spec.ts`    |
| TC-E2E-003 | 关键路径：开始 → 递减 → 暂停冻结 → 重置回 25:00，控制区状态切换 | `e2e/pomodoro.spec.ts` |
| TC-E2E-004 | 设置端到端：非法专注时长 999 被钳制为 120，大字显示 120:00      | `e2e/pomodoro.spec.ts` |

## 手动验收清单（感官/系统行为，无法自动化）

| 用例       | 验证点                                                             | 来源                             |
| ---------- | ------------------------------------------------------------------ | -------------------------------- |
| TC-MAN-001 | 阶段自然结束时铃声可闻                                             | SPEC-pomodoro Success Criteria 4 |
| TC-MAN-002 | 系统通知在 Windows 通知中心弹出（AppUserModelId 生效，归属正确）   | 同上                             |
| TC-MAN-003 | 窗口失焦、系统休眠恢复后倒计时仍准确                               | SPEC-pomodoro Success Criteria 5 |
| TC-MAN-004 | 各段时长设为秒级，手走完整 4 轮流程：正确进长休、休息后回专注      | SPEC-pomodoro Success Criteria 2 |
| TC-MAN-005 | 打包版（`pnpm build` 产物）中通知与铃声正常                        | SPEC-shell Success Criteria 4    |
| TC-MAN-006 | 添加 DeepSeek Harness 运行时，agent 阶段真跑并回写输出             | SPEC-ai-workflow Success 3       |
| TC-MAN-007 | 重启工作台后运行时/智能体/工作流/任务/运行记录仍在（SQLite 落盘）  | SPEC-ai-workflow Success 1       |
| TC-MAN-008 | 看板拖拽换阶段与拖到「已完成」的手感与落点高亮（执行中卡片不可拖） | SPEC-ai-workflow Success 4       |

## 质量门禁摘要

| 时机         | 执行                                     | 失败含义                           |
| ------------ | ---------------------------------------- | ---------------------------------- |
| `git commit` | lint-staged + typecheck + commitlint     | 风格/类型/提交信息不合规           |
| `git push`   | `pnpm check`（含覆盖率阈值）+ `pnpm e2e` | 覆盖率回退、契约破坏、关键路径回归 |
| 随时         | `pnpm test:watch`、`pnpm e2e -- --ui`    | 开发期快速反馈                     |

覆盖率阈值（2026-10-30 基线 99.3/95.5/97.9/99.2）：statements **98** / branches **93** / functions **95** / lines **98**。
