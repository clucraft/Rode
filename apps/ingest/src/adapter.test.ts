import { describe, expect, it } from 'vitest';
import type { ConnectionState } from './adapter.js';

describe('ConnectionState', () => {
  it('discriminates on kind', () => {
    const s: ConnectionState = { kind: 'connecting', attempt: 3, nextRetryMs: 8000 };
    expect(s.kind).toBe('connecting');
  });
});
