import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = buildApp({ config });

// A crash here is loud by design: Docker restarts the container, boot
// rehydrates the anchor session, and the missing clean-shutdown flag
// (phase 7) triggers an "unexpected restart" notification.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

process.on('unhandledRejection', (err) => {
  app.log.fatal({ err }, 'unhandled rejection');
  process.exit(1);
});

try {
  await app.listen({ host: config.RODE_HOST, port: config.RODE_PORT });
} catch (err) {
  app.log.fatal({ err }, 'failed to start');
  process.exit(1);
}
