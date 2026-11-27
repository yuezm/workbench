# 设置与服务信息

设置区是工作台里唯一的多栏目页面（运行时 / 智能体 / 工作流 / 规则 / 用量 / 插件 / 服务），
其中「服务」一栏把这台服务现在是什么、数据放哪、进程号多少以只读面板摊开。

## Sub-features

- `settings-enter` 侧栏底部「设置」进设置视图；顶部左侧「返回工作台」是唯一出口。
- `settings-nav` 左栏七项：运行时 / 智能体 / 工作流 / 规则 / 用量 / 插件 / 服务，当前项 `aria-current="page"`。
- `service-panel` 服务栏只读行：地址、服务版本、内核版本、数据目录、默认工作目录、启动时间、进程号。
- `service-matches` 面板读数与 `/api/info`（`state` 里的 `url`/`pid`/`dataDir`/`kernelVersion`）一致。

## How to get to it (user POV)

- 工作台左下角「设置」→ 左栏点「服务」。

## Driving it with verify

Preconditions:

- `doctor` 全 `OK`（尤其 `GET /api/info` 那条已把 pid 与 dataDir 对上）。

- **进设置。** `await page.getByRole('button', { name: '设置', exact: true }).click()`；左栏 `getByRole('navigation', { name: '设置栏目' })` 可见，`服务` 项最后。
- **打开服务栏。** `await page.getByRole('button', { name: '服务', exact: true }).click()`。
- **读数对得上。** `await page.getByText(state.dataDir, { exact: true }).waitFor()`（数据目录）；同法断言 `state.url`（地址）与 `String(state.pid)`（进程号）；`shot('settings-service')` 作为整屏证据。
- **只读。** 面板上没有任何输入框或保存按钮；改配置的文案是「设环境变量后重启」。
- **回工作台。** 点「返回工作台」→ 回到看板标题。

## Gotchas

- 设置是只读的：监听地址/端口/token/Web 产物目录都由 `WORKBENCH_*` 环境变量决定，改完要重启服务。
- 不显示「在线页面数」：快照在页面订阅 SSE 之前取，必然是 0；要看客户端数用 `/api/health`。
- 设置视图里没有项目/工作流切换器；视图切换会清空详情栈（回工作台默认落在看板）。
- 启动时间是按本机时区渲染的，别拿它和 ISO 字符串做等值断言。
