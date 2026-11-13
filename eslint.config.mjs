import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import playwright from 'eslint-plugin-playwright'
import vitest from '@vitest/eslint-plugin'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    // `.scratch/` 是一次性运行日志与临时脚本（AGENTS「一次性运行日志放 .scratch」）：
    // 里面的 .mjs 是排查用的冒烟脚本，不是产品代码，不参与 lint 门禁。
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'scripts/**',
      '.scratch/**',
      // Stryker 变异测试的沙箱目录（源码副本）；中断的运行会留下残留，不能参与 lint 门禁
      '.stryker-tmp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  // React hooks 约束：rules-of-hooks 等由插件 recommended 决定
  reactHooks.configs.flat.recommended,
  // 架构边界（CONSTRAINTS.md「架构边界」维度）：renderer 只能走 window.* 桥接，不得碰 Electron/Node；
  // 依赖方向 renderer → main 单向，main 不得反向 import renderer。
  // 测试目录与源码同构，tests/ 下对应层的用例同样受约束（门禁强度不因搬家而下降）。
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'renderer 禁止直接 import electron，请走 window.workbench / window.aiWorkflow 桥接。',
            },
          ],
          patterns: [
            {
              group: ['node:*', 'fs', 'fs/*', 'path', 'os', 'child_process', 'crypto'],
              message: 'renderer 禁止使用 Node 内置能力，请走 shell 暴露的桥接。',
            },
            {
              group: ['**/src/main/**', '**/main/**'],
              message: 'renderer 不得 import 主进程模块（依赖方向 renderer → main 单向）。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/main/**/*.{ts,tsx}', 'tests/main/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/renderer/**'], message: 'main 不得 import renderer（依赖方向单向）。' },
          ],
        },
      ],
    },
  },
  // 架构边界（ARCHITECTURE「边界守则」/ SPEC-host「目录」）：host 是宿主层，允许依赖
  // protocol / kernel 类型 / sdk（能力面）与 plugins/registry（只经注册表取插件）；
  // 具体插件实现（executors/sources/channels/apps）由装配根 main 组装，host 不得直接 import。
  // 窗口、托盘、IPC 同样在 main，host 不反向 import。
  {
    files: ['src/host/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'host 不直接依赖 Electron：窗口/托盘/IPC 由装配根 main 注入。',
            },
          ],
          patterns: [
            {
              group: [
                '**/src/plugins/executors/**',
                '**/plugins/executors/**',
                '**/src/plugins/sources/**',
                '**/src/plugins/channels/**',
              ],
              message:
                'host 只通过插件注册表取插件，不直接 import 具体插件实现（依赖方向 host → 注册表）。',
            },
            {
              group: ['**/src/main/**', '**/main/**'],
              message: 'host 不得 import 主进程装配层（依赖方向 main → host 单向）。',
            },
            { group: ['**/renderer/**'], message: 'host 不得 import renderer。' },
          ],
        },
      ],
    },
  },
  // 架构边界（ARCHITECTURE「边界守则」/ SPEC-plugins「目录与注册」）：插件只依赖 sdk 与 protocol，
  // 副作用一律经 sdk 注入；不得碰 Electron/Node 内置、宿主内部实现、装配层、渲染层与派生契约类型。
  // 插件之间禁止互相 import 用相对路径表达不了（specifier 里没有 plugins 段），由
  // tests/plugins/boundary.test.ts 的源码扫描兜住；tests/ 与 src/ 同构，强度一致。
  {
    files: ['src/plugins/**/*.{ts,tsx}', 'tests/plugins/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: '插件禁止直接 import electron，副作用只能来自 sdk 注入。',
            },
          ],
          patterns: [
            {
              group: [
                'node:*',
                'fs',
                'fs/*',
                'path',
                'os',
                'child_process',
                'crypto',
                'net',
                'dns',
                'http',
                'https',
              ],
              message: '插件禁用 Node 内置能力：副作用一律经 sdk 注入。',
            },
            {
              group: [
                '**/src/host/**',
                '**/host/**',
                '**/src/main/**',
                '**/main/**',
                '**/renderer/**',
                '**/src/shared/**',
              ],
              message:
                '插件只允许依赖 src/sdk 与 src/protocol（依赖方向 plugins → sdk + protocol）。',
            },
          ],
        },
      ],
    },
  },
  // 边界/注册表用例必须读盘扫描插件源码（与 tests/kernel/purity.test.ts 同款）：只放开读盘用的
  // Node 内置（fs/path），其余门禁照旧——electron、子进程、网络、跨层 import 仍然禁止。
  {
    files: ['tests/plugins/boundary.test.ts', 'tests/plugins/registry.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: '插件测试不得直接依赖 Electron。' }],
          patterns: [
            {
              group: [
                'node:child_process',
                'node:crypto',
                'node:net',
                'node:http',
                'node:https',
                'child_process',
                'crypto',
                'net',
                'http',
                'https',
              ],
              message: '插件测试只允许读盘扫描（fs/path），其余副作用仍走 sdk。',
            },
            {
              group: [
                '**/src/host/**',
                '**/host/**',
                '**/src/main/**',
                '**/main/**',
                '**/renderer/**',
                '**/src/shared/**',
              ],
              message: '插件测试只允许依赖 src/plugins、src/sdk 与 src/protocol。',
            },
          ],
        },
      ],
    },
  },
  // 执行器 detect 的搬家用例验证「插件经 sdk 能力面扫描真实文件系统」：Windows 后缀优先级、
  // POSIX 可执行位这些语义只能在真实 fs 上断言。只放开 fs/os/path 与宿主可执行文件解析
  // （host/executable），electron、子进程、网络、main/renderer/shared 仍然禁止。
  {
    files: ['tests/plugins/executors/**/detect.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: '插件测试不得直接依赖 Electron。' }],
          patterns: [
            {
              group: [
                'node:child_process',
                'child_process',
                'node:crypto',
                'crypto',
                'node:net',
                'net',
                'node:http',
                'node:https',
                'http',
                'https',
              ],
              message: '插件 detect 测试不得启动进程或发起网络请求。',
            },
            {
              group: ['**/src/main/**', '**/main/**', '**/renderer/**', '**/src/shared/**'],
              message: '插件 detect 测试只允许依赖插件、sdk、protocol 与宿主可执行文件解析能力。',
            },
          ],
        },
      ],
    },
  },
  // 架构边界（ARCHITECTURE「边界守则」）：sdk 是插件能力面，只依赖 protocol 的契约类型；
  // 能力原件（子进程、可执行文件解析、时钟）由宿主注入，所以 sdk 不直接碰 Node/Electron。
  // 与 kernel 段不同，这里不限制 Date.now：sdk 的时钟本来就是宿主注入的。
  {
    files: ['src/sdk/**/*.{ts,tsx}', 'tests/sdk/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'electron',
                'node:*',
                'fs',
                'fs/*',
                'path',
                'os',
                'child_process',
                'crypto',
                'net',
                'dns',
                'http',
                'https',
              ],
              message: 'sdk 不直接使用 Node/Electron 能力：原件由宿主注入。',
            },
            {
              group: [
                '**/host/**',
                '**/plugins/**',
                '**/main/**',
                '**/renderer/**',
                '**/shared/**',
              ],
              message: 'sdk 只允许依赖 src/protocol（依赖方向 sdk → protocol）。',
            },
          ],
        },
      ],
    },
  },
  // 架构边界（ARCHITECTURE「边界守则 1」）：kernel 是纯模块，只依赖 src/protocol 的类型；
  // 时间、ID、随机数由宿主在边界传入，所以连 Date.now / Math.random 也禁。
  {
    files: ['src/kernel/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'electron',
                'node:*',
                'fs',
                'fs/*',
                'path',
                'os',
                'child_process',
                'crypto',
                'net',
                'dns',
                'http',
                'https',
              ],
              message: 'kernel 禁止使用宿主/Node 能力：时间与 ID 由宿主在边界传入。',
            },
            {
              group: [
                '**/shared/**',
                '**/main/**',
                '**/host/**',
                '**/plugins/**',
                '**/renderer/**',
              ],
              message: 'kernel 只允许依赖 src/protocol 的类型。',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'kernel 不读时钟：now 由宿主传入。' },
        { object: 'Math', property: 'random', message: 'kernel 不取随机数：ID 由宿主生成。' },
      ],
      'no-restricted-globals': ['error', { name: 'fetch', message: 'kernel 不发起网络请求。' }],
    },
  },
  // kernel 的纯度测试要读盘扫描源码，测试文件放开上面三条限制。
  {
    files: ['tests/kernel/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-globals': 'off',
    },
  },
  // 独立子进程脚本（M24）：`receipt-mcp-server.cjs` 不在插件进程里跑，是宿主用
  // ELECTRON_RUN_AS_NODE 拉起的 stdio 服务（插件运行时协议里外部插件也是这个形态）。
  // 它不是 TS 模块，CommonJS 的 require/module/process 在这里是合法写法。
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-restricted-imports': 'off',
    },
  },
  // 回执工具 server 的契约测试必须真起一个子进程按 MCP stdio 说话——被测对象本身就是
  // 独立进程，只能在进程外断言。只放开起进程用的三个内置（子进程/按行读/取脚本路径），
  // electron、网络与跨层 import 仍然禁止。
  {
    files: ['tests/plugins/shared/receipt-mcp-server.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:crypto',
                'node:net',
                'node:http',
                'node:https',
                'crypto',
                'net',
                'http',
                'https',
              ],
              message: '回执 server 契约测试只允许起本地子进程，不得发起网络请求。',
            },
            {
              group: [
                'electron',
                '**/src/host/**',
                '**/host/**',
                '**/src/main/**',
                '**/main/**',
                '**/renderer/**',
                '**/src/shared/**',
              ],
              message: '回执 server 契约测试只依赖 src/plugins 与 src/protocol。',
            },
          ],
        },
      ],
    },
  },
  // 断言强度（防假绿）：覆盖率与「全绿」都证明不了断言有效，但有一类失败是纯机械可查的——
  // 空断言、漏 await 的断言、被跳过（skip / fixme）的用例、断言写在 if 分支里、`isVisible()`
  // 取布尔再断言这类「看起来绿、实际证明不了任何事」的写法。这里用两个上游插件把它们变成 lint 命中：
  // - playwright 插件只对 e2e 用例生效（`tests/e2e/**/*.spec.ts`，真起 Electron）；
  // - vitest 插件只对单测/集成用例生效（`tests/**/*.test.{ts,tsx}`）。
  // 严重度沿用上游 recommended，下面两处按本仓库口径调整（都不是放松门禁的理由）；
  // `expect-expect` 提到 error——没有断言的用例等于没写用例，这是本段唯一加严的地方。
  {
    files: ['tests/e2e/**/*.spec.ts'],
    ...playwright.configs['flat/recommended'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      'playwright/expect-expect': 'error',
    },
  },
  {
    files: ['tests/**/*.test.{ts,tsx}'],
    ...vitest.configs.recommended,
    rules: {
      ...vitest.configs.recommended.rules,
      // vitest 的 `expect(value, message)` 是合法签名（失败时把 message 打出来），
      // 本仓库大量用它标注「哪个键、哪条规则」——上游默认 maxArgs=1 会误报。
      'vitest/valid-expect': ['error', { maxArgs: 2, minArgs: 1 }],
      // 断言包在 if / 循环里：本仓库的性质用例（fast-check 随机生成）与表驱动用例
      // 本来就按生成物的形状分支断言，逐条改写成不断言的形态只会让断言更难读。
      // 降到 warn 仍会出现在 lint 输出里，但不阻断；真·空转用例由 expect-expect 兜住。
      'vitest/no-conditional-expect': 'warn',
      // 没有断言的用例等于没写用例。默认只认 `expect`，本仓库另有包装断言
      // （`expectDispatched` 断言「这条命令被派发过」）与类型级断言 `expectTypeOf`。
      'vitest/expect-expect': [
        'error',
        { assertFunctionNames: ['expect', 'expectDispatched', 'expectTypeOf'] },
      ],
    },
  },
  // 末位关闭所有格式类规则，交给 Prettier
  prettier,
)
