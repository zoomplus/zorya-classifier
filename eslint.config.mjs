import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import promise from 'eslint-plugin-promise'
import unicorn from 'eslint-plugin-unicorn'
import { noDiscardedInterval } from './tools/no-discarded-interval.mjs'
export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', '.run/**', '.husky/_/**', 'benchmarks/cache/**'] },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: {
      promise,
      unicorn,
      lifecycle: { rules: { 'no-discarded-interval': noDiscardedInterval } },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'lifecycle/no-discarded-interval': 'error',
      'require-atomic-updates': ['error', { allowProperties: false }],
      'promise/no-multiple-resolved': 'error',
      'promise/no-return-in-finally': 'error',
      'unicorn/no-await-in-promise-methods': 'error',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
    },
  },
)
