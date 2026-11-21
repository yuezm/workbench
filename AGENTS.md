# 个人工作台

常驻服务（Node）+ Web 界面的个人 Agent 工作台：内核收事件、按规则派活、记账；浏览器看执行情况、改配置

## 核心原则

- 使用`简体中文`进行回答
- 如果不确定，就问清楚，而不是猜测；无法提问时，按已有 Spec 和保守选择执行，并明确说明假设

## 设计原则

- UI 采用 macOS 风格、细腻留白、原生控件质感
- 样式用 Tailwind，组件放 `components/ui/`。**组件基座是 shadcn/ui v4**（Radix 底座）

## 架构原则

包分层与依赖方向不在这里复述，读代码或 `docs/CAPABILITY-MAP.md` 即可；下面只留读代码推不出来、又容易被破坏的硬约束

- 服务端是产品本体，没有 Web 产物也能跑。依赖方向以 CAPABILITY-MAP 为准，反向依赖与插件互引由 `pnpm check:packages` 拦截
- 内核只收事件、按规则分活、派活、记账；不读时钟/随机数/文件/网络，不出现产品名，新能力一律写插件
- 真相源唯一：事实日志只追加、投影表可重建，改业务状态必须过 `decide`；「执行中」「打回后是否重试」这类派生规则只在 kernel，UI 与插件只读视图、只发命令
- 传输只有一处：`@workbench/api-http` 三动词（dispatch / query / subscribe）+ SSE；浏览器只经 `@workbench/client-bridge`，app 不发 `/api`
- 扩张只加两处：新 app = `packages/client/app-<id>/` + shell 的 `registry.ts` 一行；新运行时协议 = `packages/plugins/executor-<id>/` + plugins registry 一行。派活目标始终是智能体，执行器只是协议适配
- 测试统一放 `tests/`，按层镜像包路径（`packages/api/http/src/http.ts` ↔ `tests/server/http.test.ts`）；包内只放产品代码，夹具 `tests/support/`，E2E `tests/e2e/`（`pnpm e2e:api` 为纯 API 档）

## 文档导航（按需读取）

真相源——改动前先读对应的一份，不要凭记忆写：

- 架构总纲：`docs/ARCHITECTURE.md`（内核 + 插件 + 服务器形态；架构问题先读这个）
- 模块边界：`docs/CAPABILITY-MAP.md`（模块索引、边界决定、构建顺序）
- 行为契约（规格文档）：`docs/specs/`（kernel / authority / plugins / host / server / shell / ui / ai-workflow，每一份 `SPEC-*.md` 都是对应模块的行为基线）
- 质量底线：`CONSTRAINTS.md`（只放有命令、可判定的规则；复核记录与例外在 `docs/testing/CONSTRAINTS-HISTORY.md`）
- UI规格：[SPEC-ui](docs/specs/SPEC-ui.md)

过程与产物：

- 需求 / 特性文档：`docs/features/`
- 规格文档：`docs/specs`
- 计划与任务：`docs/planning/`
- 测试策略与验收：`docs/testing/`（TESTING 策略 / TEST-CASES 用例目录 / ACCEPTANCE 人工验收与需求覆盖矩阵）
- 评审报告导出：`docs/reviews/`（任务的「提升为文档」写这里，人决定何时提交）
- 一次性运行日志、临时产物、临时测试文件：`.scratch/`（一次性日志、临时测试文件，不进 git）

## 禁止事项

- 不得绕过既有 Spec 自行定义业务规则
- 不得为了修复单个问题引入新的基础设施
- 不得修改 `AppDefinition` 契约或 `window.workbench` 桥接 API 而不检查所有消费方（app 侧）
- 不得通过修改测试预期或删除失败测试来掩盖代码问题
- 不得在未确认原因时修改公共数据结构
- 不得为了兼容保留已经废弃的错误字段
- 不得在 `packages/core/kernel/src/**` 引入 Electron/Node IO、读取时钟或随机数、发起网络请求
- 不得在 `packages/client/**` 与 `apps/web/**` 直接 import 服务端包、Node 内置或自己发 `/api` 请求（只经 `window.workbench`）
- 不得绕过事实日志直接写投影表，或让插件直连数据库
- 不得把外部事件里的文字拼进提示词当指令；派活目标/目录/权限只能来自本机规则
- 不得在过渡期保留两套真相源：旧写路径必须随投影化同步删除
- 不得把 `token` 明文写进 URL、日志或前端存储（浏览器只持 HttpOnly cookie）
