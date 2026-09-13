import type { EngineEvent } from '@rode/core';
import { kelvinToCelsius, mpsToKnots } from '@rode/core';
import {
  NotificationSettings,
  type ChannelTarget,
  type DeliveryRecord,
  type NotificationStats,
  type Recipient,
  type Severity,
} from '@rode/protocol';
import type { Bus } from '../bus.js';
import type { EventsRepo, SettingsRepo } from '../db/repos.js';
import type { Logger } from '../logger.js';
import {
  SECRET_KEYS,
  sendTo,
  type ChannelDeps,
  type DeliveryResult,
  type Notification,
} from './channels.js';

/*
 * The dispatcher turns engine events into notifications and delivers them.
 *
 * Delivery is verified, never assumed: every attempt is logged with its
 * result, failures retry with backoff, and the newest success anywhere is
 * the "notifications last confirmed working" timestamp the UI shows.
 *
 * The trick that makes this robust in practice: every anchor set and every
 * weigh sends a confirmation. It reads as a convenience. Its real job is
 * proving the notification path is alive at the exact moment the crew is
 * paying attention to it. A target that silently stopped delivering shows
 * up as a missing "Anchor watch active" message the same evening, not weeks
 * later.
 */

const RETRY_DELAYS_MS = [5_000, 20_000, 60_000];
const MAX_QUEUE = 200;
const SETTINGS_KEY = 'notifications';
export const MASK = '••••••••';

interface Job {
  notification: Notification;
  recipient: Recipient;
  target: ChannelTarget;
  attempt: number;
  dueAt: number;
}

