# Spec: shell（工作台外壳）

> Module id：`shell`。索引见 [CAPABILITY-MAP.md](../CAPABILITY-MAP.md)。确认日期：2026-10-28。

## Objective

搭建一个可长期扩展的 Web 工作台外壳（浏览器端 SPA，服务端是一个常驻 Node 进程）：顶部栏列出所有已注册的 app，内容区挂载当前选中的 app。核心价值在于 **app 注册机制**——未来新增 app 不需要改动外壳代码。shell 自己不包含任何具体 app 的业务逻辑；当前注册的唯一 app 是 `ai-workflow`（AI 自动化运行）。

**用户故事：**

- 作为使用者，我打开工作台后能在顶部栏看到所有 app 标签，点击即切换，界面保持无整页刷新。
- 作为使用者，我关掉页面后服务照常在后台跑（常驻由 systemd / pm2 / docker 负责），下次打开页面回到同一份数据与同一批视图。
- 作为开发者（我自己），我新增一个 app 时只需要：新建 app 目录、实现 `AppPlugin`、在注册表加一行。

## 界面结构（2026-11-03 调整：一层横置，app 内只留一列）

改版前：左侧 224px app 边栏 + app 内二级栏目 192px + 上下文列表 224px，横向吃掉 640px，内容区被挤窄。
现在导向：**导航层级越少越好，每层只保留一个切换点**。

- **顶部栏（shell，`components/TopBar.tsx`）**：唯一的一级导航。左侧品牌（渐变标记 + Workbench），中间 app 标签（图标 + 名称，互斥、`aria-current="page"`），右侧主题切换器（全局设置：亮色 / 暗色 / 跟随系统）+ 版本号。高度 48px，全宽。
- **app 内部（归各 app 自己）**：只允许「单列侧栏（w-64 上下）+ 内容区」两栏。侧栏放当前 app 的二级切换与上下文列表；跨 app 的切换一律回到顶部栏，**禁止**在 app 侧栏里再造 app 入口。
- **视图切换（如 ai-workflow 的工作台 / 设置）**：入口（进设置）放该 app 侧栏底部的整行按钮（图标 + 文字）；**出口（返回工作台）放设置侧栏顶部**，是带箭头与文字的整行按钮，位于二级栏目之上——出口必须在第一屏能看见，不允许只留一个角落里的图标按钮（2026-11-10 调整：左下角小图标曾被反馈「太隐蔽，等于找不到」）。不新开页头行。
- **主题切换器**是全局设置（不是某个 app 的视图），固定在顶部栏右侧，任何 app 都能切；app 侧栏里不再放第二份入口。
- app 内容区自己负责滚动（`main` 不再 `overflow-auto`），保证两栏布局能用 `min-h-0 flex-1` 吃满高度。

## Tech Stack

- Node 22 单进程服务（`node out/server/index.js`）+ Vite 构建（`vite.server.config.mts` / `vite.web.config.mts`）
- TypeScript（strict）
- React 19（函数组件 + hooks，内置状态管理，不引状态库）
- Tailwind v4 + shadcn/ui v4（上游源码在 `packages/client/ui-primitives`，项目覆盖层在 `packages/client/ui-kit`；硬规则见 [SPEC-ui](./SPEC-ui.md)）
- 测试：Vitest + @testing-library/react

## Commands

```
Dev:    pnpm dev        # vite watch 构建服务端 + node --watch + Web dev server（/api 代理到服务端）
Build:  pnpm build      # typecheck + build:server（out/server）+ build:web（out/web）
Start:  pnpm start      # node out/server/index.js（常驻交给进程管理器）
Test:   pnpm test       # vitest run
Lint:   pnpm lint
```

> 没有安装包与打包态：`pnpm build` 只产出 `out/server`（服务）与 `out/web`（静态产物），服务自己同源托管 `out/web`。

## 核心契约：AppPlugin

shell 拥有并定义"一个 app 是什么"。注册表是 app 的唯一数据源：

```ts
// renderer/shell/types.ts
import type { ComponentType } from 'react'

/** 图标组件入参 */
export interface AppIconProps {
  /** 尺寸（像素） */
  size?: number
}

export interface AppPlugin {
  /** 唯一 id，kebab-case，如 'ai-workflow' */
  id: string
  /** 顶部导航显示名 */
  name: string
  /** 顶部导航图标 */
  icon: ComponentType<AppIconProps>
  /** 内容区挂载的入口组件 */
  component: ComponentType
  /** 可发事件类型（小写点分，形如 `<appId>.<event>`）；白名单在 `@workbench/app-events` */
  events?: readonly string[]
}
```

```ts
// renderer/shell/registry.ts
import type { AppPlugin } from './types'
import { aiWorkflowApp } from '../apps/ai-workflow'

// 顺序即顶部栏显示顺序，也是默认打开的 app（外壳取 apps[0]）；当前只有一个内置 app
export const appPlugins: AppPlugin[] = [aiWorkflowApp]
```

**跨层 API（契约定义在 `packages/contract/api/src/index.ts`，浏览器侧由 `packages/client/bridge/src/index.ts` 实现成 HTTP + SSE，入口 `main.tsx` 把它挂到 `window.workbench`）：**

