---
type: index
status: active
owner: lead
updated: 2026-11-28
---

# 文档索引

全仓文档的唯一入口。加文档先看这里的分区，别新建目录。

## 按用途找

| 我要…                   | 去哪                                                                                          | 类型        |
| ----------------------- | --------------------------------------------------------------------------------------------- | ----------- |
| 第一次跑起来            | `README.md`（仓库根）                                                                         | tutorial    |
| 加一个插件 / app / 闸门 | [specs/](specs/) 对应规格 → [CAPABILITY-MAP](CAPABILITY-MAP.md) 的边界决定                    | how-to      |
| 查某个模块的行为基线    | [specs/](specs/)（kernel / authority / plugins / host / server / shell / ui / ai-workflow …） | reference   |
| 查命令与阈值            | [../CONSTRAINTS.md](../CONSTRAINTS.md)                                                        | reference   |
| 搞懂为什么这样设计      | [ARCHITECTURE](ARCHITECTURE.md)、[CAPABILITY-MAP](CAPABILITY-MAP.md)                          | explanation |
| 查某个决策的来历        | `architecture/decisions/`（新建时；当前决策散见各 SPEC 的「决策」段）                         | adr         |
| 看正在做什么            | [planning/](planning/)                                                                        | plan        |
| 看已完结的计划          | [planning/archive/](planning/archive/)                                                        | plan        |
| 测试策略 / 验收 / 用例  | [testing/](testing/)                                                                          | reference   |
| 复核记录与例外历史      | [testing/CONSTRAINTS-HISTORY](testing/CONSTRAINTS-HISTORY.md)                                 | history     |
| 需求与 BUG              | `issues/`                                                                                     | plan        |
| 评审导出                | [reviews/](reviews/)                                                                          | review      |

## 文档规则

阈值的判定命令统一是 `node tools/doc-lint.mjs docs`；标题与空行规则由 markdownlint 判。

| 规则               | 阈值                                                 |
| ------------------ | ---------------------------------------------------- |
| 每篇有 frontmatter | `type` / `status` / `owner` / `updated` 四字段必填   |
| 单篇体量           | ≤300 行、≤40KB                                       |
| 正文单行           | ≤120 字符；>200 直接判 error                         |
| 表格               | ≤6 列；单元格 ≤80 字符                               |
| 标题               | 恰好一个 H1；不跳级                                  |
| 一条规则一行       | 一行一个断言，分句 ≤2                                |
| 元话语与模糊词     | 0 命中（「值得注意的是」「尽量」「视情况」等）       |
| 相对链接           | 0 死链                                               |
| 索引               | 本篇 ≤120 行                                         |
| 索引与正文         | 索引只放链接，不抄内容；正文不抄 SPEC 原文，只放链接 |

阈值不是审美：单元格超过 80 字符时，一条规则就变成了不可评审、不可引用、不可复用的一整行，改实现的人看不出改的契约还是解释。

## 四类文档的边界

- **tutorial**：跟着做能跑通。不解释原理。
- **how-to**：一个具体任务怎么做。不铺概念。
- **reference**：是什么、有哪些值、什么命令。不写为什么。
- **explanation**：为什么这样设计、放弃了什么。不放规则条文。

**四类之间只允许链接，不允许内联引用**：理由搬到 explanation，正文只留可判定条目。

## 加一篇文档

1. 选类型，落进已有目录；新目录要先改本文件。
2. 写 frontmatter（`type` / `status: draft` / `owner` / `updated`）。
3. 跑 `node tools/doc-lint.mjs docs`，error 归零再提交。
4. 在本文件"按用途找"里加一行索引（索引只加链接，不写摘要）。

## 归档

- 计划做完：`status: archived` + 移到 `planning/archive/<年>-Q<季>/`，链接由脚本重算。
- 规格作废：`status: deprecated` 保留原位，删正文降到只剩"被谁取代"。
- 历史只追加：复核记录写 `testing/CONSTRAINTS-HISTORY`（按季切分后写当期文件），不改旧条目。
