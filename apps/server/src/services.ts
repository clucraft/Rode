import path from 'node:path';
import type { Logger } from './logger.js';
import { Bus } from './bus.js';
import { envSourceOverrides, type Config } from './config.js';
import { openDatabase, type Db } from './db/database.js';
import { createRepos, type Repos } from './db/repos.js';
import { Diagnostics } from './diagnostics.js';
import { createAuthRepos } from './auth/repos.js';
import { AuthService } from './auth/service.js';
import { EngineHost } from './engine/host.js';
import { IngestManager } from './ingest/manager.js';
import { Housekeeping, SampleWriter } from './jobs/samples.js';
import { SettingsService } from './settings.js';
import { localHour, type StateDeps } from './state.js';
import type { AppContext } from './context.js';

/*
 * Wires every service together. index.ts calls this once; tests call it with
 * an in-memory database and a fake clock.
 */

const CLEAN_SHUTDOWN = 'clean_shutdown';

export interface Services extends AppContext {
  sampleWriter: SampleWriter;
  housekeeping: Housekeeping;
  /** Mutable so the notification layer (phase 7) can stamp confirmations. */
  notifications: { lastConfirmedAt: number | null };
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ServiceOptions {
  config: Config;
  log: Logger;
  now?: () => number;
  /** Test hook: skip starting the ingest adapter. */
  startIngest?: boolean;
}

export function createServices(opts: ServiceOptions): Services {
  const { config, log } = opts;
  const now = opts.now ?? Date.now;
  const dbFile = config.RODE_DB_FILE ?? path.join(config.RODE_DATA_DIR, 'rode.db');
  const db: Db = openDatabase({ file: dbFile });
  const repos: Repos = createRepos(db);
  const bus = new Bus();

  // Unexpected restart detection: the flag is set on clean shutdown and
  // deleted on boot. Absence at boot means we died with our boots on.
  const bootedAt = now();
  const unexpectedRestart =
    repos.runtime.get('boot_count') !== undefined && repos.runtime.get(CLEAN_SHUTDOWN) !== '1';
  const bootCount = Number(repos.runtime.get('boot_count') ?? '0') + 1;
  repos.runtime.set('boot_count', String(bootCount));
  repos.runtime.set('last_boot_at', String(bootedAt));
  repos.runtime.delete(CLEAN_SHUTDOWN);
  repos.events.append(
    'boot',
    { bootCount, unexpectedRestart, version: config.RODE_VERSION },
    unexpectedRestart ? 'warning' : 'info',
    bootedAt,
  );
  if (unexpectedRestart)
    log.warn({ bootCount }, 'unexpected restart: no clean-shutdown flag from the previous run');

  const settings = new SettingsService(repos.settings, bus, { source: envSourceOverrides(config) });

  const ingest = new IngestManager({
    bus,
    log,
    dataDir: config.RODE_DATA_DIR,
    simAutoCommands: config.RODE_SIM_AUTO_COMMANDS,
    onScriptedCommand: (command) => engine.command(command, 'simulator'),
    now,
  });

  const engine = new EngineHost({
    db,
    repos,
    bus,
    settings,
    log,
    telemetry: (t) => ingest.normalizer.snapshot(t),
    localHour: (t) => localHour(t, settings.view().timeZone),
    now,
  });

  const diagnostics = new Diagnostics(ingest.normalizer, now);
  const auth = new AuthService({
    repos: createAuthRepos(db),
    events: repos.events,
    bus,
    log,
    issuer: () => `Rode (${settings.view().boatName})`,
    now,
  });
  const sampleWriter = new SampleWriter({
    normalizer: ingest.normalizer,
    engine,
    samples: repos.samples,
    log,
    now,
  });
  const housekeeping = new Housekeeping({
    samples: repos.samples,
    log,
    retentionDays: () => config.RODE_RETENTION_DAYS,
    localHour: (t) => localHour(t, settings.view().timeZone),
    now,
  });

  const notifications = { lastConfirmedAt: null as number | null };
  const state: StateDeps = {
    engine,
    ingest,
    repos,
    dbFile,
    bootedAt,
    unexpectedRestart,
    timeZone: () => settings.view().timeZone,
    notificationsLastConfirmedAt: () => notifications.lastConfirmedAt,
    now,
  };

  // Once a minute, note the running max distance on the session row.
  let distanceTimer: NodeJS.Timeout | null = null;

  bus.on('settings:changed', ({ keys }) => {
    if (keys.includes('source')) void ingest.apply(settings.source());
  });

  const services: Services = {
    config,
    db,
    repos,
    bus,
    settings,
    engine,
    ingest,
    diagnostics,
    auth,
    state,
    version: config.RODE_VERSION,
    bootedAt,
    now,
    sampleWriter,
    housekeeping,
    notifications,
    async start() {
      engine.start();
      diagnostics.start();
      sampleWriter.start();
      housekeeping.start();
      distanceTimer = setInterval(() => {
        engine.recordDistance();
        auth.housekeeping();
      }, 60_000);
      distanceTimer.unref();
      if (opts.startIngest !== false) await ingest.apply(settings.source());
      log.info(
        { dbFile, source: settings.source().kind, rehydrated: engine.rehydrated },
        'services started',
      );
    },
    async stop() {
      if (distanceTimer) clearInterval(distanceTimer);
      housekeeping.stop();
      sampleWriter.stop();
      diagnostics.stop();
      await ingest.stop();
      engine.stop();
      repos.runtime.set(CLEAN_SHUTDOWN, '1');
      repos.events.append('shutdown', { clean: true }, 'info', now());
      db.close();
    },
  };
  return services;
}
