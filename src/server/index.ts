/**
 * 服务进程入口（服务器部署形态）。
 *
 * 一个进程干完原来 Electron 主进程 + 窗口的所有事：装配内核与插件、起 HTTP/SSE 服务、
 * 同源托管 Web 产物。没有窗口、没有托盘、没有单实例锁——需要常驻就交给进程管理器
 * （systemd / pm2 / docker），需要几个实例就起几个（各自一个数据目录）。
 *
 * 启动成功会打印一行固定格式：
 *
 *   workbench listening on http://127.0.0.1:7788
 *
 * e2e 与运维脚本按这一行取实际地址（`WORKBENCH_PORT=0` 时端口由系统分配）。
 * 行为全在 `lifecycle.ts`（可测），这里只负责「跑起来」与「失败报告」。
 */
import { reportStartupError, runServerEntry } from './lifecycle'

/**
 * 只有「直接执行」才启动。
 *
 * 构建产物是 CJS（`node out/server/index.js`），直接执行时 `require.main === module`；
 * 被测试 import 时 `require.main` 是测试运行器，因此不会真的绑端口、占数据目录。
 */
const isDirectRun =
  typeof require === 'function' && (require as NodeJS.Require).main === (module as unknown)

if (isDirectRun) runServerEntry().catch(reportStartupError)
