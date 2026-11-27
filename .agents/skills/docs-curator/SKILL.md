---
name: docs-curator
description: 检查并调整项目文档的结构与冗余：跑零依赖体检器，按风险分级修复（机械修复直接做、内容瘦身逐篇做、目录搬迁先问），交前后对比。当用户说"文档乱了/太啰嗦/整理文档/检查文档/归档一下"，或新增、归档文档后要验证结构时用。
---

# /docs-curator

## 判定器

```bash
node scripts/doc-lint.mjs docs          # 人读摘要
node scripts/doc-lint.mjs docs --json    # 全量明细
```

每条 finding 带 `rule`，按 rule 决定手法，不要凭感觉改。规则与阈值的真相源是 `docs/README.md` 的「文档规则」表；阈值有分歧时改那张表，不改脚本。

## 三档处理

先按 rule 归类，再按档执行。**不准跳档**：机械档没清零就做内容档，等于在错的骨架上刷墙。

### 第 1 档 机械修复（直接做，无需确认）

| rule | 手法 |
| ---- | ---- |
| `fm-missing` / `fm-field-missing` | 补 `type` / `status`，type 按目录推断：`specs/`→spec、`planning/`→plan、`reviews/`→review、架构类→explanation、清单类→reference。不写 `owner` / `updated`：单人仓里 owner 恒定，时间查 git |
| `link-broken` | 相对路径按当前文件位置重算；目标已删除则降级为纯文本并注明"文件已移除" |
| `h1-multi` / `h1-missing` | 多余 H1 降级为 H2；代码块内的 `#` 不算标题（脚本已跳过） |
| `heading-jump` | 补中间层级 |
| `archive-misplaced` / `archive-mismatch` | plan 完结 → `status: archived` + 移入 `planning/archive/<年>-Q<季>/`；移动后重算全部相对链接 |
| `index-missing` / `index-too-long` | 建或瘦身 `docs/README.md`，只放链接与规则表 |
| `fm-date-format` | 统一 `YYYY-MM-DD` |
| `meta-talk` / `vague-word` | 删词；模糊词改成数字或明确条件（"尽量快" → "p95 < 200ms"） |

### 第 2 档 内容瘦身（逐篇做，一篇一提交）

| rule | 手法 |
| ---- | ---- |
| `cell-too-long` | 该行从表格里摘出来改成 `### 规则名` + 列表；表格单元格只放键，不放整段 |
| `line-too-long` / `line-long` | 按分句拆行，一行一个断言；"为什么"搬到 explanation 或 ADR，正文只留结论 |
| `size-lines` / `size-bytes` | 按 H2 主题切分成多篇，在原位置留一行链接；不新增目录 |
| `table-too-wide` | 竖表转竖向键值列表（`- 字段：值`） |
| `heading-duplicate` | 同义标题只在一个文件保留，其他文件改成链接 |
| `dup-paragraph` | 找主副本，其余逐字段落改链接；主副本放在"最常被读"的那篇 |

瘦身时不许删：阈值数字、命令、边界条件、失败表现、字段名。删的只有重复句、元话语、与真相源重复的抄录。

### 第 3 档 需要人决策（先问再做）

只在这三种情况下停：

1. **跨目录搬迁**（如 `specs/` → `reference/specs/`）：改动会波及 `AGENTS.md`、代码注释、测试断言、外部文档链接，破坏面不可预估。
2. **合并两篇内容有冲突的文档**：谁对谁错需要业务判断。
3. **删除整篇**：内容可能还有引用价值。

问法固定：给出"改什么、影响几个文件、回滚方式"，不要给开放式选项。

## 执行顺序

1. 跑 `--json` 存基线到 `.scratch/lint-before.json`。
2. 第 1 档全部做完，复跑，确认结构类 rule 归零。
3. 第 2 档按 error 数排序逐篇做；每篇做完复跑该文件相关 rule。
4. 第 3 档列出来给人，不动手。
5. 收尾：复跑全量，出前后对比表（error/warn/按 rule 计数、最大文件、最长行、死链数、frontmatter 覆盖率）。

## 硬约束

- 不为过闸放松阈值。阈值高就减内容，不改脚本。
- 不在同一提交里同时做"搬家"和"重写"。
- 移动文件必须同批修链接，否则等于制造死链。
- 判据存疑时先只报不改：宁可留一条 error，不要改错一条事实。
