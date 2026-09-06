// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'package-lock.json', '**/test-fixtures/**/*.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'examples/*.ts', 'scripts/*.mjs', '*/*/vitest*.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': 'off',
    },
  },
  {
    // Plain-JS repo scripts: no tsconfig to supply Node's globals, and pulling
    // in the `globals` package for three names is not worth the dependency.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', fetch: 'readonly', process: 'readonly' },
    },
  },
  {
    files: ['**/*.test.ts', '**/test-fixtures/**'],
    rules: {
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
  eslintConfigPrettier,
)