M5 起 renderer 只拿三个动词 + 知会 + 目录浏览（`dispatch / query / subscribe / onNotice / listDirs / info / lark / notify`，详见
[SPEC-host](./SPEC-host.md)「HTTP/SSE 契约」）：

```ts
export interface WorkbenchApi {
  dispatch<C extends Command>(command: C): Promise<CommandDispatchResult<C>>
  query<T extends ViewId>(view: T, params?: ViewParams<T>): Promise<ViewResult<T>>
  subscribe(handler: (event: WorkbenchEvent) => void): () => void
  /** 服务端 SSE 推来的知会：页面自己弹轻提示，target 有值时跳落点 */
  onNotice(handler: (notice: NoticeEvent) => void): () => void
  /** 列本机目录（项目 = 文件夹；浏览器读不到文件系统） */
  listDirs(path?: string): Promise<DirListing>
  /** 服务信息：数据目录、版本、默认工作目录、在线页面数 */
  info(): Promise<ServerInfo>
  lark<A extends LarkAdminAction>(action: A): Promise<LarkAdminResult<A>>
  /** 知会（app 通用的轻提示） */
  notify(title: string, body?: string): void
}
```

旧契约里的 `onOpenTarget` / `pickFolder` 已删除：前者由 `onNotice` + 页面内落点取代，后者由 `listDirs`（服务端列目录，页面画选择器）取代。

**内核视图（shell 持有，app 只消费）：** `shell/kernelStore.ts` 统一订阅与缓存，启动顺序
subscribe → `kernel.seq` 快照 → 回放；app 用 `useKernelView(view, params)`（或
`useKernelViewState` 取 `error`）读视图、用 `getKernelStore().dispatch(command)` 写命令。
新增 app 不得自己起 SSE 订阅、不得轮询、不得在组件里推导业务状态，也不得直接 `fetch('/api/...')` 绕过桥接。

## Code Style

- TS strict；命名：组件 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE_CASE，文件名与默认导出一致。
- 函数组件 + hooks；命名导出，不用 default export（入口文件除外）。
- 示例（TopBar 如何消费注册表）：

```tsx
export function TopBar({ apps, activeId, onSelect }: TopBarProps) {
  return (
    <header className="flex h-12 items-center gap-4 border-b border-border px-4">
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

- 框架：Vitest + @testing-library/react，测试统一放 `tests/`，与源码同构镜像（`packages/client/shell/src/registry.ts` ↔ `tests/renderer/src/shell/registry.test.ts`，文件名后缀 `*.test.ts(x)`）。
- 测什么：
  - registry：id 唯一、必填字段齐全（遍历断言）。
  - TopBar：渲染出所有注册 app；选中项 `aria-current="page"`；点击切换内容区。
  - 桥接契约（`tests/renderer/src/shared/bridge.test.ts`）：`dispatch` / `query` / `lark` / `listDirs` / `info` 的信封解包与错误文案、`subscribe` 一条 `EventSource`、`onNotice` 走同一路、`notify` 发完就忘。
- 覆盖率：无硬性数字要求；纯逻辑（契约校验）应完整覆盖。服务启动/退出等进程行为以 `tests/server/lifecycle.test.ts` 与手动验收为准。

## Boundaries

- **Always：** renderer 只能经 `window.workbench`（`packages/client/bridge/src/index.ts` 的 HTTP/SSE 实现）访问服务；新增 app 必须实现 `AppPlugin` 并通过注册表进入；提交前 `pnpm test` 与 `pnpm build` 通过。
- **Ask first：** 新增 npm 依赖；修改服务默认监听地址与端口（`WORKBENCH_HOST` / `WORKBENCH_PORT` 的缺省值）或主题基座；引入路由或状态管理库。
- **Never：** 在 renderer 里 import `apps/server` 或 Node 内置、直接 `fetch('/api/...')` 绕过桥接；把具体 app 的业务逻辑写进 shell；让 shell 依赖任何 app 的内部实现。

## Success Criteria

1. `pnpm dev` 起服务与 Web dev server 后打开页面：顶部栏按注册表顺序显示 app 标签（当前只有「AI 工作流」一项，且处于选中态、内容区挂载它），点标签即切换，无整页刷新。
2. 新增一个 app 只需三步：新建 `packages/client/app-<id>/`、实现 `AppPlugin`、注册表加一行；外壳代码（TopBar/Workbench/桥接）零改动。（验收方式：`ai-workflow` 就是按这三步接进来的，外加 registry 的类型与用例约束。）
3. `apps` 注册表被类型与测试双重约束：id 重复或字段缺失会在编译期/测试期暴露。
4. renderer 调用 `window.workbench.notify(...)` 后，页面收到服务端经 SSE 推来的 `notice` 并弹轻提示（手动验收）。
5. 关掉页面后服务进程照常在跑；重开页面回到同一份数据与同一批视图，不需要重启服务（手动验收）。
6. `pnpm build` 通过；`pnpm test` 全绿。

## Open Questions

1. 主题默认为跟随系统（亮色 / 暗色两套 token，用户可在顶部栏切换）、UI 文案为中文——按假设执行，如需改请指出。
2. `notify` 现在落成 SSE 上的 `notice`（页面自己弹轻提示，页面关着时由飞书通道喊人）；剪贴板这类桌面能力不再由服务提供，需要时按同样模式在 `WorkbenchApi` 上扩展（目录浏览已经是这样加的：`listDirs`）。
