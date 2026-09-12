import { z } from 'zod';

/**
 * Process configuration from the environment. Every variable is documented in
 * .env.example. Secrets never appear in logs — see redact list in app.ts.
 */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  RODE_HOST: z.string().default('0.0.0.0'),
  RODE_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  RODE_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  RODE_DATA_DIR: z.string().default('/data'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
