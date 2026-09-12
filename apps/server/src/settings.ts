import {
  ALARM_CONFIG_DOCS,
  DEFAULT_ALARM_CONFIG,
  DEFAULT_MARINA_CONFIG,
  resolveAlarmConfig,
  type AlarmConfig,
  type BoatGeometry,
  type MarinaConfig,
} from '@rode/core';
import { SettingsView, type SettingsPatch, type SourceSettings, type Units } from '@rode/protocol';
import type { Bus } from './bus.js';
import type { SettingsRepo } from './db/repos.js';

/*
 * Typed settings on top of the key/value table. Defaults live here; the
 * database only stores what the owner changed. Alarm thresholds are validated
 * against the documented min/max so a fat finger cannot set a 0 m radius.
 */

const DEFAULTS: SettingsView = {
  boat: { antennaToBowForward: 0, antennaToBowStarboard: 0, bowRollerHeight: 1 },
  units: { distance: 'm', depth: 'm', speed: 'kn', temperature: 'C', rode: 'm' },
  source: {
    kind: 'nmea0183-tcp',
    host: '192.168.1.100',
    port: 39150,
    signalkUrl: '',
    signalkToken: '',
    simScenario: 'quiet-night',
    simSpeed: 1,
    replayFile: '',
    transducerDepth: 0,
    magneticVariationDeg: null,
  },
  alarm: { ...DEFAULT_ALARM_CONFIG },
  marina: { ...DEFAULT_MARINA_CONFIG },
  suggestedScope: 5,
  boatName: 'Rode',
  timeZone: 'UTC',
  nightMode: { mode: 'auto', from: '20:00', to: '06:00' },
};

/** Drop undefined keys so a partial override never clobbers a value with undefined. */
function defined<T extends object>(obj: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!obj) return out;
  for (const [k, v] of Object.entries(obj))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

export class SettingsService {
  private cache: SettingsView;

  constructor(
    private readonly repo: SettingsRepo,
    private readonly bus: Bus,
    /** Environment overrides applied on top of the database (e.g. RODE_SOURCE). */
    private readonly envOverrides: Partial<SettingsPatch> = {},
  ) {
    this.cache = this.load();
  }

  private load(): SettingsView {
    const stored = this.repo.all() as Partial<SettingsView>;
    // Shape is enforced by the zod parse below, not by TypeScript here.
    const merged: Record<string, unknown> = {
      boat: { ...DEFAULTS.boat, ...defined(stored.boat), ...defined(this.envOverrides.boat) },
      units: { ...DEFAULTS.units, ...defined(stored.units), ...defined(this.envOverrides.units) },
      source: {
        ...DEFAULTS.source,
        ...defined(stored.source),
        ...defined(this.envOverrides.source),
      },
      alarm: { ...DEFAULTS.alarm, ...defined(stored.alarm), ...defined(this.envOverrides.alarm) },
      marina: {
        ...DEFAULTS.marina,
        ...defined(stored.marina),
        ...defined(this.envOverrides.marina),
      },
      suggestedScope: stored.suggestedScope ?? DEFAULTS.suggestedScope,
      boatName: stored.boatName ?? DEFAULTS.boatName,
      timeZone: stored.timeZone ?? DEFAULTS.timeZone,
      nightMode: { ...DEFAULTS.nightMode, ...stored.nightMode },
    };
    // Validate what came out of the database; fall back to defaults on junk.
    const parsed = SettingsView.safeParse(merged);
    return parsed.success ? parsed.data : { ...DEFAULTS };
  }

  view(): SettingsView {
    return this.cache;
  }

  boat(): BoatGeometry {
    return this.cache.boat;
  }

  units(): Units {
    return this.cache.units;
  }

  source(): SourceSettings {
    return this.cache.source;
  }

  alarm(): AlarmConfig {
    return resolveAlarmConfig(this.cache.alarm);
  }

  marina(): MarinaConfig {
    return { ...DEFAULT_MARINA_CONFIG, ...(this.cache.marina as Partial<MarinaConfig>) };
  }

  suggestedScope(): number {
    return this.cache.suggestedScope;
  }

  /**
   * Apply a patch. Alarm values are clamped to their documented ranges and
   * unknown keys dropped. Returns the keys that changed.
   */
  patch(patch: SettingsPatch, now = Date.now()): string[] {
    const changed: string[] = [];
    const write = (key: keyof SettingsView, value: unknown) => {
      this.repo.set(key, value, now);
      changed.push(key);
    };
    if (patch.boat) write('boat', { ...this.cache.boat, ...patch.boat });
    if (patch.units) write('units', { ...this.cache.units, ...patch.units });
    if (patch.source) write('source', { ...this.cache.source, ...patch.source });
    if (patch.alarm) {
      const next: Record<string, number> = { ...this.cache.alarm };
      for (const [k, v] of Object.entries(patch.alarm)) {
        if (!(k in ALARM_CONFIG_DOCS) || !Number.isFinite(v)) continue;
        const doc = ALARM_CONFIG_DOCS[k as keyof AlarmConfig];
        const lo = doc.min ?? Number.NEGATIVE_INFINITY;
        const hi = doc.max ?? Number.POSITIVE_INFINITY;
        next[k] = Math.min(hi, Math.max(lo, v));
      }
      write('alarm', next);
    }
    if (patch.marina) write('marina', { ...this.cache.marina, ...patch.marina });
    if (patch.suggestedScope !== undefined) write('suggestedScope', patch.suggestedScope);
    if (patch.boatName !== undefined) write('boatName', patch.boatName);
    if (patch.timeZone !== undefined) write('timeZone', patch.timeZone);
    if (patch.nightMode) write('nightMode', { ...this.cache.nightMode, ...patch.nightMode });
    if (changed.length > 0) {
      this.cache = this.load();
      this.bus.emit('settings:changed', { keys: changed });
    }
    return changed;
  }

  /** The "restore recommended defaults" button. */
  restoreAlarmDefaults(now = Date.now()): void {
    this.repo.set('alarm', { ...DEFAULT_ALARM_CONFIG }, now);
    this.repo.set('marina', { ...DEFAULT_MARINA_CONFIG }, now);
    this.cache = this.load();
    this.bus.emit('settings:changed', { keys: ['alarm', 'marina'] });
  }
}

export { DEFAULTS as DEFAULT_SETTINGS };
