# 产品调研：AI 工作流的下一步（多运行时 / 多设备 / SOP 串联）

> 2026-11-05。范围：`SPEC-ai-workflow` 已落地 MVP 之后的三块空白——多协议族运行时、远端 Worker、工作流串联。只做调研，不改 spec / 代码。
> 任务来源：「测试任务 / 产品调研」未带子项，按仓库里唯一尚未实现的产品方向（[个人AI工作流.md](../features/个人AI工作流.md) 第 1、3 条，以及 SPEC 的 Out of scope）执行。若调研对象不是这个，以你指定为准。

## 结论

1. **多运行时不要按 CLI 一对一硬写**。两种可行路径：接 ACP（跨厂商标准）当协议族，或每家写薄适配。前者省协议、后者省权限往返，实际会混用。
2. **多设备不必自建服务端**。用「拉模式 + 单写者」的轻中枢即可，先在本机跑通 daemon 语义再跨机；照抄 Multica 的 Go + Postgres 会直接推翻「单机、无登录」的前提。
3. **SOP 串联是三者里最便宜、最快能交付的一块**，且不需要新基础设施，建议作为下一版第一项。
4. **真正的难点不是传输，是权限/审批往返与事件语义归一**。协议帧各家长得都不一样，能复用的只有会话、取消、进程树这几件事。

## 1. 参照产品：Multica

定位：源码公开的团队工作区，把任务派给 AI 编码智能体，智能体在本机跑、边跑边评论、跑完把任务挪到「审核中」等人验收。

| 维度     | Multica 的做法                                                                              | 我们的现状                                            |
| -------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 部署     | 自托管 / 云；Go(Chi) + PostgreSQL 17 + Next.js + Electron 桌面端 + Expo 移动端              | Electron 单机，`node:sqlite` 单文件，无服务端、无登录 |
| 运行时   | 每台机器一个守护进程（daemon），后端经 WebSocket 下发运行                                   | 主进程直接 `spawn` 本机 CLI                           |
| CLI 覆盖 | 26 种（Claude Code、Codex、Cursor、Copilot、OpenCode、Hermes、Pi、dsh、omp…），含权限与登录 | 仅 `dsh` 协议族                                       |
| 派活     | 任务指定 agent 负责人；cron（autopilot）；聊天里直接派                                      | 看板任务 + agent 阶段；聊天是独立会话                 |
| 可观测   | 每次工具调用/命令带时间戳可回放；用量按 agent/任务统计；失败自动重试                        | `run_events` + `runs.usage`，无统计视图               |
| 人的位置 | 「审核中」由人验收，收件箱只在需要拍板时提醒                                                | `user` 阶段 + 拖拽换阶段                              |

可迁移的：**「运行时 = 机器上的守护进程 + 一种 CLI」这个语义**（我们的运行时只是 CLI 配置，没有进程常驻概念）；**运行中插话**（steer）；**失败重试策略**。
不可迁移的：多人角色、Web/移动多端、Postgres、Git 集成——都与「自用、单用户、本地」冲突。

## 2. 运行时协议现状

| CLI               | 非交互入口                                                             | 事件流                                                  | 审批能力                                                                                                | 接入成本判断                          |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `dsh`（已接）     | `--profile <p> --stdio`                                                | 版本化 JSONL v1（ready/session/text/tool/usage/result） | 无往返，越界即失败                                                                                      | 基线                                  |
| Claude Code       | `-p` / `--print`，`--output-format stream-json`                        | 逐行 JSON 事件                                          | 有 permission 请求                                                                                      | 中：帧语义需映射，必须处理 permission |
| Hermes Agent      | `hermes acp`（ACP over stdio）、TUI gateway JSON-RPC、OpenAI 兼容 HTTP | ACP 事件 / JSON-RPC 事件 / SSE                          | ACP 的 `session/request_permission`、gateway 的 `approval`、`clarify` 是**服务端→客户端请求**（要回帧） | 中高：三种协议任选，但审批是必需项    |
| Codex             | `exec` + JSON 输出                                                     | 自有事件格式                                            | 沙箱/审批策略                                                                                           | 待验证（官方文档页 403，未取到原文）  |
| oh-my-pi（`omp`） | 未验证                                                                 | 未验证                                                  | 未验证                                                                                                  | 待验证                                |

关键事实：**没有两家的帧格式一致**。可归一的公共最小集是「就绪 / 会话 id / 增量文本 / 工具调用 / 用量 / 终态」；其余事件应当**丢弃而非猜测**（现有 `dsh.ts` 已经是这个原则，可复用）。

