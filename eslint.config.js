// ESLint 9 flat config
// 迁移自 .eslintrc.json（2026-08-25）
const js = require('@eslint/js');
const tseslint = require('@typescript-eslint/eslint-plugin');
const importPlugin = require('eslint-plugin-import');
const eslintComments = require('eslint-plugin-eslint-comments');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  {
    name: 'global-ignores',
    ignores: [
      '**/node_modules/**',
      'build/**',
      'coverage/**',
      'examples/**',
      'scripts/**',
      'dist/**',
      'test-reports/**'
    ]
  },

  // eslint:recommended（eslint 9 内置规则集）
  js.configs.recommended,

  // eslint-plugin-eslint-comments（flat config 需手动注册插件）
  {
    name: 'eslint-comments',
    plugins: { 'eslint-comments': eslintComments },
    rules: {
      'eslint-comments/disable-enable-pair': ['error', { allowWholeFile: true }],
      'eslint-comments/no-aggregating-enable': 'error',
      'eslint-comments/no-duplicate-disable': 'error',
      'eslint-comments/no-unlimited-disable': 'error',
      'eslint-comments/no-unused-enable': 'error',
      'eslint-comments/no-unused-disable': 'warn'
    }
  },

  // @typescript-eslint recommended（flat 版）
  ...tseslint.configs['flat/recommended'],

  // eslint-plugin-import：仅 typescript 支持（与旧 .eslintrc 的 plugin:import/typescript 一致，不开 recommended 规则组）
  importPlugin.flatConfigs.typescript,

  // 关闭与 prettier 冲突的格式规则（放最后）
  prettier,

  // 项目自身的 TS 配置与规则覆盖
  {
    name: 'aiplugin4-typescript',
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname
      },
      globals: {
        ...globals.es2021,
        console: 'readonly'
      }
    },
    rules: {
      'no-useless-escape': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'sort-imports': ['error', { ignoreDeclarationSort: true, ignoreCase: true }],
      'import/order': ['error', { 'newlines-between': 'always', alphabetize: { order: 'asc' } }]
    }
  }
];
