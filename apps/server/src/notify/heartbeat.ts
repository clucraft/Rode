import { kelvinToCelsius, type WatchState } from '@rode/core';
import type { Normalizer } from '@rode/ingest';
import type { RuntimeRepo } from '../db/repos.js';
import type { Logger } from '../logger.js';
import { fmtDuration, type Dispatcher } from './dispatcher.js';

/*
 * The daily heartbeat.
 *
 * Every morning at a configurable local time, every recipient gets a status
 * snapshot: position, battery, solar, fridge and freezer temperatures, GPS
 * health, uptime, last data-source reconnect.
 *
 * The reasoning, from the field: three weeks of silence is ambiguous when
 * you are a thousand miles away. Is everything fine, or did the system die
 * on day two? A daily message turns silence into a signal. If it stops
 * arriving, something is wrong, and that is worth knowing.
 */

const KEY = 'last_heartbeat_day';

export interface HeartbeatOptions {
  dispatcher: Dispatcher;
  runtime: RuntimeRepo;
  normalizer: Normalizer;
  engineState: () => WatchState;
  bootedAt: number;
  boatName: () => string;
  timeZone: () => string;
  sourceView: () => {
    state: { kind: string; since: number };
    stats: Record<string, number | string | null>;
  };
  gpsSynced: () => boolean;
  log: Logger;
  now?: () => number;
}

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: HeartbeatOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => this.maybeSend(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Local date and HH:MM in the boat's time zone. */
  private local(now: number): { day: string; hhmm: string } | null {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: this.opts.timeZone(),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(now));
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      return {
        day: `${get('year')}-${get('month')}-${get('day')}`,
        hhmm: `${get('hour')}:${get('minute')}`,
      };
    } catch {
      return null;
    }
  }

  /** Called once a minute. Sends when the local time has passed the target and today has not been sent. */
  maybeSend(): boolean {
    const settings = this.opts.dispatcher.getSettings().heartbeat;
    if (!settings.enabled) return false;
    const now = this.now();
    if (now < Date.UTC(2020, 0, 1)) return false; // clock not set yet
    const local = this.local(now);
    if (!local) return false;
    if (local.hhmm < settings.localTime) return false;
    if (this.opts.runtime.get(KEY) === local.day) return false;
    this.opts.runtime.set(KEY, local.day);
    this.send();
    return true;
  }

  /** Compose and send the snapshot now. Public so the UI can trigger one. */
  send(): void {
    const now = this.now();
    const n = this.opts.normalizer;
    const s = this.opts.engineState();
    const pos = n.getField('position');
    const soc = n.getField('batterySoc');
    const volts = n.getField('batteryVoltage');
    const solar = n.getField('solarPower');
    const fridge = n.getField('fridgeTemp');
    const freezer = n.getField('freezerTemp');
    const src = this.opts.sourceView();
    const age = (f: { timestamp: number } | undefined) =>
      f ? fmtDuration(now - f.timestamp) + ' ago' : 'never';
    const temp = (k: number | undefined) =>
      k === undefined ? 'n/a' : `${kelvinToCelsius(k).toFixed(1)} °C`;

    const lines = [
      `Watch: ${s.stateName}${s.session ? ` (${s.session.mode}, since ${fmtDuration(now - s.session.startedAt)})` : ''}`,
      `Position: ${pos ? `${pos.value.lat.toFixed(5)}, ${pos.value.lon.toFixed(5)} (${age(pos)})` : 'no fix'}`,
      `GPS: ${pos && now - pos.timestamp < 30_000 ? 'ok' : 'STALE'}, time ${this.opts.gpsSynced() ? 'synced' : 'not synced'}`,
      `Battery: ${soc ? `${Math.round(soc.value * 100)}%` : 'n/a'}${volts ? ` ${volts.value.toFixed(2)} V` : ''}`,
      `Solar: ${solar ? `${Math.round(solar.value)} W` : 'n/a'}`,
      `Fridge: ${temp(fridge?.value)} (${s.marina.fridge.band}), freezer: ${temp(freezer?.value)} (${s.marina.freezer.band})`,
      `Source: ${src.state.kind} for ${fmtDuration(now - src.state.since)}, reconnects ${String(src.stats.reconnects ?? 0)}`,
      `Uptime: ${fmtDuration(now - this.opts.bootedAt)}`,
    ];
    this.opts.log.info('sending daily heartbeat');
    this.opts.dispatcher.notify({
      at: now,
      severity: 'info',
      title: `${this.opts.boatName()}: daily status`,
      body: lines.join('\n'),
      tags: ['sunrise'],
      data: { event: 'heartbeat' },
    });
  }
}
