import { buildApp, mountApp, readinessFor } from './app.js';
import { loadConfig } from './config.js';
import { createServices } from './services.js';

/*
 * Process entry point. Order matters:
 *   1. services (database, engine rehydration, ingest) come up first so the
 *      watch is running before we accept a single request
 *   2. then the API listens
 *
 * A crash here is loud by design: Docker restarts the container, boot
 * rehydrates the anchor session, and the missing clean-shutdown flag makes
 * the next boot log and (phase 7) notify an unexpected restart.
 */

const config = loadConfig();
const bootstrap = buildApp({ config });
const log = bootstrap.log;

const services = createServices({ config, log });
const app = buildApp({ config, readiness: readinessFor(services) });
await mountApp(app, services);
await bootstrap.close();

let shuttingDown = false;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await services.stop();
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    code = 1;
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

process.on('unhandledRejection', (err) => {
  app.log.fatal({ err }, 'unhandled rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  // Persist what we can and exit fast; the supervisor restarts us.
  app.log.fatal({ err }, 'uncaught exception');
  try {
    services.engine.stop();
  } catch {
    // best effort
  }
  process.exit(1);
});

try {
  await services.start();
  await app.listen({ host: config.RODE_HOST, port: config.RODE_PORT });
  app.log.info({ port: config.RODE_PORT, version: config.RODE_VERSION }, 'rode is up');
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
