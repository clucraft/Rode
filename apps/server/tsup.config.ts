import { defineConfig } from 'tsup';

// Single-file production bundle of *our* code. Workspace packages are inlined;
// everything from node_modules stays external and is installed by
// `pnpm deploy` in the Docker build. Bundling third-party CommonJS into ESM
// breaks on dynamic requires, so we do not try.
export default defineConfig({
  entry: { index: 'src/index.ts', healthcheck: 'src/healthcheck.ts', backup: 'src/backup.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  skipNodeModulesBundle: true,
  noExternal: [/^@rode\//],
});
