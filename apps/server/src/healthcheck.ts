/*
 * Docker healthcheck: exit 0 when /readyz says the database is open and the
 * alarm engine is ticking, 1 otherwise. A tiny node process every 30 s costs
 * less than installing curl into the runtime image.
 */
const port = process.env.RODE_PORT ?? '8080';
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 4000);
fetch(`http://127.0.0.1:${port}/readyz`, { signal: controller.signal })
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1))
  .finally(() => clearTimeout(timer));
