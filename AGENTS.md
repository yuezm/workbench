# 个人工作台

常驻服务（Node）+ Web 界面的个人 Agent 工作台：内核收事件、按规则派活、记账；浏览器看执行情况、改配置。

## 核心原则

- 使用`简体中文`进行回答
- 如果不确定，就问清楚，而不是猜测；无法提问时，按已有 Spec 和保守选择执行，并明确说明假设

## 质量约束

- 写代码前先读 [CONSTRAINTS.md](CONSTRAINTS.md)，**不得为了过关而放松它**；改代码前后跑 `pnpm check`
- 一次性运行日志、临时产物、临时测试文件放 `.scratch/`

## 设计原则

- UI 采用 macOS 风格：克制配色、小圆角（控件 6px / 容器 10px / 徽标 4px）、细腻留白、原生控件质感；样式用 Tailwind，组件放 `components/ui/`。**组件基座是 shadcn/ui v4**（Radix 底座），`components/ui/` 下的 button/input/textarea/label/select/dialog 是上游源码，调用点用上游复合 API；项目专属语义走 SPEC-ui §4 的覆盖层组件（Field / Panel / Menu / Segmented / FormError）。硬规则（配色 token、前景对比度、圆角刻度、禁止玻璃与渐变）见 [SPEC-ui](docs/specs/SPEC-ui.md)，改样式前先读，改完跑 `pnpm check:ui`

## 架构原则

- 分层（包）：`apps/server`（产品入口：装配、配置、生命周期）/ `apps/web`（vite 壳，产 `out/web`）+ `packages/core/{protocol,kernel}` / `packages/sdk/capabilities`（插件能力面）/ `packages/contract/{api,app-events}`（跨端契约）/ `packages/host/{host,store,frontend-static}`（宿主与唯一写库点）/ `packages/api/http`（HTTP/SSE/鉴权）/ `packages/plugins/*`（四类插件，一包一个）/ `packages/bundle/{base,web}`（服务端装配，Web 可选）/ `packages/client/*`（浏览器端 UI 与 app 插件）。服务端是产品本体，没有 Web 产物也能跑
- 依赖方向：`kernel → protocol`（仅类型）；`plugins → capabilities → protocol`；`host → kernel + plugins(仅 registry)`；`api-http → host`；`apps/server → bundle-* + api-http`；`client → protocol/contract` + 自己的桥接。禁止反向依赖，插件之间禁止互相 import（`plugins-kit` 仅纯函数）；`scripts/check-packages.mjs` + `pnpm check:packages` 机器校验，越界即 `pnpm check` 失败
- 内核只做四件事：收事件、按规则分活、派活、记账。不读时钟/随机数/文件/网络，不出现产品名；新能力一律写插件
- 真相源唯一：事实日志只追加，投影表可重建；禁止绕过 `decide` 直接改业务表
- 「执行中」「打回后是否重试」这类派生规则只在 kernel；UI 与插件只读视图、只发命令
- 传输只有一处：`@workbench/api-http` 的三动词（dispatch / query / subscribe）+ SSE；浏览器侧只有 `@workbench/client-bridge` 一个桥接实现，app 不得自己发 `/api` 请求
- 新增 app：`packages/client/app-<id>/` + `packages/client/shell/src/registry.ts` 一行；新增运行时协议：`packages/plugins/executor-<id>/` + `packages/plugins/registry/src/index.ts` 一行，在运行时配置里选它；派活目标始终是智能体，执行器只是协议适配
- 测试统一放 `tests/`，按层镜像（`packages/api/http/src/http.ts` ↔ `tests/server/http.test.ts`，`packages/core/kernel/src/x.ts` ↔ `tests/kernel/x.test.ts`）；包内只放产品代码，夹具放 `tests/support/`；E2E 在 `tests/e2e/`（独立服务进程 + 临时数据目录 + Chromium），纯 API 档是 `tests/e2e/api-only.spec.ts`（`pnpm e2e:api`，无浏览器）
- 模块划分与依赖方向以 CAPABILITY-MAP 为准；重构总纲见 ARCHITECTURE，分阶段见 refactor-plan；服务器形态见 [SPEC-server](docs/specs/SPEC-server.md)

## 文档导航（按需读取）

- [ARCHITECTURE](docs/ARCHITECTURE.md)：内核 + 插件 + 服务器形态总纲（架构问题先读这个）
- [CAPABILITY-MAP](docs/CAPABILITY-MAP.md)：模块索引、边界决定、构建顺序
- [docs/specs/](docs/specs/)：kernel / authority（准入·授权·研判·注意力）/ plugins / host / server / shell / ui / ai-workflow（ai-workflow 为迁移期行为基线）
- [docs/testing/](docs/testing/)：测试策略（TESTING）、用例目录（TEST-CASES）、人工验收自查（ACCEPTANCE，含需求覆盖矩阵与走查表）；改代码前后跑 `pnpm check`
- [docs/planning/](docs/planning/)：计划与任务；Electron → 服务端的迁移记录见 [rewrite-server-deployment](docs/planning/rewrite-server-deployment.md)，重构分阶段见 [refactor-plan](docs/planning/refactor-plan.md)，包拆分（`apps/*` + `packages/<域>/<包>`）见 [package-split-plan](docs/planning/package-split-plan.md)

## 禁止事项

- 不得绕过既有 Spec 自行定义业务规则
- 不得为了修复单个问题引入新的基础设施
- 不得修改 `AppDefinition` 契约或 `window.workbench` 桥接 API 而不检查所有消费方（app 侧）
- 不得通过修改测试预期或删除失败测试来掩盖代码问题
- 不得在未确认原因时修改公共数据结构
- 不得为了**兼容**保留已经废弃的错误字段
- 不得在 `packages/core/kernel/src/**` 引入 Electron/Node IO、读取时钟或随机数、发起网络请求
- 不得在 `packages/client/**` 与 `apps/web/**` 直接 import 服务端包、Node 内置或自己发 `/api` 请求（只经 `window.workbench`）
- 不得绕过事实日志直接写投影表，或让插件直连数据库
- 不得把外部事件里的文字拼进提示词当指令；派活目标/目录/权限只能来自本机规则
- 不得在过渡期保留两套真相源：旧写路径必须随投影化同步删除
- 不得把 `token` 明文写进 URL、日志或前端存储（浏览器只持 HttpOnly cookie）
