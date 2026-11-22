# Workbench（个人工作台）

常驻服务形态的个人 Agent 工作台：一个 Node 进程收事件、按规则派活、记账，Web 界面用来观察执行情况和改配置。

- **服务**：`node out/server/index.js`，同源托管 Web 产物并提供 HTTP 三动词 + SSE 推送。
- **界面**：浏览器打开 `http://127.0.0.1:3000`（默认只监听回环）。看板、任务详情、聊天、设置、插件、运行时、规则都在这里。
- **执行**：内核只决定「派给谁」，具体跑什么由执行器插件（dsh 等本机 CLI）负责；进程与目录都由服务端管理。
- **数据**：默认 `~/.workbench`（库、产物、插件、密钥、会话），可用 `WORKBENCH_DATA_DIR` 改。

## 快速开始

要求 Node ≥ 22.13（`node:sqlite`）。

```bash
pnpm install
pnpm build        # 服务端产物 out/server + Web 产物 out/web（不含类型检查）
pnpm start        # 前台运行，日志里会打印 workbench listening on http://127.0.0.1:3000
```

开发态（服务端 watch 构建 + `node --watch` + Web HMR，`/api` 代理到服务端）：

```bash
pnpm dev          # 数据目录默认 .scratch/dev-data，不碰 ~/.workbench
```

## 配置

全部走环境变量（systemd / docker / pm2 都是同一套写法）：

| 变量                     | 默认           | 说明                                           |
| ------------------------ | -------------- | ---------------------------------------------- |
| `WORKBENCH_HOST`         | `127.0.0.1`    | 监听地址。**非回环必须配 token，否则启动失败** |
| `WORKBENCH_PORT`         | `3000`         | 端口；`0` 表示由系统分配（日志会打印实际地址） |
| `WORKBENCH_DATA_DIR`     | `~/.workbench` | 库、产物、插件、密钥、会话                     |
| `WORKBENCH_WEB_DIR`      | `out/web`      | Web 产物目录                                   |
| `WORKBENCH_TOKEN`        | 无             | 共享口令（≥16 字符）。也可放 `<dataDir>/token` |
| `WORKBENCH_WORKDIR`      | `~/.workbench` | 运行时 workdir 留空时的默认工作目录            |
| `WORKBENCH_RECEIPT_TOOL` | 开             | `=0` 关闭回执工具通道（排查协议问题时用）      |

鉴权：`POST /api/session` 用口令换 HttpOnly + SameSite=Strict 的 cookie；脚本可用
`x-workbench-token` 头或 `Authorization: Bearer <token>`。

## 部署

```ini
# /etc/systemd/system/workbench.service
[Unit]
Description=Workbench
After=network-online.target

[Service]
Type=simple
User=workbench
WorkingDirectory=/opt/workbench
Environment=WORKBENCH_DATA_DIR=/var/lib/workbench
Environment=WORKBENCH_HOST=127.0.0.1
EnvironmentFile=/etc/workbench.env   # WORKBENCH_TOKEN=...
ExecStart=/usr/bin/node out/server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
# 容器
docker run -d --name workbench \
  -p 127.0.0.1:3000:3000 \
  -v workbench-data:/data \
  -e WORKBENCH_HOST=0.0.0.0 -e WORKBENCH_DATA_DIR=/data \
  -e WORKBENCH_TOKEN=$(openssl rand -hex 32) \
  node:22 node /app/out/server/index.js   # 镜像里带 out/ 与 node_modules
```

放到公网时在前面加一层反向代理（Nginx/Caddy）并终止 HTTPS：SSE 需要
`proxy_buffering off` / `X-Accel-Buffering: no`（服务端已经带了后者）。

## 命令

分四区，共 20 条。**闸门（判定项目好坏）一律以 `verify` 开头**；其余命令不参与判定，也不该当作「这个项目现在是好的」的证据。

**构建**

| 命令                              | 用途                                                     |
| --------------------------------- | -------------------------------------------------------- |
| `pnpm dev`                        | 开发：服务端 watch + Web HMR                             |
| `pnpm build`                      | 产出 `out/server` + `out/web`（类型门见 `verify:types`） |
| `pnpm build:server` / `build:web` | 只产出其中一半                                           |

**检查（闸门，`verify` 前缀）**

