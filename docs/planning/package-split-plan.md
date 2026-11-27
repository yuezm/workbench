---
type: plan
status: active
owner: lead
updated: 2026-11-28
---

# 包拆分方案：apps + packages（参考 deepseek-harness）

> 2026-11-16。本文定义仓库从「单包 `src/<层>`」迁到「`apps/*` + `packages/<域>/<包>`」的目标形态、边界与批次。
> 结构参照 `D:\Codes\github\agents\packages\deepseek-harness`，但**只借结构，不借它的运行时机制**（cordis、逐包 tsdown、plugin market 等，见 §8）。
> 现状分层与依赖方向仍以 [ARCHITECTURE](../ARCHITECTURE.md)、[CAPABILITY-MAP](../CAPABILITY-MAP.md) 为准；本文只改「这些层怎么落成包」。

## 0. 一句话

服务端是产品本体，Web 是一层**可选挂载**：`apps/server` 单独跑通全部功能（CLI/HTTP/SSE），`apps/web` 只是给同一个服务端画界面。包边界要保证「去掉 Web 端，服务端一行代码都不用改」。

## 1. 目标树

```
apps/
  server/                    @workbench/server            bin: workbench   服务端装配根 + 进程入口
  web/                       @workbench/web               vite 壳 → out/web（纯静态）
packages/
  core/
    protocol/                @workbench/protocol          契约：命令 / 视图 / 事实 / HTTP 三通道
    kernel/                  @workbench/kernel            纯内核（内部 core/ + scopes/ 原样保留）
  sdk/
    capabilities/            @workbench/capabilities      插件能力面（原 src/sdk）
  contract/
    api/                     @workbench/contract-api      window.workbench 契约
    app-events/              @workbench/app-events        内置 app 事件白名单
  host/
    store/                   @workbench/host-store        facts 追加 + 投影（唯一写库点）
    host/                    @workbench/host              宿主：调度 / 执行器端口 / 对账 / 资料 / 通知
    frontend-static/         @workbench/host-frontend-static  唯一知道 out/web 在哪的包
  api/
    http/                    @workbench/api-http          HTTP 路由 / SSE / 鉴权 / 应答信封
  plugins/
    kit/                     @workbench/plugins-kit       纯函数（原 src/plugins/shared）
    registry/                @workbench/plugins-registry  静态注册表 + manifest 类型
    executor-dsh/            @workbench/executor-dsh
    executor-claude/         @workbench/executor-claude
    executor-hermes/         @workbench/executor-hermes
    executor-command/        @workbench/executor-command
    executor-remote/         @workbench/executor-remote
    source-webhook/          @workbench/source-webhook
    channel-in-app/          @workbench/channel-in-app
    channel-desktop/         @workbench/channel-desktop
    channel-webhook/         @workbench/channel-webhook
    channel-feishu/          @workbench/channel-feishu
  bundle/
    base/                    @workbench/bundle-base       服务端全套装配（无 Web 也能跑）
    web/                     @workbench/bundle-web        base + frontend-static
  client/
    bridge/                  @workbench/client-bridge      浏览器侧唯一传输实现
    kernel-store/            @workbench/client-kernel-store  快照 + 增量
    shell/                   @workbench/client-shell      外壳、app 注册表、样式
    ui-primitives/           @workbench/client-ui-primitives  shadcn 上游源码
    ui-kit/                  @workbench/client-ui-kit     项目覆盖层组件（Field/Panel/Menu…）
    app-pomodoro/            @workbench/client-app-pomodoro
    app-ai-workflow/         @workbench/client-app-ai-workflow
  support/
    test-support/            @workbench/test-support      夹具（假传输、临时库、假执行器）
```

包一律两层（`packages/<域>/<包>`），所以 `pnpm-workspace.yaml` 只需要 `apps/*` + `packages/*/*`；不建议出现单层包目录。

源位置映射（`git mv` 的对照表）：

