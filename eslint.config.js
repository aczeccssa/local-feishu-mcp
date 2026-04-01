// @ts-check
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import securityPlugin from 'eslint-plugin-security';
import unusedImportsPlugin from 'eslint-plugin-unused-imports';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  // 忽略 node_modules 等
  {
    ignores: ['node_modules/**', 'dist/**', '.husky/**', '*.js', '*.cjs', '.env*'],
  },

  // TypeScript 文件
  {
    files: ['**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint,
      security: securityPlugin,
      'unused-imports': unusedImportsPlugin,
      prettier,
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
    },
    rules: {
      // Prettier（关闭冲突规则）
      ...prettierConfig.rules,
      'prettier/prettier': 'error',

      // 安全规则
      'no-console': 'off',
      'no-debugger': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-no-csrf-before-method-override': 'warn',
      'security/detect-non-literal-fs-filename': 'warn',

      // 未使用 import
      'unused-imports/no-unused-imports': 'error',

      // TypeScript
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