| 命令                   | 用途                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm verify`          | 编辑中随手跑：类型 + lint（ESLint）+ guards + 单测                                                         |
| `pnpm verify:types`    | 只要类型（tsc node + web 双工程）                                                                          |
| `pnpm verify:lint`     | ESLint（含架构边界与 react-hooks 规则）                                                                    |
| `pnpm verify:guards`   | 六个机械守卫：floor / 内核预算 / 密钥 / UI 规则 / 依赖方向 / 派生路径                                      |
| `pnpm verify:test`     | 单元 + 集成用例（`tests/server/**` 会真起 HTTP 服务；监听模式 `pnpm exec vitest`）                         |
| `pnpm verify:coverage` | 覆盖率阈值 + 改动行覆盖率 ≥ 90%                                                                            |
| `pnpm verify:e2e`      | 构建后跑全部 E2E（每个用例独立服务进程 + Chromium；单档：`pnpm verify:e2e -- tests/e2e/api-only.spec.ts`） |
| `pnpm verify:mutation` | 变异测试：默认本次改动，`-- --scan` 全量，`-- packages/core/kernel/src/core/cron.ts` 定点复核              |
| `pnpm verify:all`      | 全部闸门 + E2E：交付 / 推送用这一条（`pre-push` 自动跑）                                                   |

**工具型**

| 命令             | 用途                                                      |
| ---------------- | --------------------------------------------------------- |
| `pnpm format`    | Prettier 全仓写（只检查：`pnpm exec prettier --check .`） |
| `pnpm gen:paths` | 改包清单后重建路径解析文件                                |
| `pnpm db:export` | 只读导出数据库全表 JSON（迁移前回滚点）                   |

**其他**

| 命令                             | 用途                                  |
| -------------------------------- | ------------------------------------- |
| `pnpm start`                     | 运行构建产物 `out/server/index.js`    |
| `pnpm prepare`                   | 安装 husky（`pnpm install` 自动执行） |
| `pnpm git:clean` / `pnpm git:mr` | 提交前工作区检查 / 提交 MR            |

## 目录

```
workbench/
├── apps/
│   ├── server/            # 产品入口：装配根、配置、生命周期（node out/server/index.js）
│   └── web/               # Vite 壳，产 out/web
├── packages/
│   ├── core/{protocol,kernel}          # 契约（含校验）与纯内核：收事件、按规则分活、派活、记账
│   ├── sdk/capabilities                # 插件能力面（spawn / net / notify / paths 的门控）
│   ├── contract/{api,app-events}       # 跨端契约（三动词 WorkbenchApi、app 事件白名单）
│   ├── host/{host,store,frontend-static}  # 宿主：调度、通道、进程、插件发现；store 是唯一写库点
│   ├── api/http                        # HTTP/SSE/鉴权/应答信封
│   ├── plugins/                        # 四类插件一包一个：executor-* / source-* / channel-* / kit+registry
│   ├── bundle/{base,web}               # 服务端装配（Web 可选）
│   └── client/                         # 浏览器端：shell / kernel-store / bridge / ui-primitives / ui-kit / app-ai-workflow
├── tests/                 # 按层镜像 packages/*/src 与 apps/*/src；e2e 在 tests/e2e
├── docs/                  # 架构、规格、计划、测试
├── scripts/               # 构建与门禁脚本（dev / floor-guard / check-* / sim-*）
└── vite.server.config.mts / vite.web.config.mts   # 服务端与 Web 的构建配置
```

## 文档

- [架构总纲：内核 + 插件](docs/ARCHITECTURE.md)
- [服务器形态规格](docs/specs/SPEC-server.md) · [宿主规格](docs/specs/SPEC-host.md) · [外壳规格](docs/specs/SPEC-shell.md)
- [能力地图 / 模块索引](docs/CAPABILITY-MAP.md)
- [测试策略](docs/testing/TESTING.md) · [人工验收](docs/testing/ACCEPTANCE.md)
- [Electron → 服务端 迁移记录](docs/planning/rewrite-server-deployment.md)

## 约定

- 用简体中文写文档与注释；命名：组件 PascalCase、函数/变量 camelCase、常量 UPPER_SNAKE_CASE。
- UI 走 Tailwind + `components/ui/`（shadcn/ui v4 上游源码）；配色/圆角/对比度硬规则见 [SPEC-ui](docs/specs/SPEC-ui.md)。
- 一次性运行日志、临时产物、临时脚本放 `.scratch/`（不进仓库）。
