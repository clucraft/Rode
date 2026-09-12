import { z } from 'zod';

/**
 * Response shape for GET /healthz and GET /readyz.
 *
 * `healthz` answers "is the process alive"; `readyz` answers "is it safe to
 * route traffic here" (database open, alarm engine ticking). Docker healthchecks
 * use readyz so a wedged engine gets the container restarted.
 */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded', 'fail']),
  service: z.string(),
  version: z.string(),
  /** Milliseconds since the process started. */
  uptimeMs: z.number().nonnegative(),
  /** Free-form per-check status; keys are check names. */
  checks: z.record(z.string(), z.enum(['ok', 'fail'])).default({}),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
