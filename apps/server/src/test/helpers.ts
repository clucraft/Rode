import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { degToRad, destination, type LatLon } from '@rode/core';
import { encodeDPT, encodeGGA, encodeHDT, encodeMWV, encodeRMC, encodeVTG } from '@rode/ingest';
import { loadConfig, type Config } from '../config.js';
import { createServices, type Services } from '../services.js';

/*
 * Test scaffolding: services on a temp database with a controllable clock,
 * and a way to feed the normaliser a realistic second of NMEA.
 */

export const ANCHOR: LatLon = { lat: 32.29, lon: -64.83 };

export class FakeClock {
  constructor(public t = Date.UTC(2026, 8, 11, 3, 0, 0)) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface TestEnv {
  services: Services;
  clock: FakeClock;
  config: Config;
  dir: string;
  cleanup: () => Promise<void>;
  /** Boot a second services instance on the same database, as after a restart. */
  reboot: (opts?: { clean?: boolean }) => Promise<Services>;
}

export async function testEnv(overrides: Partial<Record<string, string>> = {}): Promise<TestEnv> {
  const dir = mkdtempSync(path.join(tmpdir(), 'rode-test-'));
  const clock = new FakeClock();
  const config = loadConfig({
    NODE_ENV: 'test',
    RODE_LOG_LEVEL: 'fatal',
    RODE_DATA_DIR: dir,
    RODE_SOURCE: 'nmea0183-tcp',
    RODE_NMEA_HOST: '127.0.0.1',
    RODE_NMEA_PORT: '1',
    ...overrides,
  });
  const log = pino({ level: 'silent' });
  const make = () => createServices({ config, log, now: clock.now, startIngest: false });
  let services = make();
  await services.start();
  const others: Services[] = [];
  return {
    services,
    clock,
    config,
    dir,
    async reboot(opts = {}) {
      if (opts.clean ?? false) await services.stop();
      else services.db.close(); // simulate a power cut: no clean-shutdown flag
      services = make();
      others.push(services);
      await services.start();
      return services;
    },
    async cleanup() {
      for (const s of [services, ...others]) {
        try {
          if (s.db.open) await s.stop();
        } catch {
          // already stopped
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Scene {
  /** Bow-roller position; antenna offset is zero in tests unless boat geometry says otherwise. */
  position?: LatLon;
  sog?: number;
  cog?: number;
  heading?: number;
  depth?: number;
  awa?: number;
  aws?: number;
  hdop?: number;
}

/** Feed one second of sentences describing `scene` at the clock's current time. */
export function feed(services: Services, clock: FakeClock, scene: Scene = {}): void {
  const n = services.ingest.normalizer;
  const now = clock.now();
  const pos = scene.position ?? ANCHOR;
  const fix = {
    epochMs: now,
    lat: pos.lat,
    lon: pos.lon,
    sog: scene.sog ?? 0.1,
    cog: scene.cog ?? 0,
    hdop: scene.hdop ?? 1,
  };
  n.setSourceState({ connected: true, since: now - 60_000 });
  for (const line of [
    encodeRMC(fix),
    encodeGGA(fix),
    encodeVTG(fix.cog, fix.sog),
    encodeHDT(scene.heading ?? 0),
    encodeDPT((scene.depth ?? 5) - 0.3, 0.3),
    encodeMWV(scene.awa ?? 0, scene.aws ?? 6),
  ]) {
    n.feedLine(line, now, 'test');
  }
}

/** Advance the clock one second at a time, feeding and ticking. */
export function run(
  services: Services,
  clock: FakeClock,
  seconds: number,
  scene: Scene | ((i: number) => Scene) = {},
): void {
  for (let i = 0; i < seconds; i++) {
    clock.advance(1000);
    feed(services, clock, typeof scene === 'function' ? scene(i) : scene);
    services.engine.tick();
  }
}

export function at(bearingDeg: number, distance: number): LatLon {
  return destination(ANCHOR, degToRad(bearingDeg), distance);
}
