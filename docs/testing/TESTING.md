# 测试与质量保障体系（TESTING）

> 质量门禁的单一入口文档。用例与 SPEC 规则的映射见 [TEST-CASES.md](TEST-CASES.md)。
> 包管理器统一为 **pnpm**（2026-10-30 起），全部命令用 `pnpm` 执行。

## 分层策略

```
            ┌─────────────────────────────┐
            │  E2E  Playwright + Electron  │  真实应用，关键路径冒烟（慢、少而稳）
            ├─────────────────────────────┤
            │  集成/契约                    │  main·ipc / preload·桥接 / registry·AppDefinition
            ├─────────────────────────────┤
            │  单元                         │  状态机 / audio / cn / button / hooks / 组件
            ├─────────────────────────────┤
            │  静态检查                     │  typecheck + ESLint(+react-hooks) + Prettier
            └─────────────────────────────┘
```

| 层        | 位置                        | 工具                                          | 职责                                                       |
| --------- | --------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| 静态检查  | 根配置                      | tsc（node/web 双工程）、ESLint flat、Prettier | 类型、hooks 规则、格式一致                                 |
| 单元      | 被测模块旁 `*.test.ts(x)`   | Vitest + jsdom + RTL                          | 纯逻辑与孤立组件；业务规则 100% 落在 machine.ts 并分支全测 |
| 集成/契约 | `src/main/`、`src/preload/` | Vitest（node 环境 + mock electron）           | 跨进程契约不漂移：channel、payload、暴露的 API 形状        |
| E2E       | `e2e/*.spec.ts`             | Playwright `_electron.launch`                 | 构建产物（out/）里真实 Electron 的关键路径                 |

约定：

- 契约测试**只守卫不改**：`WorkbenchApi` / `NOTIFY_CHANNEL` / `AppDefinition` 变更时，先改契约与消费方，再让测试跟随契约走。
- E2E **有意不覆盖**阶段完成/系统通知（真实等待 ≥60s 且脆），该路径由 machine/usePomodoro 单测 + 手动验收覆盖。
- renderer 单测默认 jsdom；main/preload 契约测试文件首行标 `// @vitest-environment node`。
- 覆盖率阈值门禁：statements 98 / branches 93 / functions 95 / lines 98（略低于 2026-10 基线 99.3/95.5/97.9/99.2）；`pnpm test:coverage` 跌破即失败。

## 常用命令

| 命令                                | 作用                                                               |
| ----------------------------------- | ------------------------------------------------------------------ |
| `pnpm test` / `pnpm test:watch`     | 全部单测+契约测试（2.5s）/ 监听模式                                |
| `pnpm test:coverage`                | 同上 + 覆盖率阈值门禁                                              |
| `pnpm lint` / `pnpm lint:fix`       | ESLint（含 react-hooks 规则）                                      |
| `pnpm format` / `pnpm format:check` | Prettier 全仓写 / 只检查                                           |
| `pnpm typecheck`                    | tsc node + web 双工程（含 e2e 与测试文件）                         |
| `pnpm check`                        | typecheck + lint + test:coverage（本地全量快速门禁）               |
| `pnpm e2e`                          | `build:compile`（typecheck+构建 out/）→ Playwright 跑真实 Electron |
| `pnpm e2e -- --ui`                  | Playwright UI 模式调试单条用例                                     |

E2E 说明：`electron.launch({ args: ['.'] })` 按 package.json `main` 加载 `out/main/index.js`，因此**每次先构建再测**；不需要下载任何 Playwright 浏览器（pnpm 默认也阻止了该下载）。

## Git hooks（husky，提交即门禁）

| Hook         | 内容                                                              | 拦截什么                             |
| ------------ | ----------------------------------------------------------------- | ------------------------------------ |
| `pre-commit` | lint-staged（暂存文件 eslint --fix + prettier）→ `pnpm typecheck` | 风格漂移、类型错误、hooks 违规       |
| `commit-msg` | commitlint（Conventional Commits：`feat:` / `fix:` / `test:` …）  | 不合规范的提交信息                   |
| `pre-push`   | `pnpm check && pnpm e2e`                                          | 推送前全量：类型/风格/覆盖率阈值/E2E |

- hook 文件在 `.husky/`，必须保持 **LF** 行尾（`.gitattributes` 已强制）。
- 覆盖率阈值只在实际跑覆盖率时生效（`check` / `pre-push` 会强制）。

## 何时写哪层测试

1. **新业务规则**（如新的状态转移、钳制规则）→ 先写 machine 单测（假时钟），再实现；UI 只订阅不写规则。
2. **新跨进程能力**（`WorkbenchApi` 加方法）→ 三处同步：契约 + preload 契约测试 + main ipc 契约测试，channel/payload 一处定义（`src/shared/`）。
3. **新 app** → registry 契约测试自动覆盖（遍历断言）；app 内按 1 执行；E2E 视交互复杂度补关键路径。
4. **新 UI 基元**（`components/ui/`）→ variant/size/语义类名测试，作为后续使用方的契约锚点。

## 与 SPEC 的关系

- SPEC-shell 的 Testing Strategy 写明「v1 不做 Electron E2E」；2026-10-30 按需求**升级**为引入 Playwright E2E，本文件为准。SPEC 中其余测试要求（registry 遍历断言、machine 分支全覆盖、通知走 mock）全部保持有效。
- 主进程窗口创建、系统通知横幅、铃声等真实感官行为仍以手动验收为准，清单见 [TEST-CASES.md](TEST-CASES.md)。
