/**
 * 服务端版本号：显示在设置页「服务」一栏与启动日志里。
 *
 * 与 `package.json` 的 `version` 手工同步（构建产物里不会带 `package.json`）。
 * 改版本号的提交要同时改这两处，`tests/server/assembly.test.ts` 会断言两者一致。
 */
export const SERVER_NAME = 'workbench'
export const SERVER_VERSION = '2.0.0'
