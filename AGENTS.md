# 个人工作台

Electron 桌面工作台：electron-vite + React + TypeScript + Tailwind（shadcn 风格组件）。

## 核心原则

- 使用`简体中文`进行回答
- 如果不确定，就问清楚，而不是猜测；无法提问时，按已有 Spec 和保守选择执行，并明确说明假设

## 设计原则

- UI 采用 macOS 风格：克制配色、圆角卡片、细腻留白、原生控件质感；样式用 Tailwind，组件放 `components/ui/`

## 架构原则

- 进程与目录：`src/main`（主进程）/ `src/preload`（桥接）/ `src/renderer`（UI 与 app）/ `src/shared`（共享类型）
- 模块划分与依赖方向（app → shell，禁止反向）以 CAPABILITY-MAP 为准
- 新增 app 前先读 CAPABILITY-MAP 和对应 SPEC

## 文档导航（按需读取）

- [CAPABILITY-MAP](docs/CAPABILITY-MAP.md)：模块索引、边界决定、构建顺序
- [docs/specs/](docs/specs/)：各模块 Spec（shell、pomodoro）
- [docs/planning/](docs/planning/)：计划与任务

## 禁止事项

- 不得绕过既有 Spec 自行定义业务规则
- 不得为了修复单个问题引入新的基础设施
- 不得修改 `AppDefinition` 契约或 preload 桥接 API 而不检查所有消费方（app 侧）
- 不得通过修改测试预期或删除失败测试来掩盖代码问题
- 不得在未确认原因时修改公共数据结构
- 不得为了**兼容**保留已经废弃的错误字段
