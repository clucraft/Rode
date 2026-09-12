import mqtt, { type MqttClient } from 'mqtt';
import type { WatchState } from '@rode/core';
import type { Bus } from '../bus.js';
import type { Logger } from '../logger.js';

/*
 * Retained state on MQTT for Home Assistant, a Zigbee siren, a relay: the
 * loud local noise that matters when the phone is ashore and the boat is
 * not. Publishes on every state change and at least every 30 s so a
 * consumer can tell "quiet" from "dead".
 */

export interface MqttPublisherOptions {
  url: string;
  username?: string | undefined;
  password?: string | undefined;
  topicPrefix: string;
  bus: Bus;
  log: Logger;
  engineState: () => WatchState;
  now?: () => number;
}

export class MqttPublisher {
  private client: MqttClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastStateName: string | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: MqttPublisherOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.client = mqtt.connect(this.opts.url, {
      ...(this.opts.username ? { username: this.opts.username } : {}),
      ...(this.opts.password ? { password: this.opts.password } : {}),
      reconnectPeriod: 5000,
      will: { topic: `${this.opts.topicPrefix}/online`, payload: 'false', retain: true, qos: 1 },
    });
    this.client.on('connect', () => {
      this.opts.log.info({ url: this.opts.url }, 'mqtt connected');
      this.publish('online', 'true', true);
      this.publishState(true);
    });
    this.client.on('error', (err) => this.opts.log.warn({ err: err.message }, 'mqtt error'));
    this.unsubscribe = this.opts.bus.on('engine:state', () => this.publishState(false));
    this.timer = setInterval(() => this.publishState(true), 30_000);
    this.timer.unref();
  }

  private publishState(force: boolean): void {
    const s = this.opts.engineState();
    if (!force && s.stateName === this.lastStateName) return;
    this.lastStateName = s.stateName;
    this.publish('alarm', s.stateName, true);
    this.publish(
      'alarm/active',
      s.stateName === 'ALARM' || s.stateName === 'WARNING' ? 'ON' : 'OFF',
      true,
    );
    this.publish(
      'state',
      JSON.stringify({
        at: this.now(),
        state: s.stateName,
        phase: s.phase,
        snoozed: s.ack !== null && s.ack.until > this.now(),
        conditions: Object.values(s.conditions).map((c) => ({
          id: c.id,
          severity: c.severity,
          since: c.since,
        })),
        distance: s.live.distanceFromAnchor,
        distanceToEdge: s.live.distanceToEdge,
        radius: s.session?.geometry?.swingRadius ?? s.session?.marinaRadius ?? null,
        scope: s.session?.geometry?.scopeRatio ?? null,
        positionAgeS: s.live.positionAgeS,
        sessionId: s.session?.id ?? null,
      }),
      true,
    );
  }

  private publish(topic: string, payload: string, retain: boolean): void {
    if (!this.client?.connected) return;
    this.client.publish(`${this.opts.topicPrefix}/${topic}`, payload, { retain, qos: 0 });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const c = this.client;
    this.client = null;
    if (c) {
      c.publish(`${this.opts.topicPrefix}/online`, 'false', { retain: true });
      await new Promise<void>((resolve) => c.end(false, {}, () => resolve()));
    }
  }
}
