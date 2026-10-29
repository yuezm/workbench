# Capability Map: Workbench（个人工作台）

> 确认日期：2026-10-28。本文件是模块索引：spec、计划、任务都以这里的 module id 为准。

## 意图来源

- Electron 桌面"工作台"外壳，自用、单用户、本地运行、无登录。
- 第一个内置 app 是番茄时钟，用于学习/工作时专注计时。
- v1 数据不落盘；明确不做：历史统计、任务关联、托盘、全局快捷键、开机自启、云同步、多语言。

## 模块

| Module id | 职责 | 依赖 | Spec |
|---|---|---|---|
| `shell` | Electron 外壳：主进程/窗口管理、侧边栏导航、app 注册与挂载机制（AppDefinition 契约）、跨进程系统能力桥接（系统通知统一 API） | — | [SPEC-shell.md](./specs/SPEC-shell.md) |
| `pomodoro` | 番茄钟 app：计时状态机、计时 UI、响铃、时长设置 | shell | [SPEC-pomodoro.md](./specs/SPEC-pomodoro.md) |

## 边界决定

1. **"一个 app 是什么"由 shell 定义**：`AppDefinition` 契约归 shell 所有，app 是契约的消费者。新增 app = 新增 app 目录 + 注册表加一行，外壳代码零改动。
2. **跨进程能力归 shell，纯 Web 能力归 app**：系统通知由 shell 提供统一 API；响铃（Web Audio）归 pomodoro。
3. **依赖方向**：`pomodoro → shell`，禁止反向；app 之间互不依赖。

## 构建顺序

`shell` → `pomodoro`
