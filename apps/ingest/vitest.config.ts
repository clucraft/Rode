import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'ingest',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
