# 性能基线（PERF）

> 仪器：`node scripts/bench.mjs [--facts=100000] [--tasks=5000] [--samples=200] [--json]`
> 口径与「别拿它当压测」的边界见脚本头注释：每条写入单独提交并落盘，装载按 `viewSpec` 切片，重建从事实日志全量 fold。

## 怎么跑

```bash
node scripts/bench.mjs                                  # 默认 10 万事实 / 5000 任务 / 200 采样
node scripts/bench.mjs --facts=20000 --tasks=1000 --samples=50
node scripts/bench.mjs --json                           # 机器可读，便于对比历史
```

脚本自己造库、自己删临时目录，不碰 `userData`。仓库当前没有 CI 工作流，nightly 留待 CI 立项后再接。

## 基线（2026-11-14，本机 Windows / Node 22.22 / SQLite WAL + synchronous）

| 指标                               | 实测    |
| ---------------------------------- | ------- |
| 事实条数                           | 100,000 |
| 任务数                             | 5,000   |
| 造数耗时（批量事务）               | 1.4 s   |
| 装载 + decide（`task.updated`）p50 | 47.3 ms |
| 装载 + decide（`task.updated`）p99 | 56.0 ms |
| 装载 + tick（`clock.tick`）p50     | 45.4 ms |
| 装载 + tick（`clock.tick`）p99     | 51.1 ms |
| 全量重建                           | 2.4 s   |
| 启动增量（投影已最新）             | 0.15 ms |
| 库体积                             | 60.5 MB |

## 读法与已知差距

- **启动增量 0.15 ms** 与 **重建 2.4 s** 都还在 ARCHITECTURE 验收表的口径内（`<100 ms`、`<5 s`）。
- **装载 + decide p99 56 ms** 与验收表写的「10 万事实 / 1 万任务 p99 < 8 ms」差约 7 倍。原因是每次决策都把切片里**整表**装进视图（`tasks` 5000 行 ≈ 40 ms），不是内核计算慢。修法是「按需装载」（任务详情只看一棵树、tick 只看活跃任务），属于独立改造，不在 M35–M37 内。
- **增长形态会影响读数**：把增长事实换成 `task.comment_added` 后，`task.comment` 这条切片会装载全部评论，p50 从 47 ms 涨到 430 ms（9.5 万条评论时）。这是切片本身的形状问题，不是回归——基线固定用 `task.updated`，就是为了不把这条异常当成常态。
- 造数必须放进一个事务：WAL + synchronous 下逐条自动提交会把 5000 条拉到 10 秒级，指标失真（第一版踩过）。

## 变更记录

| 日期       | 变更                                                        |
| ---------- | ----------------------------------------------------------- |
| 2026-11-14 | 首版（M36-G）：`scripts/bench.mjs` + 本文件；固定口径与基线 |
