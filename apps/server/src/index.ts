/**
 * 服务进程入口（服务器部署形态）。
 *
 * 一个进程干完原来 Electron 主进程 + 窗口的所有事：装配内核与插件、起 HTTP/SSE 服务、
 * 同源托管 Web 产物。没有窗口、没有托盘、没有单实例锁——需要常驻就交给进程管理器
 * （systemd / pm2 / docker），需要几个实例就起几个（各自一个数据目录）。
 *
 * 启动成功会打印一行固定格式：
 *
 *   workbench listening on http://127.0.0.1:3000
 *
 * e2e 与运维脚本按这一行取实际地址（`WORKBENCH_PORT=0` 时端口由系统分配）。
 */
import { fileURLToPath } from 'node:url'
import { startIfDirect } from './lifecycle'

/**
 * 只有「被直接执行」才启动（`node out/server/index.js`）。
 *
 * 判据是「进程入口脚本就是本文件」：被测试 import、被别的模块 require 时都不成立，
 * 因此不会真的绑端口、占数据目录。判据本体在 `lifecycle.ts#isDirectRun`，
 * 真假两支都能单测到（这里只负责把两个路径递进去）。
 */
startIfDirect({ entry: fileURLToPath(import.meta.url), argv: process.argv[1] })
