import dgram from 'node:dgram';
import net from 'node:net';
import { sentencesFor } from './generator.js';
import type { Scenario } from './scenario.js';

/*
 * A fake Cortex hub: listens on TCP (and optionally broadcasts UDP) and
 * streams the scenario's sentences at scaled real time. When the scenario
 * says the hub is down, the listener closes and every client is dropped, so
 * the real TCP adapter's reconnect path gets exercised, not simulated.
 */

export interface FakeHubOptions {
  scenario: Scenario;
  port: number;
  host?: string;
  speed?: number;
  loop?: boolean;
  udp?: { port: number; address?: string } | undefined;
  log?: (msg: string) => void;
}

export class FakeHub {
  private server: net.Server | null = null;
  private udp: dgram.Socket | null = null;
  private readonly clients = new Set<net.Socket>();
  private timer: NodeJS.Timeout | null = null;
  private t = 0;
  private listening = false;

  constructor(private readonly opts: FakeHubOptions) {}

  async start(): Promise<void> {
    const speed = Math.max(0.01, this.opts.speed ?? 1);
    if (this.opts.udp) {
      this.udp = dgram.createSocket('udp4');
      await new Promise<void>((resolve) => this.udp?.bind(0, () => resolve()));
      this.udp.setBroadcast(true);
    }
    await this.listen();
    this.timer = setInterval(() => this.step(), Math.max(1, Math.round(1000 / speed)));
    this.opts.log?.(
      `fake hub: ${this.opts.scenario.id} on tcp ${this.opts.host ?? '0.0.0.0'}:${this.opts.port} at ${speed}x`,
    );
  }

  private listen(): Promise<void> {
    if (this.listening) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.clients.add(socket);
        socket.setNoDelay(true);
        socket.on('close', () => this.clients.delete(socket));
        socket.on('error', () => this.clients.delete(socket));
        this.opts.log?.(
          `client connected from ${socket.remoteAddress ?? '?'} (${this.clients.size} total)`,
        );
      });
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        this.server = server;
        this.listening = true;
        resolve();
      });
    });
  }

  private closeListener(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.listening = false;
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    if (!s) return Promise.resolve();
    return new Promise((resolve) => s.close(() => resolve()));
  }

  private step(): void {
    const scenario = this.opts.scenario;
    if (this.t > scenario.durationS) {
      if (!this.opts.loop) {
        this.opts.log?.('scenario ended');
        void this.stop();
        return;
      }
      this.t = 0;
    }
    const state = scenario.state(this.t);
    if (!state.connected) {
      if (this.listening) {
        this.opts.log?.(`t=${this.t}: hub goes down`);
        void this.closeListener();
      }
      this.t++;
      return;
    }
    if (!this.listening) {
      this.opts.log?.(`t=${this.t}: hub back up`);
      void this.listen();
    }
    const payload = sentencesFor(state, this.t).join('\r\n') + '\r\n';
    for (const c of this.clients) c.write(payload);
    if (this.udp && this.opts.udp) {
      this.udp.send(payload, this.opts.udp.port, this.opts.udp.address ?? '255.255.255.255');
    }
    this.t++;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.closeListener();
    const u = this.udp;
    this.udp = null;
    if (u) await new Promise<void>((resolve) => u.close(() => resolve()));
  }
}
