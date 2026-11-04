import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'out/**', 'dist/**', 'release/**', 'coverage/**', 'scripts/**'],
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
  // 末位关闭所有格式类规则，交给 Prettier
  prettier,
)
