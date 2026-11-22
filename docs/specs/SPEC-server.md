# SPEC：服务器形态（`apps/server`）

> 2026-11-16 定稿。本文描述 Workbench 从 Electron 桌面应用改成**常驻服务 + Web 界面**之后的运行形态；
> 内核对齐 `SPEC-kernel`，宿主对齐 `SPEC-host`，浏览器外壳对齐 `SPEC-shell`。
> 迁移过程与取舍见 [rewrite-server-deployment](../planning/rewrite-server-deployment.md)。

## 一句话

一个 Node 进程装好内核、宿主与插件，起一个同源 HTTP 服务（三动词 + SSE），并把 Web 产物一起托管；
浏览器是唯一界面，进程管理器是唯一「安装与开机自启」手段。

## 目标与非目标

**做**：

- 服务端一套进程跑完原有全部业务：事件、规则、派活、执行、通道、审批、聊天、用量。
- Web 界面观察执行情况（看板/任务详情/运行时间线/聊天）与改配置（工作流/智能体/运行时/规则/插件/项目/飞书连接）。
- 单机自用、单用户、无账号体系；能用系统进程管理器常驻，能在容器里跑。
- 鉴权只有一条：共享 token；对外暴露时强制带 token。

**不做**：

- 多租户、角色权限、用户注册登录（只有一个共享口令）。
- 集群、任务队列、多实例共享一个数据目录（同一数据目录只允许一个服务进程）。
- 桌面专属能力：窗口、托盘、系统通知、单实例锁、原生文件对话框、安装包。

## 进程与数据目录

```
node out/server/index.js
```

- 启动成功打印一行固定格式：`workbench listening on http://HOST:PORT`（e2e 与运维脚本按它取地址）。
- 数据目录（默认 `~/.workbench`，启动时 `mkdir -p`）：

| 路径                    | 内容                                           |
| ----------------------- | ---------------------------------------------- |
| `ai-workflow.db`        | 事实日志 + 投影（`node:sqlite`）               |
| `artifacts/`            | 运行产物（`output.md` / `review.md` / 归档）   |
| `ai-workflow/sessions/` | 执行器会话（聊天跨轮续接）                     |
| `plugins/`              | 用户目录插件（内置 + 用户目录合并，同名覆盖）  |
| `secret.key`            | 插件 secret 的主密钥（32 字节，`0600`）        |
| `token`                 | 可选：共享口令（`WORKBENCH_TOKEN` 未设时读它） |

同一数据目录只允许一个服务进程；要并行就跑两份，各自一个目录与端口。

## 配置

全部环境变量（`apps/server/src/config.ts`）：

| 变量                     | 默认           | 约束                                                          |
| ------------------------ | -------------- | ------------------------------------------------------------- |
| `WORKBENCH_HOST`         | `127.0.0.1`    | 非回环时必须配 token，否则启动失败（`ConfigError`，退出码 1） |
| `WORKBENCH_PORT`         | `3000`         | `0..65535`；`0` 表示系统分配                                  |
| `WORKBENCH_DATA_DIR`     | `~/.workbench` | 相对路径按 `cwd` 解析                                         |
| `WORKBENCH_WEB_DIR`      | `out/web`      | 不存在只 warn（API 仍可用）                                   |
| `WORKBENCH_TOKEN`        | 无             | ≥16 字符；优先级高于 `<dataDir>/token`                        |
| `WORKBENCH_WORKDIR`      | `~/.workbench` | 运行时 workdir 留空时执行器用它（与数据目录同名但独立）       |
| `WORKBENCH_RECEIPT_TOOL` | 开             | `=0` 关闭回执工具通道                                         |

口令来源会在启动日志里说明（`环境变量` 或 `数据目录里的口令文件`），**不打印口令本身**。

## HTTP 契约

路由与请求/应答形状的唯一真相源：`packages/core/protocol/src/http.ts`（`API_PATHS` 与类型）。
所有 `/api` 应答统一信封：

```json
{ "ok": true, "value": {} }
{ "ok": false, "error": { "code": "conflict", "message": "任务已被领取" } }
```

| 方法 | 路径                 | 鉴权 | 说明                                                                                     |
| ---- | -------------------- | ---- | ---------------------------------------------------------------------------------------- |
| GET  | `/api/health`        | 否   | 存活探测：`{status:'ok', clients}`                                                       |
| POST | `/api/session`       | 口令 | `{token}` → `Set-Cookie: wb_session=…`；错口令 401                                       |
| GET  | `/api/info`          | 是   | 版本、内核版本、数据目录、默认工作目录、在线客户端数、pid                                |
| POST | `/api/dispatch`      | 是   | `{command}` → 本次事实摘要 + 实体值（与旧 IPC 同形）                                     |
| POST | `/api/query`         | 是   | `{view, params?}` → 视图切片                                                             |
| POST | `/api/lark`          | 是   | 飞书连接管理动作（不写事实日志）                                                         |
| POST | `/api/notify`        | 是   | `{title, body?}` → 广播一条 `notice` 给所有在线页面                                      |
| GET  | `/api/fs/dirs?path=` | 是   | 列目录（文件夹选择器用）：`{path, parent, roots, entries}`；`roots` 是盘符，盘根靠它跨盘 |
| GET  | `/api/events`        | 是   | SSE：事实批次 / 聊天流 / 知会                                                            |
| GET  | 其它路径             | —    | 静态产物（`out/web`），无扩展名回落到 `index.html`                                       |

错误码与状态：

