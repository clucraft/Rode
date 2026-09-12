import { defineConfig } from 'vitest/config';

// Root config drives every workspace package as a vitest "project" so a single
// `pnpm test` runs the whole repo and CI has one thing to call.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/index.ts'],
    },
  },
});
