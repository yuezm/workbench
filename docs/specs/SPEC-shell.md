# Spec: shell（工作台外壳）

> Module id：`shell`。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。确认日期：2026-10-28。

## Objective

搭建一个可长期扩展的 Electron 桌面工作台外壳：顶部栏列出所有已注册的 app，内容区挂载当前选中的 app。核心价值在于 **app 注册机制**——未来新增 app 不需要改动外壳代码。shell 自己不包含任何具体 app 的业务逻辑；第一个消费者 `pomodoro` 用于验证这套机制。

**用户故事：**

- 作为使用者，我打开工作台后能在顶部栏看到所有 app 标签，点击即切换，界面保持无整页刷新。
- 作为使用者，我点击窗口关闭按钮（X）时窗口隐藏到系统托盘，程序继续在后台运行；从托盘菜单可重新显示窗口或真正退出。
- 作为开发者（我自己），我新增一个 app 时只需要：新建 app 目录、实现 `AppDefinition`、在注册表加一行。

## 界面结构（2026-11-03 调整：一层横置，app 内只留一列）

改版前：左侧 224px app 边栏 + app 内二级栏目 192px + 上下文列表 224px，横向吃掉 640px，内容区被挤窄。
现在导向：**导航层级越少越好，每层只保留一个切换点**。

- **顶部栏（shell，`components/TopBar.tsx`）**：唯一的一级导航。左侧品牌（渐变标记 + Workbench），中间 app 标签（图标 + 名称，互斥、`aria-current="page"`），右侧版本号。高度 48px，全宽。
- **app 内部（归各 app 自己）**：只允许「单列侧栏（w-64 上下）+ 内容区」两栏。侧栏放当前 app 的二级切换与上下文列表；跨 app 的切换一律回到顶部栏，**禁止**在 app 侧栏里再造 app 入口。
- **视图切换（如 ai-workflow 的工作台 / 设置）**：放在该 app 侧栏底部，不新开页头行。
- app 内容区自己负责滚动（`main` 不再 `overflow-auto`），保证两栏布局能用 `min-h-0 flex-1` 吃满高度。

## Tech Stack

- Electron + electron-vite 脚手架（版本以脚手架安装时的最新稳定版为准）
- TypeScript（strict）
- React 18+（函数组件 + hooks，内置状态管理，不引状态库）
- CSS Modules（不引 UI 框架）
- 测试：Vitest + @testing-library/react

## Commands

```
Dev:    npm run dev      # 启动开发模式（含热更新）
Build:  npm run build    # 类型检查 + 编译 + 打包桌面安装程序（产物在 dist/）
Dist:   npm run dist     # 只重新打包（复用 out/，不重新编译）
Test:   npm test         # vitest run
Lint:   npm run lint
```

> 打包由 electron-builder 完成（配置见 `electron-builder.yml`）。Windows 产出 `dist/workbench-<version>-setup.exe`（NSIS 安装包）与 `dist/workbench-<version>-portable.exe`（免安装单文件）。

## Project Structure

> 实际落地遵循 electron-vite 约定：renderer 源码根为 `src/renderer/src/`（与最初草案的 `src/renderer/*` 对应，多一层 `src/`）。

```
workbench/
├── src/
│   ├── main/               # 【shell】Electron 主进程
│   │   ├── index.ts        #   窗口创建、生命周期（关闭即隐藏到托盘）、AppUserModelId
│   │   ├── tray.ts         #   系统托盘：图标、菜单（显示/退出）
│   │   └── ipc.ts          #   IPC handlers（notify）
│   ├── preload/            # 【shell】contextBridge，向 renderer 暴露受控 API
│   │   └── index.ts
│   ├── shared/             # 跨进程契约（preload 与 renderer 共用）
│   │   └── workbench-api.ts
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx        # 渲染入口：挂载 Workbench
│           ├── shared/
│           │   └── api.d.ts    # window.workbench 全局类型声明
│           ├── shell/          # 【shell】渲染侧外壳
│           │   ├── Workbench.tsx #   Workbench：布局 + 当前 app 状态
│           │   ├── types.ts    #   AppDefinition 契约
│           │   ├── registry.ts #   app 注册表（唯一的数据源）
│           │   ├── components/ #   TopBar（顶部 app 标签栏）
│           │   └── styles/     #   全局深色主题变量（global.css）
│           └── apps/
│               └── pomodoro/   # 【pomodoro】见 SPEC-pomodoro.md
├── resources/             # 打包资源（icon.png / icon.ico）
├── docs/                  # CAPABILITY-MAP.md / specs/ / planning/
├── scripts/               # 构建辅助脚本（make-icon.mjs）
└── package.json
```