| 状态 | code                            | 场景                                           |
| ---- | ------------------------------- | ---------------------------------------------- |
| 400  | `invalid_json` / `invalid_body` | 请求体不是 JSON / 缺字段                       |
| 401  | `unauthorized`                  | 没带口令或口令错                               |
| 403  | `forbidden_origin`              | 写请求的 `Origin` 与 `Host` 不一致             |
| 404  | `not_found`                     | 未知接口 / 文件不存在                          |
| 405  | `method_not_allowed`            | 静态路径收到非 GET/HEAD                        |
| 413  | `payload_too_large`             | 请求体 > 1 MiB                                 |
| 500  | `StoreError.code` 或 `internal` | 命令/查询被拒或内部异常                        |
| 501  | `unsupported`                   | 未装配的能力（例如没有 `lark-cli` 的飞书管理） |

## 鉴权

- 唯一口令是共享 token；比较前先做 SHA-256 再 `timingSafeEqual`（常数时间）。
- 三种带法：`x-workbench-token` 头、`Authorization: Bearer <token>`、`wb_session` cookie。
- 浏览器路径：`POST /api/session` 用口令换 cookie（`HttpOnly; SameSite=Strict; Path=/; Max-Age=30d`），
  之后 `fetch` 与 `EventSource` 同源自动携带；页面脚本读不到 token。
- 写请求带 `Origin` 时必须与 `Host` 同源（cookie 鉴权之外的第二道闸）。
- 浏览器**不存 token**：没有 localStorage / sessionStorage 里的口令，刷新页面用同一枚 cookie。

## 事件流（SSE）

- `GET /api/events`，`text/event-stream`，首帧 `retry: 3000`，每 15 秒一行注释心跳（`: ping`）。
- 消息体是 JSON，按 `kind` 分流：
  - `facts`：`{kind:'facts', seq, types}` —— 失效信号，客户端据此重取视图；
  - `stream` / `stream-end`：聊天流旁路（实时显示，事实仍是数据源）；
  - `notice`：`{kind:'notice', title, body, target?}` —— 取代系统通知，页面弹轻提示，`target` 有值时跳转。
- 断线由浏览器 `EventSource` 自动重连；服务端只负责踢掉写失败的连接，不影响其它客户端与写路径。
- 反向代理必须关缓冲（服务端已带 `X-Accel-Buffering: no`）。

## 静态托管

- 只允许 GET/HEAD；`resolveStaticFile` 做路径规范化与越界检查（`..`、`%2e%2e`、NUL 一律 404）。
- `index.html` 不缓存，带指纹资源长缓存。
- 响应头固定 `X-Content-Type-Options: nosniff`；页面自身的 CSP 在 `apps/web/index.html`。

## 插件 secret

- 主密钥：`<dataDir>/secret.key`（32 字节随机，`0600`，懒加载）。
- 密文：`v1.<iv>.<tag>.<ciphertext>`（AES-256-GCM，base64url 分段）。
- 密钥不可用（目录只读、文件被破坏）时 `available()=false`，写 secret 被拒（不落明文），
  日志只记一次原因、不含任何密钥或明文。
- 换机/删 `secret.key` = 已存 secret 解不开：**可恢复失败**，重填即可。

## 装配与退出顺序

装配（`apps/server/src/assembly.ts`）：

1. `mkdir -p` 数据目录 → 收紧 ACL（失败只 warn）→ 产物根 → 回填终态正文；
2. 开库 → store → 导入 v2 存量 → 对账投影 → 补内置阶段；
3. 会话根、默认工作目录、网络与回执工具 → sdk 能力面；
4. 插件目录合并（内置 + 用户目录）→ secret 加密 → 通道与来源 `startAll`；
5. 时钟与调度器 → 唯一写路径 `effects.dispatch` → 命令路由；
6. 启动对账（残留进程 / 超租约 / 崩溃中的聊天）→ `scheduler.wake()` → `clock.start()`。

退出（`SIGINT` / `SIGTERM`，幂等）：

1. `scheduler.cancelAll()`（杀进程树、写取消终态，不等待回执）；
2. `clock.stop()`；
3. 先 `sources.stopAll()`（不再收外部事件），再 `channels.stopAll()`（abort 投递）；
4. `feed.stop()` → `db.close()`；
5. HTTP → SSE → 装配层，最后显式 `process.exit(0)`（防止插件留下的句柄吊住进程）。

## 部署

- systemd：`Type=simple`、`Restart=always`、`EnvironmentFile` 放 `WORKBENCH_TOKEN`（示例见 README）。
- 容器：挂载数据目录卷、`WORKBENCH_HOST=0.0.0.0` + token（非回环强制）。
- 反向代理：终止 TLS，SSE 关缓冲；`Host` 头必须原样透传（同源判定依赖它）。

## 测试口径

- `tests/server/**` 覆盖：配置解析、鉴权与 cookie、HTTP 路由与错误码、SSE 推送、静态托管与路径穿越、
  secret 加密往返与密钥不可用、目录浏览、装配（真库 + 真插件目录）、生命周期与退出幂等、入口守卫。
- e2e（`pnpm verify:e2e`）：每个用例用 `WORKBENCH_DATA_DIR` 临时目录 + `WORKBENCH_PORT=0` 起真服务，
  解析启动行拿地址，再用 Chromium 打开页面；数据隔离与真实进程行为都在这一层验证。

## 已知边界

- 没做速率限制：回环监听 + 单用户前提下，鉴权失败次数不设上限。
- 没做连接级隔离：所有 SSE 客户端共享一个广播，客户端数没有上限（自用规模足够）。
- 目录浏览不做沙箱：能读的目录都能列出来（服务进程账号的可读范围就是上限）。
