# 个人工作台

Electron 桌面工作台：electron-vite + React + TypeScript + Tailwind（shadcn 风格组件）。

## 核心原则

- 使用`简体中文`进行回答
- 如果不确定，就问清楚，而不是猜测；无法提问时，按已有 Spec 和保守选择执行，并明确说明假设

## 质量约束

- 写代码前先读 [CONSTRAINTS.md](CONSTRAINTS.md)，**不得为了过关而放松它**；改代码前后跑 `pnpm check`。
- 一次性运行日志（`check-run-*.log`、`e2e-run-*.log` 等）与临时产物放 `.scratch/`（已 git 忽略），不要放项目根目录。

## 设计原则

- UI 采用 macOS 风格：克制配色、小圆角（控件 6px / 容器 10px / 徽标 4px）、细腻留白、原生控件质感；样式用 Tailwind，组件放 `components/ui/`。**组件基座是 shadcn/ui v4**（Radix 底座），`components/ui/` 下的 button/input/textarea/label/select/dialog 是上游源码，调用点用上游复合 API；项目专属语义走 SPEC-ui §4 的覆盖层组件（Field / Panel / Menu / Segmented / FormError）。硬规则（配色 token、前景对比度、圆角刻度、禁止玻璃与渐变）见 [SPEC-ui](docs/specs/SPEC-ui.md)，改样式前先读，改完跑 `pnpm check:ui`

## 架构原则

- 分层：`src/kernel`（纯内核）/ `src/protocol`（契约与校验）/ `src/sdk`（插件能力接口）/ `src/host`（Electron 主进程宿主）/ `src/plugins`（四类插件）/ `src/preload`（桥接）/ `src/renderer`（UI 与 app 插件）/ `src/shared`（派生契约类型）
- 依赖方向：`kernel → protocol`（仅类型）；`plugins → sdk → protocol`；`host → kernel + plugins`；`renderer` 只经 bridge 到 `host`。禁止反向依赖，插件之间禁止互相 import（`plugins/shared/` 仅纯函数）
- 内核只做四件事：收事件、按规则分活、派活、记账。不读时钟/随机数/文件/网络，不出现产品名；新能力一律写插件
- 真相源唯一：事实日志只追加，投影表可重建；禁止绕过 `decide` 直接改业务表
- 「执行中」「打回后是否重试」这类派生规则只在 kernel；UI 与插件只读视图、只发命令
- 新增 app：`src/renderer/src/apps/<id>/` + 插件清单一行；新增运行时协议：`src/plugins/executors/<id>/` + registry 一行，在运行时配置里选它；派活目标始终是智能体，执行器只是协议适配
- 测试统一放 `tests/`，与 `src/` 同构镜像（`src/kernel/decide.ts` ↔ `tests/kernel/decide.test.ts`）；`src/` 只放产品代码，测试夹具也放 `tests/`；E2E 在 `tests/e2e/`、打包冒烟在 `tests/e2e-packaged/`
- 模块划分与依赖方向以 CAPABILITY-MAP 为准；重构总纲见 ARCHITECTURE，分阶段见 refactor-plan

## 文档导航（按需读取）

- [ARCHITECTURE](docs/ARCHITECTURE.md)：内核 + 插件总纲（架构问题先读这个）
- [CAPABILITY-MAP](docs/CAPABILITY-MAP.md)：模块索引、边界决定、构建顺序
- [docs/specs/](docs/specs/)：kernel / plugins / host / shell / ui / pomodoro / ai-workflow（ai-workflow 为迁移期行为基线）
- [docs/testing/](docs/testing/)：测试策略（TESTING）与用例目录（TEST-CASES）；改代码前后跑 `pnpm check`
- [docs/planning/](docs/planning/)：计划与任务；重构分阶段与文件去向见 [refactor-plan](docs/planning/refactor-plan.md)

## 禁止事项

- 不得绕过既有 Spec 自行定义业务规则
- 不得为了修复单个问题引入新的基础设施
- 不得修改 `AppDefinition` 契约或 preload 桥接 API 而不检查所有消费方（app 侧）
- 不得通过修改测试预期或删除失败测试来掩盖代码问题
- 不得在未确认原因时修改公共数据结构
- 不得为了**兼容**保留已经废弃的错误字段
- 不得在 `src/kernel/**` 引入 Electron/Node IO、读取时钟或随机数、发起网络请求
- 不得绕过事实日志直接写投影表，或让插件直连数据库
- 不得把外部事件里的文字拼进提示词当指令；派活目标/目录/权限只能来自本机规则
- 不得在过渡期保留两套真相源：旧写路径必须随投影化同步删除