| 现在                                                                                         | 之后                                                                 | 备注                                    |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| `src/protocol/**`                                                                            | `packages/core/protocol/src/**`                                      | 目录内相对 import 不变                  |
| `src/kernel/**`                                                                              | `packages/core/kernel/src/**`                                        | `core/`、`scopes/` 两层保留；**不拆包** |
| `src/sdk/**`                                                                                 | `packages/sdk/capabilities/src/**`                                   |                                         |
| `src/host/store/**`                                                                          | `packages/host/store/src/**`                                         | 只有它能写 `facts` / 投影表             |
| `src/host/**`（其余）                                                                        | `packages/host/host/src/**`                                          |                                         |
| `src/server/{http,event-stream,auth,static,fs-browse,notify,run-approvals,secret-cipher}.ts` | `packages/api/http/src/**`                                           | 传输与鉴权                              |
| `src/server/{index,lifecycle,assembly,config,version,workdir}.ts`                            | `apps/server/src/**`                                                 | 装配根                                  |
| `src/plugins/shared/**`                                                                      | `packages/plugins/kit/src/**`                                        | 仅纯函数                                |
| `src/plugins/{registry,manifest}.ts`                                                         | `packages/plugins/registry/src/**`                                   |                                         |
| `src/plugins/executors/<x>/**`                                                               | `packages/plugins/executor-<x>/src/**`                               | 每个执行器一个包                        |
| `src/plugins/sources/<x>/**`                                                                 | `packages/plugins/source-<x>/src/**`                                 |                                         |
| `src/plugins/channels/<x>/**`                                                                | `packages/plugins/channel-<x>/src/**`                                |                                         |
| `src/shared/apps.ts`                                                                         | `packages/contract/app-events/src/**`                                |                                         |
| `src/renderer/src/shared/{api.d.ts,bridge.ts}`                                               | `packages/contract/api/src/api.ts` + `packages/client/bridge/src/**` | 类型与实现分家                          |
| `src/renderer/src/shell/**`                                                                  | `packages/client/shell/src/**`                                       |                                         |
| `src/renderer/src/components/ui/{button,input,…}.tsx`（上游）                                | `packages/client/ui-primitives/src/**`                               |                                         |
| `src/renderer/src/components/ui/{field,panel,menu,segmented,…}` + `lib/**`                   | `packages/client/ui-kit/src/**`                                      | 项目覆盖层                              |
| `src/renderer/src/apps/<id>/**`                                                              | `packages/client/app-<id>/src/**`                                    |                                         |
| `src/renderer/{index.html,src/main.tsx}` + vite web 配置                                     | `apps/web/**`                                                        | 只剩壳                                  |
| `out/server/index.js`                                                                        | 产物不变                                                             | 入口换成 `apps/server/src/index.ts`     |

## 2. 服务端为根本：5 条硬事实

不写进文档的行为等于没有。拆完必须能被下面 5 件事证明：

1. **bin 只在 `apps/server`**：`workbench` 命令 = 起服务；`--ui=off` 是默认推导结果（见 3），不是另开的「headless 模式」。
2. **依赖闭包可判定**：`apps/server` 与 `packages/bundle/base` 的传递依赖里不得出现 `packages/client/*` 或 `apps/web`。由 `scripts/check-packages.mjs` 强制（已入库），违反即 `pnpm check:fast` 失败。
3. **dist 知识只在一处**：只有 `packages/host/frontend-static` 读 `out/web`（或 `WORKBENCH_WEB_DIST`）。目录缺失时：`/` 与未命中路径返回一段纯文本说明（含 API 地址与构建提示），`/api/*` 与 SSE 全部正常。**不 500、不退出、不降级任何服务端能力。**
4. **`apps/web` 不 import 服务端包**：它只依赖 `client/*` + `core/protocol` + `contract/*`。构建产物是静态文件，服务端按文件读，不 import 前端代码。
5. **门禁两档**：`e2e:api`（无浏览器：起服务 → dispatch/query/SSE 全链路）先跑；`e2e:ui` 后跑。第一档不需要 Chromium，也就是「没有 Web 端也必须绿」的形态。