## 核心契约：AppDefinition

shell 拥有并定义"一个 app 是什么"。注册表是 app 的唯一数据源：

```ts
// renderer/shell/types.ts
import type { ComponentType } from 'react'

/** 图标组件入参 */
export interface AppIconProps {
  /** 尺寸（像素） */
  size?: number
}

export interface AppDefinition {
  /** 唯一 id，kebab-case，如 'pomodoro' */
  id: string
  /** 顶部导航显示名 */
  name: string
  /** 顶部导航图标 */
  icon: ComponentType<AppIconProps>
  /** 内容区挂载的入口组件 */
  component: ComponentType
}
```

```ts
// renderer/shell/registry.ts
import type { AppDefinition } from './types'
import { pomodoroApp } from '../apps/pomodoro'

export const apps: AppDefinition[] = [pomodoroApp]
```

**跨进程 API（preload 暴露，契约定义在 `src/shared/workbench-api.ts`）：**

```ts
// renderer 通过 window.workbench 调用，禁止直接 import electron
export interface WorkbenchApi {
  /** 发送一条系统通知 */
  notify(title: string, body?: string): void
}
export const NOTIFY_CHANNEL = 'workbench:notify'
```

## Code Style

- TS strict；命名：组件 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE_CASE，文件名与默认导出一致。
- 函数组件 + hooks；命名导出，不用 default export（入口文件除外）。
- 示例（TopBar 如何消费注册表）：

```tsx
export function TopBar({ apps, activeId, onSelect }: TopBarProps) {
  return (
    <header className="flex h-12 items-center gap-4 border-b border-line px-4">
      <span>Workbench</span>
      <nav aria-label="应用导航" className="flex items-center gap-1">
        {apps.map((app) => (
          <button
            key={app.id}
            aria-current={app.id === activeId ? 'page' : undefined}
            onClick={() => onSelect(app.id)}
          >
            <app.icon size={15} /> {app.name}
          </button>
        ))}
      </nav>
    </header>
  )
}
```

## Testing Strategy

- 框架：Vitest + @testing-library/react，测试统一放 `tests/`，与 `src/` 同构镜像（`src/shell/registry.ts` ↔ `tests/renderer/src/shell/registry.test.ts`，文件名后缀 `*.test.ts(x)`）。
- 测什么：
  - registry：id 唯一、必填字段齐全（遍历断言）。
  - TopBar：渲染出所有注册 app；选中项 `aria-current="page"`；点击切换内容区。
  - preload/ipc 契约：`window.workbench.notify` 存在（类型层保证 + 渲染侧 mock 测试）。
- 覆盖率：无硬性数字要求；纯逻辑（契约校验）应完整覆盖。Electron 窗口创建等主进程行为以手动验收为准（v1 不做 Electron E2E）。

## Boundaries

- **Always：** renderer 访问 Electron 能力必须经 preload 暴露的 `window.workbench` API；新增 app 必须实现 `AppDefinition` 并通过注册表进入；提交前 `npm test` 与 `npm run build` 通过。
- **Ask first：** 新增 npm 依赖；修改窗口默认尺寸/主题基座；引入路由或状态管理库。
- **Never：** 在 renderer 进程直接 `require('electron')` 或访问 Node API；把具体 app 的业务逻辑写进 shell；让 shell 依赖任何 app 的内部实现。

## Success Criteria

1. `npm run dev` 启动后出现桌面窗口：顶部栏显示"番茄时钟"标签且处于选中态，内容区挂载番茄钟界面；点另一个 app 标签即切换，无整页刷新。
2. 新增一个 app 只需三步：新建 `src/renderer/apps/<id>/`、实现 `AppDefinition`、注册表加一行；外壳代码（TopBar/Workbench/主进程）零改动。（验收方式：以 pomodoro 的接入过程为证 + registry 类型约束。）
3. `apps` 注册表被类型与测试双重约束：id 重复或字段缺失会在编译期/测试期暴露。
4. renderer 调用 `window.workbench.notify(...)` 能弹出系统通知（手动验收）。
5. 点击窗口 X 后窗口隐藏、程序驻留系统托盘；托盘单击/菜单"显示工作台"可恢复窗口，菜单"退出"才真正退出进程（手动验收）。
6. `npm run build` 通过；`npm test` 全绿。

## Open Questions

1. 主题默认为深色、UI 文案为中文——按假设执行，如需改请指出。
2. `notify` 目前只覆盖系统通知；后续如有剪贴板、文件对话框等需求，按同样模式在 `WorkbenchApi` 上扩展。
