---
type: index
status: active
---

# 文档索引

全仓文档的唯一入口。加文档先看这里的分区，不新建目录。

## 按用途找

| 我要…               | 去哪                                                     |
| ------------------- | -------------------------------------------------------- |
| 第一次跑起来        | [仓库 README](../README.md)                              |
| 加插件 / app / 闸门 | [specs/](specs/) + [CAPABILITY-MAP](CAPABILITY-MAP.md)   |
| 模块行为基线        | [specs/](specs/)（每份 SPEC-* 是对应模块的基线）         |
| 命令与阈值          | [CONSTRAINTS](../CONSTRAINTS.md)                         |
| 为什么这样设计      | [ARCHITECTURE](ARCHITECTURE.md)                          |
| 某个决策的来历      | `architecture/decisions/`（目录未建，决策暂散见各 SPEC） |
| 正在做什么          | [planning/](planning/)                                   |
| 已完结的计划        | [planning/archive/](planning/archive/)                   |
| 测试策略与验收      | [testing/](testing/)                                     |
| 复核与例外历史      | [CONSTRAINTS-HISTORY](testing/CONSTRAINTS-HISTORY.md)    |
| 需求与 BUG          | `issues/`                                                |
| 评审导出            | [reviews/](reviews/)                                     |

## frontmatter 只有两个字段

- `type` 决定套哪套阈值与写法：`index` 跳词表检查、`plan` 查归档位置。
- `status` 是"这篇还在不在维护"的唯一信号：`archived` 必须待在 `archive/` 下。
- 不写 `owner`：单人仓里恒为 `lead`，等于常量。
- 不写 `updated`：git 已经记了真实修改时间，手写的那份一定会烂。

## 文档规则

判定命令：`node scripts/doc-lint.mjs docs`。

| 规则             | 阈值                         |
| ---------------- | ---------------------------- |
| 每篇 frontmatter | `type` + `status` 两个字段   |
| 单篇体量         | ≤300 行、≤40KB               |
| 正文单行         | ≤120 字符；>200 直接判 error |
| 表格             | ≤6 列，单元格 ≤80 字符       |
| 标题             | 恰好一个 H1，不跳级          |
| 一条规则一行     | 一行一个断言，分句 ≤2        |
| 元话语与模糊词   | 0 命中                       |
| 相对链接         | 0 死链                       |
| 索引自身         | ≤120 行，只放链接不抄内容    |

阈值不是审美：单元格超过 80 字符时，一条规则就变成不可评审、不可引用的一整行，改实现的人分不清改的是契约还是解释。

## 四类文档的边界

- **tutorial**：跟着做能跑通，不解释原理。
- **how-to**：一个任务怎么做，不铺概念。
- **reference**：是什么、有哪些值、什么命令，不写为什么。
- **explanation**：为什么这样设计、放弃了什么，不放规则条文。

四类之间只允许链接，不许内联引用：理由搬到 explanation，正文只留可判定条目。

## 加一篇文档

1. 选类型，落进已有目录；新目录要先改本文件。
2. 写 frontmatter（`type` + `status: draft`）。
3. 跑 `node scripts/doc-lint.mjs docs`，error 归零。
4. 在本文件「按用途找」加一行。

## 归档

- 计划做完：`status: archived`，移到 `planning/archive/<年>-Q<季>/`，链接重算。
- 规格作废：`status: deprecated` 留原位，正文删到只剩"被谁取代"。
- 历史只追加：复核记录写当期 history 文件，不改旧条目。