## 3. 装配与启动解析

`apps/server/src/index.ts` 决定装哪一层：

```
bundle/base            → 内核 + host + api/http + 插件注册表        （永远装载）
bundle/web             → base + host/frontend-static                （有 out/web 或显式 --ui）
```

解析顺序：`--ui=on|off` 显式参数 → `WORKBENCH_UI` 环境变量 → 探测 `out/web/index.html` 是否存在。任一步为 off 就只起 base，打印：

```
workbench listening on http://127.0.0.1:3000 (api only; web ui not built)
```

这条与现在的启动行兼容（e2e 与运维脚本按 `workbench listening on` 取地址）。

## 4. 与 deepseek-harness 的对照

| dsh                                                              | 本仓库对应                                    | 差异                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/cli`（`dsh` bin，`dsh web` 才带前端）                      | `apps/server`（`workbench` bin，UI 自动探测） | 我们只有一个产品形态，不需要 `dsh headless` 子命令                                         |
| `apps/web`（vite 壳，产 dist，不含业务）                         | `apps/web`                                    | 一致：只 build，不提供 npm 包                                                              |
| `apps/desktop` + `apps/desktop-host`                             | —                                             | 已从 Electron 迁到服务端，不再有壳                                                         |
| `packages/bundle/{base,headless,web-app,sdk-app,…}`              | `packages/bundle/{base,web}`                  | 只保留两个 surface，不加 SDK/ACP surface                                                   |
| `packages/core/*`（agent、session、tools…）                      | `packages/core/{protocol,kernel}`             | 我们的内核已是一个纯模块，不再按领域拆                                                     |
| `packages/api/*`（session/workspace/terminal… 控制器）           | `packages/api/http`                           | 三动词协议只有一组控制器，规模不够拆                                                       |
| `packages/host/{webserver,frontend-static}`                      | `packages/host/{host,frontend-static}`        | webserver 的能力并进 `api/http`（同一进程、同一路由表）                                    |
| `packages/client/*`（70+ UI 包）                                 | `packages/client/*`（8 个）                   | 先按「桥接 / 状态 / 外壳 / 基座 / 覆盖层 / 每个 app」切，UI 区块内部再按目录分，不逐块建包 |
| `packages/sdk/{protocol,server,client}`（进程外 SDK）            | —                                             | 暂不需要；将来对外驱动时按这个形状补                                                       |
| 每包 `tsdown.config.ts` → `lib/`，根 `tsc -b` project references | 源码直读（见 §5）                             | 不发布，不产 `lib`                                                                         |

## 5. 解析与构建：源码直读，不产 lib

dsh 每包都编出 `lib/`，因为它要发 npm（`publishConfig`、`files`、`exports`）。我们是自用单仓，编 30 个包只为运行时解析是纯开销，因此：

- **包名 + 路径生成**：`scripts/gen-workspace-paths.mjs` 扫 `apps/*`、`packages/*/*` 的 `package.json`，产出两份派生文件（**不手写**）：
  - `tsconfig.paths.json`：`@workbench/* → ./packages/<域>/<包>/src/index.ts`，被 `tsconfig.node.json` / `tsconfig.web.json` extends；
  - `scripts/workspace-aliases.mjs`：同一份映射的 vite/vitest alias 对象，`vite.server.config.mts`、`vite.web.config.mts`、`vitest.config.mts` 各 `import` 一次。
  - `--check` 模式比对现状，接进 `check:fast`（防止「加了包忘改别名」）。
- **构建只发生在 apps 层**：
  - `apps/server` → vite SSR 打包成单文件 CJS `out/server/index.js`（Node 内置全部 external，零第三方运行时依赖，现状不变）；
  - `apps/web` → `out/web` 静态 SPA。
- **typecheck 仍是两棵树**：`tsconfig.node.json`（protocol/kernel/sdk/contract/host/api/plugins/bundle/apps-server/tests 服务端侧）、`tsconfig.web.json`（protocol/contract/client/apps-web/tests 渲染侧）。两边都只 include，不 composite（省掉 `tsc -b` 排序问题）。
- 代价：`pnpm dev` 不能只重建某个包（全量 vite watch，现状同）；类型错误定位按包名，比相对路径略长。收益：没有 30 个构建节点，没有 `lib/` 与源码漂移。

## 6. 依赖方向（`scripts/check-packages.mjs` 的 ALLOWED 表）

| 域              | 允许依赖                                                                     | 语义                                      |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------------- |
| `core/protocol` | `util`                                                                       | 纯契约，谁都能依赖它                      |
| `core/kernel`   | `core/protocol`、`util`                                                      | 纯内核，**不得**出现 host/api/plugins/sdk |
| `sdk`           | `core`、`util`                                                               | 插件能力面类型                            |
| `contract`      | `core/protocol`、`util`                                                      | 跨端唯一交点                              |
| `host`          | `core`、`sdk`、`contract`、`plugins/registry`、`plugins/kit`、`host`、`util` | 只经注册表取插件                          |
| `plugins/*`     | `core`、`sdk`、`contract`、`plugins/kit`、`util`                             | 插件之间禁止互 import                     |
| `api`           | `core`、`sdk`、`contract`、`host`、`plugins/registry`、`api`、`util`         | 不碰具体插件实现                          |
| `bundle`        | 服务端全域 + `bundle`                                                        | 装配层唯一允许「什么都见」                |
| `client`        | `core/protocol`、`contract`、`sdk`、`client`、`util`                         | **不得**依赖 kernel/host/api/bundle       |
| `app:server`    | 服务端全域 + `bundle`                                                        | 闭包禁 `client`                           |
| `app:web`       | `core/protocol`、`contract`、`client`、`util`                                | 闭包禁服务端                              |

同时守两条源码事实：包内相对 import 不得越过包目录（跨包必须写包名）；包名必须是 `@workbench/*`。

`tests/tools/check-packages.test.ts` 给每条检测配了正反用例（守卫要能失败才叫守卫）。

## 7. 迁移批次

每批独立可验收，`pnpm check:fast` 必须绿；批次之间不并跑，避免同时搬内核与宿主时错误定位失效。

| 批              | 搬什么                                         | 改什么                                                                                                                                                                                                                                                                            | 验收                                                |
| --------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **B0** 基座     | 不搬代码                                       | `pnpm-workspace.yaml` 声明 `apps/* packages/*/*`；`scripts/gen-workspace-paths.mjs` 产出 `tsconfig.paths.json` + `scripts/workspace-aliases.mjs`（两个 vite 配置与 vitest 已接上）；`scripts/check-packages.mjs` + 两份守卫自检；`check:fast` 接 `check:packages` / `check:paths` | `pnpm check:fast` 绿（**已落地**）                  |
| **B1** 契约     | `protocol`、`sdk`、`contract/*`                | 生成器产出 paths/aliases；跨包引用改包名（`@workbench/protocol`）                                                                                                                                                                                                                 | typecheck + `tests/architecture.test.ts` 改路径后绿 |
| **B2** 内核     | `kernel`                                       | `check-kernel-budget.mjs` 与 `tests/kernel/purity.test.ts` 的根路径改为 `packages/core/kernel/src`                                                                                                                                                                                | `check:kernel` 绿；`decide` 性能基准不变            |
| **B3** 宿主     | `host/store`、`host/host`                      | `architecture.test.ts` 的「只有 host/store 写 facts」按新路径判定                                                                                                                                                                                                                 | 事实/投影测试 + 架构测试绿                          |
| **B4** 插件     | `plugins/*` 一插件一包                         | `registry.ts` 改成 import 各包；eslint 规则由 glob 换成包名组                                                                                                                                                                                                                     | 执行器/detect/回执测试绿                            |
| **B5** 服务端   | `api/http`、`bundle/{base,web}`、`apps/server` | vite 入口 `apps/server/src/index.ts`；`dev.mjs` 的构建目标；启动行加 `(api only)` 分支                                                                                                                                                                                            | `e2e:api`（新）绿；`WORKBENCH_UI=off` 下 curl 全通  |
| **B6** 前端     | `client/*`、`apps/web`                         | vite web 的 `root` 指向 `apps/web`；`@renderer` 别名退役改包名；eslint 渲染边界按包名                                                                                                                                                                                             | `e2e:ui` 绿；`check:ui` 绿                          |
| **B7** 测试镜像 | `tests/**` 与包同构                            | `tests/packages/<域>/<包>/**`；vitest include 扩大；覆盖率 exclude 不变                                                                                                                                                                                                           | `test:coverage` 阈值不降                            |
| **B8** 收口     | 删空目录、文档                                 | ARCHITECTURE「组织」一节改写；CAPABILITY-MAP 模块 id 加包名列                                                                                                                                                                                                                     | 全量 `pnpm check` + `pnpm e2e`                      |

搬迁手法统一：`git mv src/<x> packages/<域>/<包>/src` → 补 `package.json`（name / version 0.0.0 / private / 依赖）→ 跑生成器 → 改跨包 import → 跑门禁。批次内按目录顺序逐个搬，每个包搬完立刻跑 typecheck，不攒到最后。

## 8. 不照抄 dsh 的 5 条

1. **不引入 cordis / 微内核插件总线**：我们的插件是四类固定端口（source / executor / channel / app）+ `registry.ts` 数组，进程内、编译期注册；引入依赖注入容器换不来任何当前收益。
2. **不做每包 `tsdown` + project references**：不发布 npm，源码直读（§5）。代价已列。
3. **不把 client 拆成 70+ 个 UI 包**：先 8 个；`ui-kit` 内部按组件目录分，等某个区块真的被第二个 app 复用再提包。
4. **不建 plugin-market / bundle 生成器**：没有第三方插件市场，也没有多 surface 矩阵。
5. **不做 `packages/sdk/*` 进程外 SDK**：等真有外部程序要驱动工作台（M 级新需求）再按 dsh 的 `protocol/server/client` 三件套补。

## 9. 风险与回滚

| 风险                                       | 处理                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 跨包相对 import 漏改，运行期才炸           | 生成器 + `check-packages` 源码边扫描（`import`/`export from`/动态 `import()`/`require`）双保险；批次内逐包 typecheck                          |
| `git mv` 后 git 历史断裂                   | 用 `git mv`（不是删除+新建），`git log --follow` 保持                                                                                         |
| 搬迁期间两条真相源（旧 `src/` 与新包并存） | 每批只搬一个域，搬完即删旧目录；不保留 re-export 转发层（AGENTS「不得为兼容保留废弃字段」同理）                                               |
| 覆盖率/diff 门禁因路径变动误判             | `check-diff-coverage.mjs` 按行比对，与新路径无关；`check-kernel-budget.mjs`、`check-ui-rules.mjs`、`floor-guard.mjs` 的根路径在对应批次同步改 |
| 想回退                                     | 拆分是纯结构变更，每批一个 commit；回退 = revert 该批 commit（无数据/schema 变化）                                                            |

## 10. 落地记录（2026-11-16）

B0–B6 已按批次做完，仓库从「单包 `src/<层>`」变成「`apps/*` + `packages/<域>/<包>`」，共 **32 个包**，`pnpm check:fast`、全量单测（230 文件 / 3906 用例）与 `pnpm e2e:api` 全绿。

| 批        | 结果                                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0 基座   | `pnpm-workspace.yaml` 声明 `apps/*` + `packages/*/*`；`gen-workspace-paths.mjs` 产出 `tsconfig.paths.json` + `workspace-aliases.mjs`（子路径通配 + `.tsx` 入口）；`check-packages.mjs` 守三类边界；两份守卫自检入库                                            |
| B1 契约   | `protocol`、`capabilities`（原 `src/sdk`）、`app-events`、`contract-api` 四个包；723 处 import 换成包名                                                                                                                                                        |
| B2 内核   | `@workbench/kernel`；预算脚本、purity 测试的扫描根改到包目录；内核新增「只准依赖 protocol」的断言                                                                                                                                                              |
| B3 宿主   | `@workbench/host` + `@workbench/host-store`（`db`/`schema` 归 store，装配只经 `host-store`）                                                                                                                                                                   |
| B4 插件   | 一包一个：5 个执行器、4 个通道、1 个来源、`plugins-kit`、`plugins-registry`；eslint 边界改包名 glob；`boundary.test.ts` 重写为包模型（相对 import 必须留在本包，跨包只准 protocol/capabilities/plugins-kit，registry 例外）                                    |
| B5 服务端 | `@workbench/api-http`（HTTP/SSE/鉴权）+ `@workbench/host-frontend-static`（唯一 dist 知识）+ `bundle/{base,web}` + `apps/server`；`WORKBENCH_UI=off/auto/on`，纯 API 模式下 `/` 返回纯文本说明；新增 `tests/e2e/api-only.spec.ts`（无浏览器）与 `pnpm e2e:api` |
| B6 前端   | `client/{bridge,kernel-store,shell,ui-primitives,ui-kit,app-pomodoro,app-ai-workflow}` + `apps/web`（vite 壳）；`@renderer` 别名退役；`check-ui-rules.mjs`、prettier 的 tailwind 样式路径同步到包目录                                                          |

**B7（测试镜像）的取舍**：不物理搬迁 `tests/**`。理由是搬迁 230 个测试文件只改摆放、不改门禁强度，却要连带重写全部测试内相对路径（`tests/support/*`、`tests/host/store/test-support` 等），风险高于收益。改为两条替代措施：

1. `tests/` 继续按层镜像（`tests/server/http.test.ts` ↔ `packages/api/http/src/http.ts`，`tests/kernel/**` ↔ `packages/core/kernel/src/**`），import 早已是包名；
2. `floor-guard.mjs` 的「测试与其被测源码一起删除」判定，从「目录前缀同名」改成「文件名同 stem」兜底——包结构下目录不再同名前缀，只靠前缀会漏判。

**B8（文档收口）**：ARCHITECTURE 的分层/依赖方向/边界守则、AGENTS 的架构原则与禁止事项、CAPABILITY-MAP 的模块表都改成包名；老文档里的 `src/<层>/` 写法按 ARCHITECTURE 的一句约定理解为对应包路径。

**新增门禁**：`pnpm check:packages`（依赖方向 + headless 闭包 + 跨包相对 import）、`pnpm check:paths`（派生解析文件与包清单一致）、`pnpm e2e:api`（无浏览器档）。

**验证状态（2026-11-16 本机）**：`pnpm build`（server 单文件 CJS + web SPA）✓、`pnpm check:fast`（typecheck / lint / floor-guard / kernel-budget / secrets / ui-rules / packages / paths）✓、`npx vitest run`（230 文件 / 3906 用例）✓、`pnpm e2e:api`（无浏览器档）✓。`pnpm e2e`（带 Chromium 的全量档）本轮未跑：本机 `~/.cache/ms-playwright` 缺 chromium-headless-shell，`npx playwright install chromium` 在离线环境下没有进展；这是环境依赖，不是拆分的回归——装好浏览器后按原命令跑即可。
