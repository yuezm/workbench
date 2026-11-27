---
type: review
status: active
---

# 全功能验证（按 features 地图逐条走）

- 被测：`out/server` + `out/web`（`pnpm build` 产物 01:47:49，晚于全部源码改动）
- 实例：`.scratch/verify/audit-b`，`http://127.0.0.1:63945`，pid 8520，v2.0.0 / kernel M57.0.0
- 基线：`doctor` 8/8 `OK`——state、`out/web`、一次性数据目录、进程、`/api/health`、
  `/api/info` 的 pid+dataDir、首页 `<title>`、飞书通道已停用
- 证据：`.scratch/verify/audit-b/artifacts/`（22 张截图 + 4 份 ARIA 快照）
- 驱动脚本：`.agents/skills/verify/scripts/journeys/`（可直接复跑）
- 收尾：`stop` 已执行，pid 8520 不再存活

## 结论

功能地图 5 个功能、30 条 `Driving it with verify` bullet 全部走通：界面动作与落库结果对得上；
设置七个栏目逐栏打开也都有内容、无页面报错。唯一问题出在地图文字（`###` / `##`），已就地改地图。

## 看板与任务流转

| 子功能          | 结果 | 证据                             |
| --------------- | ---- | -------------------------------- |
| `board-columns` | OK   | 6 列，列头「方案 1」带计数       |
| `card-open`     | OK   | 详情渲染标题；「返回」回看板标题 |
| `drag-stage`    | OK   | 落库 `current_stage_id` → 实施   |
| `archive-drop`  | OK   | 归档区 0→1，`archived_at` 非空   |
| `archived-list` | OK   | 弹窗列出该卡（实施 / 进行中）    |

## 新建任务

| 子功能           | 结果 | 证据                                      |
| ---------------- | ---- | ----------------------------------------- |
| `new-dialog`     | OK   | 默认「验证流程 / 待办」，项目只读展示落点 |
| `title-required` | OK   | `role=alert`「任务标题必填」，弹窗不关    |
| `created-lands`  | OK   | 卡片落「待办」列，库内三项一致            |
| `choose-stage`   | OK   | 改「实施」后卡片与库内阶段同步            |
| `brief-modes`    | OK   | 需求 4 字段 → `##` 段头正文               |

## 项目

| 子功能           | 结果 | 证据                                              |
| ---------------- | ---- | ------------------------------------------------- |
| `project-add`    | OK   | 行出现，`projects` 两条                           |
| `project-switch` | OK   | 选中行 `aria-current=page`，另一行不是            |
| `project-edit`   | OK   | 行名与 `projects.name` 同步                       |
| `project-remove` | OK   | 行消失、无残留，任务不被删                        |
| `default-dir`    | OK   | `aria-current=page`、无编辑入口，只显示无项目任务 |

## 设置与服务信息

| 子功能          | 结果 | 证据                                          |
| --------------- | ---- | --------------------------------------------- |
| `settings-nav`  | OK   | 七栏齐全，逐栏 `aria-current=page`            |
| `service-panel` | OK   | 地址 / 数据目录 / 进程号与 `/api/info` 一致   |
| 只读            | OK   | textbox=0、无保存键，文案「设环境变量后重启」 |

## 工作流编辑器

| 子功能            | 结果 | 证据                                     |
| ----------------- | ---- | ---------------------------------------- |
| `wf-new-blank`    | OK   | 草稿 4 个内置阶段，保存入库              |
| `wf-new-template` | OK   | 预填 10 阶段；未选智能体保存被拒，零落库 |
| `wf-edit`         | OK   | 行名与 `workflows.name` 同步             |
| `wf-reorder`      | OK   | 拖动改序，刷新重进设置后仍是该序         |
| `wf-remove`       | OK   | 行消失，库内只剩 `验证流程`              |

## 发现

1. **地图写法与实现不符（已改地图）**：`features/new-task.md` 原文写「带 `###` 段头的正文」，
   实际是 `##`（`task-brief.ts` 的 `serializeBrief`，注释写明段用 `#`、段内小节用 `##`）。
2. **不是缺陷但会被看见**：SOP 模板保存被拒时控制台一条 `500`。`SPEC-server.md` 错误码表
   规定「命令被拒 → 500 + `StoreError.code`」，界面另有就地 `role=alert`，符合规格。

## 这次没覆盖

- 执行中任务 `draggable=false`、归档被内核拒绝（种子阶段全是 `entryMode:none`，没有真 run）。
- 标题 `maxLength`、描述总长上限被拒时的界面提示。
- 模板逐阶段选好智能体后保存成功（无人值守走空白创建）。
- 归档数为 0 时「查看归档」禁用（本次已有 1 条归档）。
- SSE 实时刷新、详情页各区块（阶段历史 / 动态 / 产物）。

## 复现

```bash
pnpm build
node .agents/skills/verify/scripts/verify.mjs launch --run audit-b
node .agents/skills/verify/scripts/verify.mjs doctor --run audit-b
for f in kanban new-task projects settings settings-panels workflow-editor; do
  node .agents/skills/verify/scripts/verify.mjs drive \
    ".agents/skills/verify/scripts/journeys/$f.mjs" --run audit-b
done
node .agents/skills/verify/scripts/verify.mjs stop --run audit-b
```
