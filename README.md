# Workbench（个人工作台）

Electron 桌面「工作台」外壳 + 内置番茄时钟 app。自用、单用户、本地运行、无登录，v1 数据不落盘。

外壳（`shell`）负责窗口、侧边栏导航与 app 注册机制；`pomodoro` 是第一个按 `AppDefinition` 契约接入的 app。新增 app 只需三步：新建 app 目录、实现 `AppDefinition`、在注册表加一行，外壳代码零改动。

## 技术栈

- Electron + electron-vite，TypeScript（strict）
- React 19 + CSS Modules（不引 UI 框架）
- 测试：Vitest + @testing-library/react
- 打包：electron-builder（Windows NSIS + portable）

## 快速开始

```bash
npm install        # 依赖（Electron 二进制走 .npmrc 里的 npmmirror 镜像）
npm run dev        # 开发模式（热更新）
npm test           # 运行单元测试
npm run lint       # ESLint
npm run typecheck  # 类型检查（node + web 两套 tsconfig）
npm run build      # 类型检查 + 编译 + 打包安装程序（产物在 dist/）
```

> 国内网络：`.npmrc` 与 `electron-builder.yml` 已配置 npmmirror 镜像。

## 目录结构

```
workbench/
├── build/                 # 打包资源（图标 icon.png / icon.ico）
├── docs/                  # 文档索引与规格、计划
│   ├── CAPABILITY-MAP.md  #   模块索引（module id 以此为准）
│   ├── specs/             #   SPEC-shell.md / SPEC-pomodoro.md
│   └── planning/          #   plan.md / todo.md
├── scripts/               # 构建辅助脚本（make-icon.py）
├── src/
│   ├── main/              # Electron 主进程（窗口、生命周期、IPC）
│   ├── preload/           # contextBridge，向 renderer 暴露受控 API
│   ├── shared/            # 跨进程契约（preload 与 renderer 共用）
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx   # 渲染入口，挂载 Workbench
│           ├── shared/    # window.workbench 全局类型声明
│           ├── shell/     # 外壳：Workbench、Sidebar、registry、types
│           └── apps/
│               └── pomodoro/  # 番茄时钟 app
├── electron-builder.yml
├── electron.vite.config.ts
├── eslint.config.mjs
├── tsconfig*.json
└── vitest.config.mts
```

## 文档

- [能力地图 / 模块索引](docs/CAPABILITY-MAP.md)
- [shell 规格](docs/specs/SPEC-shell.md) · [pomodoro 规格](docs/specs/SPEC-pomodoro.md)
- [实施计划](docs/planning/plan.md) · [任务清单](docs/planning/todo.md)

## 约定与工具

- **命名**：组件 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE_CASE；组件文件名与导出组件名一致（如 `Workbench.tsx` → `Workbench`），CSS Module 用 kebab-case（`workbench.module.css`）。测试文件就近放置为 `*.test.ts(x)`。
- **代码风格**：见 `.editorconfig`（UTF-8、LF、2 空格、行尾去空白）；ESLint 配置见 `eslint.config.mjs`，`npm run lint:fix` 可自动修复。
- **忽略规则**：见 `.gitignore`（依赖、构建产物、覆盖率、日志、本地 env、编辑器/OS 文件；`build/` 图标与文档会入库）。
