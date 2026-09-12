import { defineConfig } from 'tsup';

// Single-file production bundle. Workspace packages are inlined so the runtime
// image needs only node_modules for native/third-party deps.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  noExternal: [/^@rode\//],
  // Keep native and runtime deps external; they come from node_modules.
  external: ['better-sqlite3'],
});
