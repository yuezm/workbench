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
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
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
    files: ['src/main/**/*.{ts,tsx}'],
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
  // 末位关闭所有格式类规则，交给 Prettier
  prettier,
)