export interface DispatcherOptions {
  settingsRepo: SettingsRepo;
  events: EventsRepo;
  bus: Bus;
  log: Logger;
  /** Recipient built from environment variables, if any. */
  envRecipient?: Recipient | null;
  /** Display units for message text. */
  units: () => { distance: 'm' | 'ft'; temperature: 'C' | 'F' };
  boatName: () => string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Test hook: replaces setTimeout for retries and the queue pump. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export class Dispatcher {
  private settings: NotificationSettings;
  private queue: Job[] = [];
  private pumping = false;
  private timer: (() => void) | null = null;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly recentWarnings = new Map<string, number>();
  private readonly stats: NotificationStats = {
    lastConfirmedAt: null,
    targets: {},
    sent24h: 0,
    failed24h: 0,
    queued: 0,
  };
  private readonly history: DeliveryRecord[] = [];
  private unsubscribe: (() => void)[] = [];
  private lastStateName: string | null = null;
  private stopped = false;
  private draining: Promise<void> | null = null;

  constructor(private readonly opts: DispatcherOptions) {
    this.now = opts.now ?? Date.now;
    this.schedule =
      opts.schedule ??
      ((fn, ms) => {
        const h = setTimeout(fn, ms);
        h.unref();
        return () => clearTimeout(h);
      });
    this.settings = this.load();
  }

  // ---------------------------------------------------------------- settings

  private load(): NotificationSettings {
    const raw = this.opts.settingsRepo.get(SETTINGS_KEY);
    const parsed = NotificationSettings.safeParse(raw ?? {});
    return parsed.success ? parsed.data : NotificationSettings.parse({});
  }

  getSettings(): NotificationSettings {
    return this.settings;
  }

  /** Settings with secrets replaced by a mask, for the admin UI. */
  maskedSettings(): NotificationSettings {
    const s = structuredClone(this.settings);
    for (const r of s.recipients) {
      for (const t of r.channels) {
        for (const k of SECRET_KEYS[t.kind]) {
          const rec = t as unknown as Record<string, string>;
          if (rec[k]) rec[k] = MASK;
        }
        if (t.kind === 'webhook') {
          for (const h of Object.keys(t.headers)) t.headers[h] = MASK;
        }
      }
    }
    if (s.smtp.pass) s.smtp.pass = MASK;
    return s;
  }

  /**
   * Replace settings. Any secret field equal to the mask keeps its stored
   * value (matched by recipient id + channel kind + position).
   */
  updateSettings(next: NotificationSettings, now = this.now()): NotificationSettings {
    const prev = this.settings;
    const merged = structuredClone(next);
    for (const r of merged.recipients) {
      const prevR = prev.recipients.find((x) => x.id === r.id);
      r.channels.forEach((t, i) => {
        const prevT =
          prevR?.channels[i]?.kind === t.kind
            ? prevR.channels[i]
            : prevR?.channels.find((x) => x.kind === t.kind);
        if (!prevT) return;
        const rec = t as unknown as Record<string, unknown>;
        const prevRec = prevT as unknown as Record<string, unknown>;
        for (const k of SECRET_KEYS[t.kind]) if (rec[k] === MASK) rec[k] = prevRec[k];
        if (t.kind === 'webhook' && prevT.kind === 'webhook') {
          for (const h of Object.keys(t.headers))
            if (t.headers[h] === MASK) t.headers[h] = prevT.headers[h] ?? '';
        }
      });
    }
    if (merged.smtp.pass === MASK) merged.smtp.pass = prev.smtp.pass;
    this.settings = NotificationSettings.parse(merged);
    this.opts.settingsRepo.set(SETTINGS_KEY, this.settings, now);
    return this.settings;
  }

  /** All recipients including the environment-defined one. */
  recipients(): Recipient[] {
    const env = this.opts.envRecipient;
    return env ? [...this.settings.recipients, env] : this.settings.recipients;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    this.unsubscribe.push(
      this.opts.bus.on('engine:event', ({ event }) => this.onEngineEvent(event)),
    );
  }

  /** Stops accepting work and waits for any in-flight delivery to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    this.timer?.();
    this.timer = null;
    this.queue = [];
    if (this.draining) await this.draining;
  }

  getStats(): NotificationStats {
    return { ...this.stats, queued: this.queue.length };
  }

  recentDeliveries(limit = 50): DeliveryRecord[] {
    return this.history.slice(-limit);
  }

  // ---------------------------------------------------------------- event → notification

  fmtDistance(m: number | null | undefined): string {
    if (m === null || m === undefined) return '?';
    return this.opts.units().distance === 'ft'
      ? `${Math.round(m / 0.3048)} ft`
      : `${Math.round(m)} m`;
  }

  fmtTemp(k: number | null | undefined): string {
    if (k === null || k === undefined) return '?';
    const c = kelvinToCelsius(k);
    return this.opts.units().temperature === 'F'
      ? `${Math.round((c * 9) / 5 + 32)} °F`
      : `${Math.round(c)} °C`;
  }

  private onEngineEvent(e: EngineEvent): void {
    const boat = this.opts.boatName();
    const n = this.notificationFor(e, boat);
    if (n) this.notify(n);
  }

  /** Pure mapping, exported for tests. */
  notificationFor(e: EngineEvent, boat: string): Notification | null {
    const base = { at: e.at };
    switch (e.type) {
      case 'anchor-set': {
        const g = e.geometry;
        return {
          ...base,
          severity: 'info',
          title: `${boat}: anchor watch active`,
          body: `Radius ${this.fmtDistance(g.swingRadius)}, rode ${this.fmtDistance(g.rodeLength)}, scope ${g.scopeRatio.toFixed(1)}:1, depth ${this.fmtDistance(g.depthAtDrop)}.`,
          data: { event: e.type, geometry: g },
        };
      }
      case 'session-ended':
        return {
          ...base,
          severity: 'info',
          title: `${boat}: ${e.mode === 'marina' ? 'marina watch stopped' : 'anchor weighed'}`,
          body: `After ${fmtDuration(e.durationMs)}, by ${e.by}.`,
          data: { event: e.type, durationMs: e.durationMs },
        };
      case 'state-changed': {
        this.lastStateName = e.to;
        if (e.to === 'ALARM')
          return {
            ...base,
            severity: 'critical',
            title: `${boat}: ALARM`,
            body: describeValues(e.values, this),
            data: { event: e.type, to: e.to, values: e.values },
          };
        if (e.to === 'WARNING')
          return {
            ...base,
            severity: 'warning',
            title: `${boat}: warning`,
            body: describeValues(e.values, this),
            data: { event: e.type, to: e.to, values: e.values },
          };
        if ((e.from === 'ALARM' || e.from === 'WARNING') && e.to === 'SET') {
          return {
            ...base,
            severity: 'info',
            title: `${boat}: all clear`,
            body: `Back to normal watching. ${describeValues(e.values, this)}`,
            data: { event: e.type, to: e.to },
          };
        }
        return null;
      }
      case 'condition-raised':
      case 'condition-escalated': {
        const c = e.condition;
        const sev: Severity = c.severity;
        return {
          ...base,
          severity: sev,
          title: `${boat}: ${CONDITION_TEXT[c.id] ?? c.id}`,
          body: describeValues(c.values, this),
          data: { event: e.type, condition: c.id, severity: c.severity, values: c.values },
        };
      }
      case 'alarm-refire':
        return {
          ...base,
          severity: 'critical',
          title: `${boat}: still alarming (${e.refires})`,
          body: `Not acknowledged again. ${describeValues(e.values, this)} Conditions: ${e.conditions.join(', ')}.`,
          data: { event: e.type, refires: e.refires },
        };
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- delivery

  /** Route a notification to every matching target and start delivering. */
  notify(n: Notification): number {
    const now = this.now();
    if (n.severity === 'warning' && this.settings.collapseWarningsMs > 0) {
      const key = `${n.title}|${n.body}`;
      const last = this.recentWarnings.get(key);
      if (last !== undefined && now - last < this.settings.collapseWarningsMs) return 0;
      this.recentWarnings.set(key, now);
      if (this.recentWarnings.size > 200) this.recentWarnings.clear();
    }
    let queued = 0;
    for (const r of this.recipients()) {
      if (!r.enabled) continue;
      for (const t of r.channels) {
        if (!t.enabled || !t.severities.includes(n.severity)) continue;
        if (this.queue.length >= MAX_QUEUE) break;
        this.queue.push({ notification: n, recipient: r, target: t, attempt: 1, dueAt: now });
        queued++;
      }
    }
    this.opts.log.info({ title: n.title, severity: n.severity, queued }, 'notification queued');
    if (queued > 0) this.pump();
    return queued;
  }

  /** Send a test to matching targets and wait for the results. */
  async test(recipientId?: string, channel?: string): Promise<DeliveryRecord[]> {
    const n: Notification = {
      at: this.now(),
      severity: 'info',
      title: `${this.opts.boatName()}: test notification`,
      body: 'If you can read this, this channel works. Sent from Rode settings.',
      tags: ['white_check_mark'],
    };
    const out: DeliveryRecord[] = [];
    for (const r of this.recipients()) {
      if (recipientId && r.id !== recipientId) continue;
      for (const t of r.channels) {
        if (channel && t.kind !== channel) continue;
        const res = await sendTo(n, t, this.deps());
        out.push(
          this.record({ notification: n, recipient: r, target: t, attempt: 1, dueAt: n.at }, res),
        );
      }
    }
    return out;
  }

  private deps(): ChannelDeps {
    return { fetch: this.opts.fetch ?? fetch, smtp: this.settings.smtp };
  }

  private pump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    this.draining = this.drain().finally(() => {
      this.pumping = false;
      this.draining = null;
      if (this.stopped) return;
      const next = this.queue.reduce<number | null>(
        (min, j) => (min === null || j.dueAt < min ? j.dueAt : min),
        null,
      );
      if (next !== null) {
        this.timer?.();
        this.timer = this.schedule(() => this.pump(), Math.max(0, next - this.now()));
      }
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      const now = this.now();
      const idx = this.queue.findIndex((j) => j.dueAt <= now);
      if (idx === -1) return;
      const job = this.queue.splice(idx, 1)[0];
      if (!job) return;
      const res = await sendTo(job.notification, job.target, this.deps());
      if (this.stopped) return;
      this.record(job, res);
      if (!res.ok) {
        const delay = RETRY_DELAYS_MS[job.attempt - 1];
        if (delay !== undefined) {
          this.queue.push({ ...job, attempt: job.attempt + 1, dueAt: this.now() + delay });
        } else {
          this.opts.log.error(
            { recipient: job.recipient.name, channel: job.target.kind, error: res.error },
            'notification gave up',
          );
        }
      }
    }
  }

  private record(job: Job, res: DeliveryResult): DeliveryRecord {
    const at = this.now();
    const rec: DeliveryRecord = {
      at,
      recipientId: job.recipient.id,
      recipientName: job.recipient.name,
      channel: job.target.kind,
      severity: job.notification.severity,
      title: job.notification.title,
      attempt: job.attempt,
      ok: res.ok,
      status: res.status,
      error: res.error,
      durationMs: res.durationMs,
    };
    this.history.push(rec);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    const key = `${job.recipient.id}:${job.target.kind}`;
    const t = (this.stats.targets[key] ??= {
      lastOkAt: null,
      lastFailAt: null,
      lastError: null,
      sent: 0,
      failed: 0,
    });
    if (res.ok) {
      t.lastOkAt = at;
      t.sent++;
      this.stats.lastConfirmedAt = at;
    } else {
      t.lastFailAt = at;
      t.lastError = res.error ?? 'failed';
      t.failed++;
    }
    this.recount();
    const seq = this.opts.events.append(
      res.ok ? 'notification-sent' : 'notification-failed',
      {
        recipient: job.recipient.name,
        channel: job.target.kind,
        severity: job.notification.severity,
        title: job.notification.title,
        attempt: job.attempt,
        status: res.status ?? null,
        error: res.error ?? null,
        durationMs: res.durationMs,
      },
      res.ok ? 'info' : 'warning',
      at,
    );
    const type = res.ok ? 'notification-sent' : 'notification-failed';
    this.opts.bus.emit('log:event', {
      record: {
        seq,
        at,
        sessionId: null,
        type,
        severity: res.ok ? 'info' : 'warning',
        data: { ...rec, type },
      },
    });
    return rec;
  }

  private recount(): void {
    const since = this.now() - 86_400_000;
    let sent = 0;
    let failed = 0;
    for (const h of this.history) {
      if (h.at < since) continue;
      if (h.ok) sent++;
      else failed++;
    }
    this.stats.sent24h = sent;
    this.stats.failed24h = failed;
  }
}

const CONDITION_TEXT: Record<string, string> = {
  'position-warning': 'near the edge of the swing circle',
  'position-outside': 'OUTSIDE THE SWING CIRCLE',
  speed: 'moving',
  'gps-stale': 'no GPS position',
  'source-disconnected': 'DATA SOURCE DISCONNECTED',
  'depth-shallow': 'SHALLOW WATER',
  'zone-breach': 'IN AN EXCLUSION ZONE',
  'zone-projected': 'heading for an exclusion zone',
};

function describeValues(
  v: Record<string, number | string | boolean | null>,
  d: { fmtDistance: (m: number | null) => string },
): string {
  const parts: string[] = [];
  if (typeof v.distance === 'number') parts.push(`${d.fmtDistance(v.distance)} from anchor`);
  if (typeof v.radius === 'number') parts.push(`radius ${d.fmtDistance(v.radius)}`);
  if (typeof v.sog === 'number') parts.push(`SOG ${mpsToKnots(v.sog).toFixed(1)} kn`);
  if (typeof v.ageS === 'number') parts.push(`${v.ageS} s without a fix`);
  if (typeof v.disconnectedS === 'number') parts.push(`source down ${v.disconnectedS} s`);
  if (typeof v.depth === 'number') parts.push(`depth ${d.fmtDistance(v.depth)}`);
  if (typeof v.zone === 'string') parts.push(`zone ${v.zone}`);
  if (typeof v.soc === 'number') parts.push(`SoC ${Math.round(v.soc * 100)}%`);
  if (typeof v.watts === 'number') parts.push(`${Math.round(v.watts)} W`);
  return parts.length > 0 ? parts.join(', ') + '.' : '';
}

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}
