# Task List: Workbench v1 — ✅ 全部完成（2026-10-28）

> 索引与架构决策见 [plan.md](./plan.md)。最终验证：72/72 测试通过，`npm run build`、`npm run lint` 全绿。

## Phase 1: 基础

## Task 1: 脚手架与测试基座 ✅

- [x] 四条命令可用：dev / build / test / lint（Electron 45 + electron-vite 6 + React 19 + TS 6 + Vitest 5）
- [x] 目录结构与 SPEC-shell.md 一致（electron-vite 约定：renderer 源码根 `src/renderer/src/`）
- [x] 冒烟测试通过（后被 shell 测试取代）
- 备注：Electron postinstall 未自动执行，手动走镜像补下二进制；`.npmrc` 已配 `electron_mirror`

## Task 2: shell 外壳——AppDefinition 契约 + 注册表 + 侧边栏 ✅

- [x] `AppDefinition` 契约与 spec 一致（id/name/icon/component，icon 带 `AppIconProps`）
- [x] Sidebar 渲染注册表全部条目，点击切换内容区，无整页刷新
- [x] registry 测试：id 唯一（kebab-case）、必填字段齐全
- [x] 深色主题 CSS 变量基座（`shell/styles/global.css`）

## Task 3: 系统通知桥接 ✅

- [x] 契约在 `src/shared/workbench-api.ts`（preload/renderer 共用），renderer 无直接 electron import
- [x] `window.workbench.notify` → IPC → main `new Notification()`，已设 `app.setAppUserModelId`
- [x] renderer 侧 mock 测试验证调用与参数
- [ ] 手动验收（用户）：点"测试通知"按钮弹系统通知——app 已被番茄钟取代删除，见交付说明

### ✅ Checkpoint A（外壳可用）——已通过

## Phase 2: 番茄钟核心逻辑

## Task 4: 计时状态机（TDD）✅

- [x] 状态机规则与 spec"事件与转移"表格逐条一致，每条有测试（34 个状态机用例）
- [x] `machine.ts` 分支覆盖率 **100%**
- [x] 大幅时间跳跃（休眠恢复）直接落到 0 并完成阶段切换

## Task 5: 响铃（Web Audio 合成）✅

- [x] `createRingPlayer` 依赖可注入，假 AudioContext 测试（惰性创建、三声上行音、复用上下文）
- [x] 无音频资源文件
- [ ] 手动验收（用户）：阶段结束听一次铃声

### ✅ Checkpoint B（核心逻辑完成）——已通过

## Phase 3: UI 组装与收尾

## Task 6: 番茄钟 UI 接入 + 正式注册 ✅

- [x] `usePomodoro` 接线层：interval 驱动 TICK、`justCompleted` → 响铃 + 通知（8 个 hook 用例，假时钟）
- [x] TimerDisplay（mm:ss + 阶段中文名 + 轮次圆点）、Controls（开始/暂停/重置/跳过）
- [x] pomodoro 以三步走注册进外壳，dummy 已删除（"新增 app 三步走"实证通过）
- [x] 状态机新增 `justCompleted` 语义（UI 区分自然完成与跳过），machine.test 同步覆盖

## Task 7: 设置面板 ✅

- [x] 四项配置可编辑，越界由状态机钳制（focusMin 1-120 / short 1-30 / long 1-60 / 轮数 2-8）
- [x] 运行中禁用；idle 修改立即生效、paused 冻结时长不变（新时长作用于下一阶段）
- [x] `<details>` 折叠，中文标签与范围提示

### ✅ Checkpoint C（交付验收）

- [x] 测试/构建/lint 全绿（72/72）
- [ ] 秒级配置手动走通完整流程 —— **留给用户**（见交付说明）
- [x] 两份 spec 的 Success Criteria 已逐条对照（自动化可证部分全部通过；3 项需人工感知，见交付说明）