## 3. 三条方向的取舍

| 方向                        | 价值                                   | 工程量                                                                                          | 主要风险                                    | 结论                |
| --------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------- |
| A. 多协议族后端             | 高：让已装的 CLI 都能用                | 改契约枚举 + 后端实现 + registry 登记 + DB CHECK（需迁移）+ UI 选项；每族约一个 `dsh.ts` 的体积 | 审批往返、事件映射错误、维护 N 份解析       | 值得做，先做 1–2 族 |
| B. 远端 Worker / 多设备     | 中：多机并行，但单人自用场景收益不确定 | 高：常驻 daemon、派发通道、鉴权、任务归属、离线补偿                                             | 与「无登录、纯本地」原则冲突；SQLite 单写者 | 最后做，且用拉模式  |
| C. 工作流串联（SOP 串 SOP） | 高：把「大型任务 = 多个 SOP 串联」落地 | 低：`stage-machine` 上加「阶段可引用子工作流」，流转时展开；数据模型加一层父子关系              | 语义歧义（见未决问题 3）                    | 下一版第一个交付项  |

## 4. 建议路线

**第一步：SOP 串联。**
在 `workflow_stages` 上增加「该阶段的产出交给哪个子工作流」的可选引用，进入阶段时创建子任务而不是 restart 父任务；子任务 `completed` 视作父阶段完成。`stage-machine.ts` 保持纯函数，只把「子任务完成」当成一个新的输入事件，不改既有转移规则。

**第二步：第二个协议族。**
优先 Claude Code（用户基数最大，`stream-json` 文档完整）；若目标是「一个适配吃多家」，优先 ACP（Hermes 已实现 `hermes acp`，Zed/VS Code/JetBrains 生态在用）。落地点：`PROTOCOL_FAMILIES` 枚举、`schema.ts` 的 CHECK、`registry.ts` 的 switch、`RuntimeDialog` 的选项，四处在同一个 PR 里改完并加迁移。

**第三步：拉模式 Worker。**
daemon 只做三件事：注册（本机标识 + 能力）、拉任务、回事件。派发按「租约 + 心跳」，主进程仍是唯一写库者；跨机时用 WSS。先验证形态：同一台机器起第二个进程，跑通「拉取 → 执行 → 回写」，再谈多机与鉴权。

## 5. 已知的坑

- **审批往返**：现状明确不做 stdio 审批（权限越界直接失败）。接 Claude Code / Hermes 后，permission 请求是常态；不支持回帧就只能全量最严权限，用户会感到「智能体什么都不能做」。至少要支持「请求 → 主进程询问 → 回帧」的最小闭环。
- **事件语义**：不要把「Claude 的 event 类型」直接映射到 `RunEvent` 之外的语义；未知事件丢弃并计数，避免协议升级时静默错乱。
- **会话续接**：DSH 用 `resume_session_id`、Claude 用 `--resume`、Hermes 用 session key——统一到既有 `runs.session_id` 即可，但每族要各自验证「续接被拒」时的重试一次（现有 `resume_rejected` 逻辑可复用）。
- **Windows 进程树**：现有 `taskkill /T /F` 的方案跨协议通吃，新协议族必须复用而不是各写一套。
- **SQLite 单写者**：远端 Worker 若多进程写同一 db 会锁死；要么保持主进程唯一写者，要么开 WAL + 冲突重试，不能两头都想要。
- **成本可见性**：`runs.usage` 已在存，但没视图。多协议族的 token 口径不同（缓存命中、思考 token），统计前先定口径。

## 6. 需要你拍板

1. 是否允许本机监听端口（远端 Worker 的前提）——这与「本地、无登录」的原则直接冲突。
2. 第二个协议族选 Claude Code 还是 Hermes（ACP）。
3. SOP 串联的语义：子工作流完成后（a）父阶段直接完成、（b）回到父阶段等人工确认、（c）产出独立任务挂在父任务下。
4. 是否接受 ACP 作为一个新的 `protocolFamily`（而不是按 CLI 建族）。

## 参考

- [Multica README（中文）](https://github.com/multica-ai/multica/blob/main/README.zh.md)
- [Hermes Agent · Programmatic Integration（ACP / TUI gateway / API server 三协议）](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [Claude Code · Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction)
- [aiteam：单二进制消息中枢 + 多机多客户端](https://github.com/carlaau/aiteam)
