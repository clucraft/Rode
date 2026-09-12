import { z } from 'zod';

/**
 * Process configuration from the environment. Every variable is documented in
 * .env.example. Secrets never appear in logs (see redact list in app.ts).
 *
 * Source settings from the environment override what is stored in the
 * database, so a compose file can pin RODE_SOURCE=simulator for a demo.
 */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  RODE_HOST: z.string().default('0.0.0.0'),
  RODE_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  RODE_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  RODE_DATA_DIR: z.string().default('/data'),
  /** Override the database path; default <RODE_DATA_DIR>/rode.db. ':memory:' for tests. */
  RODE_DB_FILE: z.string().optional(),
  /** Built web app to serve; unset in development (Vite serves it). */
  RODE_WEB_DIR: z.string().optional(),
  RODE_VERSION: z.string().default('0.0.0-dev'),
  RODE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  /** MapLibre style.json or TileJSON URL for offline charts (the tiles profile). Unset = polar view only. */
  RODE_TILES_URL: z.string().optional(),

  RODE_SOURCE: z
    .enum(['nmea0183-tcp', 'nmea0183-udp', 'signalk-ws', 'simulator', 'replay'])
    .optional(),
  RODE_NMEA_HOST: z.string().optional(),
  RODE_NMEA_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  RODE_SIGNALK_URL: z.string().optional(),
  RODE_SIGNALK_TOKEN: z.string().optional(),
  RODE_SIM_SCENARIO: z.string().optional(),
  RODE_SIM_SPEED: z.coerce.number().min(0.1).max(3600).optional(),
  /** Let the simulator press Drop/Set/Weigh itself, for demos. */
  RODE_SIM_AUTO_COMMANDS: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  RODE_REPLAY_FILE: z.string().optional(),
  // Environment-defined notification targets (an implicit recipient "environment").
  RODE_NTFY_URL: z.string().optional(),
  RODE_NTFY_TOKEN: z.string().optional(),
  RODE_PUSHOVER_USER: z.string().optional(),
  RODE_PUSHOVER_TOKEN: z.string().optional(),
  RODE_TELEGRAM_BOT_TOKEN: z.string().optional(),
  RODE_TELEGRAM_CHAT_ID: z.string().optional(),
  RODE_WEBHOOK_URL: z.string().optional(),
  /** MQTT broker for retained state + notifications, e.g. mqtt://mosquitto:1883 */
  RODE_MQTT_URL: z.string().optional(),
  RODE_MQTT_USERNAME: z.string().optional(),
  RODE_MQTT_PASSWORD: z.string().optional(),
  RODE_MQTT_TOPIC_PREFIX: z.string().default('rode'),
  RODE_SMTP_HOST: z.string().optional(),
  RODE_SMTP_PORT: z.coerce.number().int().optional(),
  RODE_SMTP_USER: z.string().optional(),
  RODE_SMTP_PASS: z.string().optional(),
  RODE_SMTP_FROM: z.string().optional(),
  RODE_HEARTBEAT_EMAIL: z.string().optional(),
  /** Set true when served over TLS: Secure cookies + HSTS. */
  RODE_TLS: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}

/** The subset of settings the environment is allowed to pin. */
export function envSourceOverrides(c: Config): Record<string, unknown> {
  const source: Record<string, unknown> = {};
  if (c.RODE_SOURCE) source.kind = c.RODE_SOURCE;
  if (c.RODE_NMEA_HOST) source.host = c.RODE_NMEA_HOST;
  if (c.RODE_NMEA_PORT) source.port = c.RODE_NMEA_PORT;
  if (c.RODE_SIGNALK_URL) source.signalkUrl = c.RODE_SIGNALK_URL;
  if (c.RODE_SIGNALK_TOKEN) source.signalkToken = c.RODE_SIGNALK_TOKEN;
  if (c.RODE_SIM_SCENARIO) source.simScenario = c.RODE_SIM_SCENARIO;
  if (c.RODE_SIM_SPEED) source.simSpeed = c.RODE_SIM_SPEED;
  if (c.RODE_REPLAY_FILE) source.replayFile = c.RODE_REPLAY_FILE;
  return source;
}
