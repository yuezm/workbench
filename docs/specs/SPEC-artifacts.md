# SPEC-artifacts：执行记录落盘（M16）

> 2026-11-10。回答两个问题：**库里存什么、文件里存什么**，以及**人怎么从目录找回到某一轮**。
> 实现：`src/host/artifacts.ts`（渲染与原子写）+ `src/host/scheduler.ts`（两个时机点）。

## 1. 边界：库是状态，文件是正文

| 层       | 存什么                                                                                           | 谁写                      |
| -------- | ------------------------------------------------------------------------------------------------ | ------------------------- |
| 事实日志 | `facts`：实体/状态/决策/因果（可重放）                                                           | 内核 decide → effects     |
| 投影     | `tasks` / `threads` / `runs` / `run_events` / `cards` 等 17 张：**运行态与查询用**，可由事实重建 | 宿主 projection           |
| 文件     | 一轮的正文：派发提示词、全帧流水、产出、评审报告、元数据、线程索引                               | 宿主 artifacts（本 spec） |

单向派生：**投影 → 文件**。文件不回写库；要改结论只有一条路——追加事实、让投影重算，再归档。
不允许把 `prompt.md` / `output.md` 当输入去修库（那就成了第二真相源）。

`output.md` 除了归档，还是挂线程阶段的**跨阶段上下文载体**：后续阶段按
`THREAD_LIMITS.precedingExcerptChars` 只拿骨架 + 路径，正文靠执行器按需读。
所以提示词里有固定的「本轮正文」段规定它自包含（结论 / 契约 / 落盘文件 / 未决项），
见 [SPEC-ai-workflow](SPEC-ai-workflow.md) 柔性工作流。

`runs.prompt` / `runs.output` / `run_events.payload_json` 仍留在库里，因为它们是**运行期**需要的
（派发要读提示词、任务索引要摘要、UI 时间线要帧、投影要能重建）。它们与文件是同一份投影的两种物化，
不是两套真相：库先写，文件是终态快照。

## 2. 目录

```
<userData>/artifacts/threads/<threadId>/
  index.md                    ← 人从这里进（表里只链 output.md）
  runs/<runId>/
    prompt.md                 派发提示词（原文 + 只读表头）
    transcript.jsonl          全帧流水（thinking / text / tool_call / tool_result / status）
    output.md                 本轮正文
    review.md                 评审报告正文（有评审内容时才有）
    meta.json                 机器可读元数据（索引与脚本用）
```

`<userData>` = `%APPDATA%\workbench`（Windows）/ `~/Library/Application Support/workbench`（macOS）。

目录名只用 `threadId` + `runId`：路径必须在决策期就能确定（落盘早于终态），
而任务标题、阶段名、轮次都是**决策期之后**才知道的值。人类可读的关联全部下沉到
`meta.json` 与 `index.md`，不放路径。

## 3. 为什么是这几种格式

| 文件                      | 格式          | 理由                                                                                       |
| ------------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| `prompt.md`               | Markdown      | 要能整段复制给模型 / 粘进 issue；表头用 HTML 注释，渲染时不碍眼                            |
| `transcript.jsonl`        | JSON Lines    | 帧是流，追加语义；`jq -c 'select(.type=="tool_result")'` 直接过滤                          |
| `meta.json`               | JSON 对象     | 索引与脚本的稳定输入；对象比行式更适合「一行记录的全部字段」                               |
| `index.md`                | Markdown 表格 | 唯一入口：`任务 + 阶段 + 轮次 → runId → 目录`；只链 `output.md`，其余文件按 runId 进目录看 |
| `output.md` / `review.md` | Markdown      | 执行器产出的正文原样保存（M15 / M14 既有口径）                                             |

不做 YAML front-matter：本轮没有需要机器解析的元数据，`meta.json` 已经承担；
在正文前塞 front-matter 会让「整段复制提示词」多出噪声。

思考流不单独出文件（`thinking.md` 暂不做）：`transcript.jsonl` 已含全部 `thinking` 帧，
需要连读时用 `jq` 按 `seq` 合并即可（见 §6），多存一份合并稿只是把同一份数据的另一种视图
落成第二份正文，暂不承担这个维护面。

## 4. 两个写入时机

| 时机                       | 写什么                                             | 为什么是这个时机                                                                          |
| -------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 派发前（`port.run` 之前）  | `prompt.md`                                        | 「进入阶段时到底给了它什么」是排查第一现场；崩溃也要留得下                                |
| 终态（`run.receipt` 之前） | `transcript.jsonl` / `meta.json` / 重建 `index.md` | 帧已全部 flush 进 `run_events`；`output.md` / `review.md` 已先写完，`meta.files` 才能列全 |

只对 `purpose='stage'` 且挂线程的 run 归档：聊天 run 的正文在 `messages` 投影里，
目录语义（阶段/轮次）对它不成立。

## 5. 失败语义

- 每次写都是**原子写**：`.tmp` → `rename`；崩溃只会留 `.tmp`，不会留半截文件。
- 写失败（磁盘满、权限）返回 `false`，**不抛错、不改变回执、不阻塞任务推进**。
- `meta.files` 只列**确实存在**的文件；`index.md` 由扫描 `meta.json` 重建，
  坏 JSON 只丢那一条，不影响整表。
- 归档缺席时，`index.md` 仍然生成（占位行），不会因为一次失败就少一个入口。

### 索引只链正文

`meta.files` 继续记全四件套（排查与脚本要用），但索引表**只给 `output.md` 一个链接**：
模型据索引读正文、人据索引找正文，两个消费者要的都是它。`prompt.md` /
`transcript.jsonl` 是排查材料（单轮数百 KB，被当上下文整读比读不到更贵），
`meta.json` 是脚本输入；要看它们按 `runId` 列进目录即可。

评审报告不挂链接（模型侧入口在提示词的「待修复清单」段，见 `SPEC-review-handoff`），
但行内保留 `·review` 纯文本标记——「这轮有没有评审」这个信号不能丢。

## 6. 排查用法

```powershell
$root = "$env:APPDATA\workbench\artifacts\threads"
# 1) 打开索引，按「阶段」找到那一轮（例如 需求澄清）；表里只链 output.md，行内 `·review` 表示有评审报告
notepad "$root\<threadId>\index.md"
# 2) 直接看那一轮给了什么提示词
notepad "$root\<threadId>\runs\<runId>\prompt.md"
# 3) 只抽工具调用
Get-Content "$root\<threadId>\runs\<runId>\transcript.jsonl" |
  ForEach-Object { $_ | ConvertFrom-Json } | Where-Object type -eq 'tool_call'
# 4) 连读思考：thinking 帧按 seq 合并（相邻帧是一段，工具帧/正文帧切断）
Get-Content "$root\<threadId>\runs\<runId>\transcript.jsonl" |
  ForEach-Object { $_ | ConvertFrom-Json } | Where-Object type -eq 'thinking' |
  ForEach-Object { "## seq $($_.seq)`n$($_.text)" }
```

## 7. 已知边界

- **任务/run 删除不清理文件**：`run.removed` 会删投影行，`artifacts/` 下的目录保留
  （正文是审计材料，删了找不回来）。需要清理时按目录时间手工删。
- **运行中崩溃的 run 没有 `meta.json`**：`index.md` 里看不到它，但 `prompt.md` 与
  `run_events` 里的帧仍在；宿主重启对账收尾后不会再补归档（收尾路径不经过 `run.receipt`）。
- `index.md` 时间列是 UTC（与事实日志同源），不做本地时区换算。
