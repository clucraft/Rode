// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/dev-dist/**',
      'docs/**',
      '**/types/**/*.d.ts',
      '**/public/**',
      '**/scripts/**/*.cjs',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Safety-critical code: no implicit any, no floating promises.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Numeric formatting and math code legitimately uses these.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Stylistic; fights the `new Promise((resolve) => x.close(resolve))` idiom.
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Path references pull ambient module declarations (types/*.d.ts) into
      // every program that compiles the file, including dependent packages.
      '@typescript-eslint/triple-slash-reference': [
        'error',
        { path: 'always', types: 'never', lib: 'never' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/server/**', 'apps/ingest/**'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/web/**'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // React event handlers may be async; React ignores the returned promise.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    // Command-line entry points print to stdout by design.
    files: ['**/cli.ts', '**/scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Config and test files: relax rules that only add noise there.
    files: ['**/*.config.{js,ts}', '**/*.test.ts', '**/*.spec.ts', '**/test/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
