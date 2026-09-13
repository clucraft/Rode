import path from 'node:path';
import type { Logger } from './logger.js';
import { Bus } from './bus.js';
import { Clock } from './clock.js';
import { envSourceOverrides, type Config } from './config.js';
import { openDatabase, type Db } from './db/database.js';
import { createRepos, type Repos } from './db/repos.js';
import { Diagnostics } from './diagnostics.js';
import { createAuthRepos } from './auth/repos.js';
import { AuthService } from './auth/service.js';
import { Dispatcher } from './notify/dispatcher.js';
import { Heartbeat } from './notify/heartbeat.js';
import { MqttPublisher } from './notify/mqtt.js';
import { Supervisor } from './supervisor.js';
import type { ChannelTarget, Recipient } from '@rode/protocol';
import { EngineHost } from './engine/host.js';
import { ImageryService } from './imagery/service.js';
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
  supervisor: Supervisor;
  mqtt: MqttPublisher | null;
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
  // Test hook: an injected clock is trusted as-is. In production the Clock
  // falls back to GPS time when the system clock is implausible.
  const clock = new Clock(opts.now ?? Date.now);
  const now = opts.now ?? (() => clock.now());
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
    now,
  });

  clock.attach(ingest.normalizer);
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

  // ---- notifications
  const envRecipient = envRecipientFrom(config);
  const dispatcher = new Dispatcher({
    settingsRepo: repos.settings,
    events: repos.events,
    bus,
    log,
    envRecipient,
    units: () => settings.units(),
    boatName: () => settings.view().boatName,
    now,
  });
  if (config.RODE_SMTP_HOST && !dispatcher.getSettings().smtp.host) {
    dispatcher.updateSettings({
      ...dispatcher.getSettings(),
      smtp: {
        host: config.RODE_SMTP_HOST,
        port: config.RODE_SMTP_PORT ?? 587,
        secure: (config.RODE_SMTP_PORT ?? 587) === 465,
        user: config.RODE_SMTP_USER ?? '',
        pass: config.RODE_SMTP_PASS ?? '',
        from: config.RODE_SMTP_FROM ?? config.RODE_SMTP_USER ?? '',
      },
    });
  }
  const heartbeat = new Heartbeat({
    dispatcher,
    runtime: repos.runtime,
    normalizer: ingest.normalizer,
    engineState: () => engine.getState(),
    bootedAt,
    boatName: () => settings.view().boatName,
    timeZone: () => settings.view().timeZone,
    sourceView: () => ingest.view(),
    gpsSynced: () => ingest.normalizer.getGpsTime() !== null,
    log,
    now,
  });
  const supervisor = new Supervisor({
    engine,
    events: repos.events,
    dispatcher,
    log,
    boatName: () => settings.view().boatName,
    now,
  });
  const mqttPublisher = config.RODE_MQTT_URL
    ? new MqttPublisher({
        url: config.RODE_MQTT_URL,
        username: config.RODE_MQTT_USERNAME,
        password: config.RODE_MQTT_PASSWORD,
        topicPrefix: config.RODE_MQTT_TOPIC_PREFIX,
        bus,
        log,
        engineState: () => engine.getState(),
        now,
      })
    : null;

  const imagery = new ImageryService({
    sources: () => settings.imagery(),
    mbtilesDir: config.RODE_MBTILES_DIR ?? path.join(config.RODE_DATA_DIR, 'mbtiles'),
    cacheDir: path.join(config.RODE_DATA_DIR, 'tile-cache'),
    log,
    now,
    userAgent: `Rode/${config.RODE_VERSION}`,
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
    clockSource: () => clock.source(),
    notificationsLastConfirmedAt: () =>
      dispatcher.getStats().lastConfirmedAt ?? notifications.lastConfirmedAt,
    prefs: () => settings.prefs(),
    now,
  };

  // Once a minute, note the running max distance on the session row.
  let distanceTimer: NodeJS.Timeout | null = null;

  bus.on('settings:changed', ({ keys }) => {
    if (keys.includes('source')) void ingest.apply(settings.source());
    // Thresholds are read live; the circle is derived once, so re-derive it.
    if (keys.includes('alarm') || keys.includes('boat'))
      engine.command({ type: 'recompute' }, 'settings');
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
    notify: { dispatcher, heartbeat, envRecipient },
    state,
    imagery,
    version: config.RODE_VERSION,
    bootedAt,
    now,
    sampleWriter,
    housekeeping,
    supervisor,
    mqtt: mqttPublisher,
    notifications,
    async start() {
      dispatcher.start();
      engine.start();
      diagnostics.start();
      sampleWriter.start();
      housekeeping.start();
      heartbeat.start();
      supervisor.start();
      mqttPublisher?.start();
      // An unexpected restart while the owner is away is exactly the thing
      // not to paper over.
      if (unexpectedRestart) {
        dispatcher.notify({
          at: now(),
          severity: 'warning',
          title: `${settings.view().boatName}: Rode restarted unexpectedly`,
          body: `The box came back up without a clean shutdown (boot ${bootCount}). ${engine.rehydrated ? 'The anchor session was restored and the watch resumed.' : 'No anchor session was active.'}`,
          data: { event: 'unexpected-restart', bootCount },
        });
      }
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
      supervisor.stop();
      heartbeat.stop();
      await dispatcher.stop();
      await mqttPublisher?.stop();
      housekeeping.stop();
      sampleWriter.stop();
      diagnostics.stop();
      await ingest.stop();
      clock.detach();
      imagery.close();
      engine.stop();
      repos.runtime.set(CLEAN_SHUTDOWN, '1');
      repos.events.append('shutdown', { clean: true }, 'info', now());
      db.close();
    },
  };
  return services;
}

/** An implicit recipient built from RODE_NTFY_URL & co, so a compose file alone can configure push. */
export function envRecipientFrom(c: Config): Recipient | null {
  const channels: ChannelTarget[] = [];
  if (c.RODE_NTFY_URL)
    channels.push({
      kind: 'ntfy',
      enabled: true,
      severities: ['info', 'warning', 'critical'],
      url: c.RODE_NTFY_URL,
      token: c.RODE_NTFY_TOKEN ?? '',
    });
  if (c.RODE_PUSHOVER_USER && c.RODE_PUSHOVER_TOKEN)
    channels.push({
      kind: 'pushover',
      enabled: true,
      severities: ['info', 'warning', 'critical'],
      token: c.RODE_PUSHOVER_TOKEN,
      user: c.RODE_PUSHOVER_USER,
    });
  if (c.RODE_TELEGRAM_BOT_TOKEN && c.RODE_TELEGRAM_CHAT_ID)
    channels.push({
      kind: 'telegram',
      enabled: true,
      severities: ['info', 'warning', 'critical'],
      botToken: c.RODE_TELEGRAM_BOT_TOKEN,
      chatId: c.RODE_TELEGRAM_CHAT_ID,
    });
  if (c.RODE_WEBHOOK_URL)
    channels.push({
      kind: 'webhook',
      enabled: true,
      severities: ['info', 'warning', 'critical'],
      url: c.RODE_WEBHOOK_URL,
      headers: {},
    });
  if (c.RODE_MQTT_URL)
    channels.push({
      kind: 'mqtt',
      enabled: true,
      severities: ['info', 'warning', 'critical'],
      url: c.RODE_MQTT_URL,
      username: c.RODE_MQTT_USERNAME ?? '',
      password: c.RODE_MQTT_PASSWORD ?? '',
      topicPrefix: c.RODE_MQTT_TOPIC_PREFIX,
    });
  if (c.RODE_HEARTBEAT_EMAIL)
    channels.push({
      kind: 'email',
      enabled: true,
      severities: ['info'],
      to: c.RODE_HEARTBEAT_EMAIL,
    });
  if (channels.length === 0) return null;
  return { id: 'env', name: 'environment', enabled: true, channels };
}
