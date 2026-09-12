import { degToRad, type Command } from '@rode/core';
import {
  findScenario,
  Normalizer,
  ReplaySource,
  SignalKSource,
  SimulatorSource,
  TcpSource,
  UdpSource,
  type ConnectionState,
  type SourceAdapter,
} from '@rode/ingest';
import type { SourceSettings, SourceView } from '@rode/protocol';
import path from 'node:path';
import type { Bus } from '../bus.js';
import type { Logger } from '../logger.js';

/*
 * Owns the data source adapter and the normaliser. The adapter is restartable
 * on its own (settings change, manual reconnect) without touching the engine:
 * ingestion has no session state. See docs/decisions.md 0.3.
 */

export interface IngestManagerOptions {
  bus: Bus;
  log: Logger;
  dataDir: string;
  /** Simulator only: scripted commands are forwarded here when enabled. */
  onScriptedCommand?: (command: Command) => void;
  simAutoCommands?: boolean;
  now?: () => number;
}

export class IngestManager {
  readonly normalizer: Normalizer;
  private adapter: SourceAdapter | null = null;
  private unsubscribe: (() => void) | null = null;
  private settings: SourceSettings | null = null;
  private readonly now: () => number;
  private lastSentenceAt: number | null = null;
  private restarts = 0;

  constructor(private readonly opts: IngestManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.normalizer = new Normalizer();
    this.normalizer.on((e) => {
      if (e.type === 'sentence') this.lastSentenceAt = this.now();
      this.opts.bus.emit('telemetry', e);
      if (e.type === 'ais') this.opts.bus.emit('ais', e.update);
    });
  }

  /** (Re)build the adapter from settings. Safe to call at any time. */
  async apply(settings: SourceSettings): Promise<void> {
    const changed = JSON.stringify(settings) !== JSON.stringify(this.settings);
    if (!changed && this.adapter) return;
    await this.stop();
    this.settings = settings;
    this.normalizer.options.transducerDepth = settings.transducerDepth;
    this.normalizer.options.magneticVariation =
      settings.magneticVariationDeg === null ? null : degToRad(settings.magneticVariationDeg);
    this.adapter = this.build(settings);
    this.unsubscribe = this.adapter.on((e) => {
      switch (e.type) {
        case 'line':
          this.normalizer.feedLine(e.line, e.now, settings.kind);
          break;
        case 'field':
          this.normalizer.applyField(e.name, e.value, e.timestamp, e.source);
          this.lastSentenceAt = this.now();
          break;
        case 'state':
          this.normalizer.setSourceState({
            connected: e.state.kind === 'connected',
            since: e.state.since,
          });
          this.opts.log.info({ source: settings.kind, state: e.state }, 'source state');
          this.opts.bus.emit('source:state', { kind: settings.kind, state: e.state });
          break;
        case 'command':
          if (this.opts.simAutoCommands) this.opts.onScriptedCommand?.(e.command);
          break;
      }
    });
    this.adapter.start();
    this.opts.log.info({ source: settings.kind }, 'ingest started');
  }

  private build(s: SourceSettings): SourceAdapter {
    switch (s.kind) {
      case 'nmea0183-tcp':
        return new TcpSource({ host: s.host, port: s.port });
      case 'nmea0183-udp':
        return new UdpSource({ port: s.port });
      case 'signalk-ws':
        return new SignalKSource({
          url: s.signalkUrl || 'ws://localhost:3000/signalk/v1/stream',
          ...(s.signalkToken ? { token: s.signalkToken } : {}),
          transducerDepth: s.transducerDepth,
        });
      case 'simulator': {
        const scenario = findScenario(s.simScenario) ?? findScenario('quiet-night');
        if (!scenario) throw new Error('no scenarios registered');
        return new SimulatorSource({
          scenario,
          speed: s.simSpeed,
          loop: true,
          autoCommands: this.opts.simAutoCommands ?? false,
        });
      }
      case 'replay': {
        const file = path.isAbsolute(s.replayFile)
          ? s.replayFile
          : path.join(this.opts.dataDir, s.replayFile);
        return new ReplaySource({ path: file, speed: s.simSpeed, loop: true });
      }
    }
  }

  /** Restart the current adapter in place (manual "reconnect now"). */
  async restart(): Promise<void> {
    if (!this.settings) return;
    const s = this.settings;
    this.settings = null;
    this.restarts++;
    await this.apply(s);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const a = this.adapter;
    this.adapter = null;
    if (a) await a.stop();
    this.normalizer.setSourceState({ connected: false, since: this.now() });
  }

  connectionState(): ConnectionState {
    return (
      this.adapter?.getConnectionState() ?? { kind: 'disconnected', since: 0, reason: 'no adapter' }
    );
  }

  view(): SourceView {
    return {
      kind: this.settings?.kind ?? 'none',
      state: this.connectionState(),
      stats: { ...(this.adapter?.stats() ?? {}), restarts: this.restarts },
      lastSentenceAt: this.lastSentenceAt,
    };
  }

  getLastSentenceAt(): number | null {
    return this.lastSentenceAt;
  }
}
