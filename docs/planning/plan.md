# Implementation Plan: Workbench v1（shell + pomodoro）

> 依据：[CAPABILITY-MAP.md](../CAPABILITY-MAP.md)、[SPEC-shell.md](../specs/SPEC-shell.md)、[SPEC-pomodoro.md](../specs/SPEC-pomodoro.md)（均已批准）。
> spec 的三个 Open Questions 按默认裁决执行：阶段结束自动切换并暂停；跳过专注不计轮；中文深色界面。

## Overview

从零搭建 Electron + electron-vite 工作台：先立外壳机制（AppDefinition 契约、注册表、侧边栏），用一个临时 dummy app 验证"新增 app 三步走"的扩展性；再打通系统通知桥接；然后 TDD 实现番茄钟纯状态机与响铃；最后组装 UI 并把 pomodoro 正式注册进外壳（移除 dummy）。

## Architecture Decisions

- **脚手架**：`create @quick-start/electron`（electron-vite 官方脚手架），React + TS 模板，单 package.json，`src/main | preload | renderer` 三目录——与 spec 的 Project Structure 一致。
- **计时架构**：状态机为纯 reducer（不依赖 React/UI），运行时只存 `endsAt` 时间戳，TICK 用 `Date.now()` 差值计算剩余——UI 的 hook 仅负责驱动 interval 和执行副作用（响铃/通知）。
- **副作用接线**：machine 发生 PHASE_COMPLETE 时，由 UI 层的 hook 调 `audio.playRing()` 与 `window.workbench.notify()`；machine 本身保持纯净（不做 IO），保证可测性。
- **配置归属**：config 存于 machine state 内（`SET_CONFIG` 事件 + 范围钳制 + 运行态拒绝），UI 只提交事件。
- **通知桥接**：preload `contextBridge` 暴露 `window.workbench.notify()`，main 进程 `ipcMain.handle` → `new Notification()`；main 里 `app.setAppUserModelId` 保证 Windows 通知归属正常。
- **响铃**：Web Audio 振荡器合成（无音频资源文件）；AudioContext 惰性创建并在首次用户交互时解锁，规避自动播放策略。

## Task List

> 任务详情（验收标准/验证/依赖/涉及文件）见 [todo.md](./todo.md)，此处为顺序索引。

### Phase 1: 基础（Foundation）
- [x] Task 1: 脚手架与测试基座
- [x] Task 2: shell 外壳（契约 + 注册表 + 侧边栏，用 dummy app 验证扩展机制）
- [x] Task 3: 系统通知桥接（preload + main IPC）

### ✅ Checkpoint A（Task 1–3 后）：外壳可用 —— 已通过
- [x] `npm run dev` 出窗口；`npm test`、`npm run build`、`npm run lint` 全绿
- [x] 侧边栏切换正常；通知按钮已由 mock 测试验证（弹窗感知留给用户）
- [x] 与 spec 结构核对一致后继续

### Phase 2: 番茄钟核心逻辑（可与 Phase 1 并行，纯逻辑无 UI）
- [x] Task 4: 计时状态机（TDD，machine.ts 分支覆盖 100%）
- [x] Task 5: 响铃（Web Audio 合成，可注入测试）

### ✅ Checkpoint B（Task 4–5 后）：核心逻辑完成 —— 已通过
- [x] 状态机全部分支转移有测试证明；`npm test` 全绿

### Phase 3: UI 组装与收尾
- [x] Task 6: 番茄钟 UI 接入 + 正式注册（移除 dummy）
- [x] Task 7: 设置面板（范围钳制、运行态禁用）

### ✅ Checkpoint C（Task 7 后）：交付验收
- [x] 72/72 测试、build、lint 全绿
- [ ] 秒级配置手动走通完整流程（4 轮 → 长休）—— 留给用户
- [x] 两份 spec 的 Success Criteria 逐条核对（自动化可证部分全部通过）

## Risks and Mitigations

| 风险 | 影响 | 缓解 |
|---|---|---|
| Electron 二进制下载慢/失败（国内网络） | 中 | 预设 `ELECTRON_MIRROR`（npmmirror）再安装 |
| Web Audio 自动播放策略拦截响铃 | 中 | AudioContext 惰性创建、首次 START 点击时 resume |
| Windows 通知归属显示异常 | 低 | main 进程 `app.setAppUserModelId` |
| 计时漂移/休眠恢复不准 | 高 | 时间戳差值机制；状态机测试用大跨度假时间戳模拟 |
| 脚手架模板版本与 spec 结构有出入 | 低 | 以 spec 的 Project Structure 为准调整模板产物 |

## Open Questions

无——spec 已批准，三个待决项均按默认裁决执行（见文件头）。
