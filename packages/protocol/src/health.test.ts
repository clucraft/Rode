import { describe, expect, it } from 'vitest';
import { HealthResponse } from './health.js';

describe('HealthResponse', () => {
  it('accepts a minimal ok payload', () => {
    const parsed = HealthResponse.parse({
      status: 'ok',
      service: 'server',
      version: '0.0.0',
      uptimeMs: 12,
    });
    expect(parsed.checks).toEqual({});
  });

  it('rejects an unknown status', () => {
    expect(() =>
      HealthResponse.parse({ status: 'meh', service: 'server', version: '0', uptimeMs: 0 }),
    ).toThrow();
  });
});
