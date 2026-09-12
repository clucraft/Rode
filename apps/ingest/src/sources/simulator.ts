import {
  SourceEmitter,
  type ConnectionState,
  type SourceAdapter,
  type SourceListener,
} from '../adapter.js';
import { sentencesFor } from '../sim/generator.js';
import type { Scenario } from '../sim/scenario.js';

export interface SimulatorSourceOptions {
  scenario: Scenario;
  /** Scenario seconds per wall-clock second. 60 replays a 12 h night in 12 min. */
  speed?: number;
  /** Start again from t=0 when the scenario ends. */
  loop?: boolean;
  /** Emit the scenario's scripted skipper commands as source events so a demo drives itself. */
  autoCommands?: boolean;
  now?: () => number;
  /** Test hook: replaces setInterval. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

/**
 * Plays a scenario in-process in (scaled) real time, emitting the same NMEA
 * lines the fake Cortex server would put on the wire. The sentence clock
 * follows the scenario; the `now` on each event is the wall clock, which is
 * what the normaliser uses for staleness.
 */
export class SimulatorSource implements SourceAdapter {
  readonly kind = 'simulator' as const;
  private readonly emitter: SourceEmitter;
  private readonly now: () => number;
  private cancel: (() => void) | null = null;
  private t = 0;
  private nextCommand = 0;
  private readonly counters = { seconds: 0, lines: 0, loops: 0 };

  constructor(private readonly opts: SimulatorSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.emitter = new SourceEmitter(this.now());
  }

  on(listener: SourceListener): () => void {
    return this.emitter.on(listener);
  }

  getConnectionState(): ConnectionState {
    return this.emitter.getState();
  }

  stats(): Record<string, number | string | null> {
    return {
      ...this.counters,
      scenario: this.opts.scenario.id,
      t: this.t,
      speed: this.opts.speed ?? 1,
    };
  }

  /** Current scenario second. */
  get scenarioTime(): number {
    return this.t;
  }

  start(): void {
    if (this.cancel) return;
    const speed = Math.max(0.01, this.opts.speed ?? 1);
    const schedule =
      this.opts.schedule ??
      ((fn, ms) => {
        const h = setInterval(fn, ms);
        return () => clearInterval(h);
      });
    this.cancel = schedule(() => this.step(), Math.max(1, Math.round(1000 / speed)));
  }

  /** Advance one scenario second. Public so tests can drive it without timers. */
  step(): void {
    const scenario = this.opts.scenario;
    const now = this.now();
    if (this.t > scenario.durationS) {
      if (!this.opts.loop) {
        this.emitter.setState({ kind: 'disconnected', since: now, reason: 'scenario ended' });
        this.cancel?.();
        this.cancel = null;
        return;
      }
      this.t = 0;
      this.nextCommand = 0;
      this.counters.loops++;
    }
    const state = scenario.state(this.t);
    if (state.connected) {
      if (this.emitter.getState().kind !== 'connected') {
        this.emitter.setState({
          kind: 'connected',
          since: now,
          remote: `simulator:${scenario.id}`,
        });
      }
      for (const line of sentencesFor(state, this.t)) {
        this.counters.lines++;
        this.emitter.emit({ type: 'line', line, now });
      }
    } else if (this.emitter.getState().kind !== 'disconnected') {
      this.emitter.setState({ kind: 'disconnected', since: now, reason: 'simulated hub outage' });
    }
    if (this.opts.autoCommands) {
      const cmds = scenario.commands;
      while (this.nextCommand < cmds.length && (cmds[this.nextCommand]?.at ?? Infinity) <= this.t) {
        const c = cmds[this.nextCommand++];
        if (c) this.emitter.emit({ type: 'command', command: c.command, now });
      }
    }
    this.counters.seconds++;
    this.t++;
  }

  async stop(): Promise<void> {
    this.cancel?.();
    this.cancel = null;
    this.emitter.setState({ kind: 'disconnected', since: this.now(), reason: 'stopped' });
    await Promise.resolve();
  }
}
