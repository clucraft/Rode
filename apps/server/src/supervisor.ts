import type { EventsRepo } from './db/repos.js';
import type { EngineHost } from './engine/host.js';
import type { Logger } from './logger.js';
import type { Dispatcher } from './notify/dispatcher.js';

/*
 * The supervisor checks that the alarm engine is actually *evaluating*, not
 * merely that the process is alive. A stalled event loop, a timer that got
 * cleared, a tick that throws every time: all leave the process running and
 * the watch dead. That is the silent failure this project exists to catch.
 *
 * If the heartbeat counter stops advancing:
 *   1. log a critical event and notify
 *   2. try to restart the tick loop in-process
 *   3. /readyz has already gone 503, so Docker restarts the container if
 *      the in-process restart does not take
 */

const CHECK_MS = 10_000;
const STALL_MS = 15_000;

export interface SupervisorOptions {
  engine: EngineHost;
  events: EventsRepo;
  dispatcher: Dispatcher;
  log: Logger;
  boatName: () => string;
  now?: () => number;
}

export class Supervisor {
  private timer: NodeJS.Timeout | null = null;
  private lastTicks = -1;
  private lastAdvanceAt: number;
  private stalled = false;
  public restarts = 0;
  private readonly now: () => number;

  constructor(private readonly opts: SupervisorOptions) {
    this.now = opts.now ?? Date.now;
    this.lastAdvanceAt = this.now();
  }

  start(): void {
    this.timer = setInterval(() => this.check(), CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check. Public for tests. */
  check(): 'ok' | 'stalled' | 'recovered' {
    const now = this.now();
    const ticks = this.opts.engine.ticks;
    if (ticks !== this.lastTicks) {
      this.lastTicks = ticks;
      this.lastAdvanceAt = now;
      if (this.stalled) {
        this.stalled = false;
        this.opts.log.warn('engine heartbeat recovered');
        this.opts.events.append('engine-recovered', { ticks }, 'warning', now);
        return 'recovered';
      }
      return 'ok';
    }
    if (now - this.lastAdvanceAt < STALL_MS) return 'ok';
    if (!this.stalled) {
      this.stalled = true;
      this.opts.log.error(
        { ticks, stalledMs: now - this.lastAdvanceAt },
        'engine heartbeat stalled',
      );
      this.opts.events.append(
        'engine-stalled',
        { ticks, stalledMs: now - this.lastAdvanceAt },
        'critical',
        now,
      );
      this.opts.dispatcher.notify({
        at: now,
        severity: 'critical',
        title: `${this.opts.boatName()}: alarm engine stalled`,
        body: `The watch has not evaluated for ${Math.round((now - this.lastAdvanceAt) / 1000)} s. Restarting it; if this repeats the container restarts.`,
        data: { event: 'engine-stalled' },
      });
    }
    // Try to bring the loop back in-process.
    this.restarts++;
    this.opts.engine.stop();
    this.opts.engine.start();
    return 'stalled';
  }
}
