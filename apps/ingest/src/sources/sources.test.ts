import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import dgram from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { degToRad } from '@rode/core';
import { backoffMs, type ConnectionState, type SourceEvent } from '../adapter.js';
import { TcpSource } from './tcp.js';
import { UdpSource } from './udp.js';
import { SignalKSource, type WebSocketLike } from './signalk.js';
import { SimulatorSource } from './simulator.js';
import { Recorder, ReplaySource } from './replay.js';
import { FakeHub } from '../sim/server.js';
import { baseState, SIM_ANCHOR, type Scenario } from '../sim/scenario.js';
import { DEFAULT_SIM_BOAT } from '../sim/scenario.js';
import { encodeRMC } from '../nmea/encode.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await wait(10);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

const RMC = encodeRMC({
  epochMs: Date.UTC(2026, 8, 11),
  lat: 32.29,
  lon: -64.83,
  sog: 0.2,
  cog: 1,
});

describe('backoffMs', () => {
  it('doubles from 1 s and caps at 30 s with bounded jitter', () => {
    const r = () => 0.5; // zero jitter
    expect(backoffMs(0, 30_000, r)).toBe(1000);
    expect(backoffMs(3, 30_000, r)).toBe(8000);
    expect(backoffMs(10, 30_000, r)).toBe(30_000);
    expect(backoffMs(2, 30_000, () => 1)).toBeLessThanOrEqual(4800);
    expect(backoffMs(2, 30_000, () => 0)).toBeGreaterThanOrEqual(3200);
  });
});

describe('TcpSource', () => {
  it('connects, splits lines, reconnects after the server drops it, and reports states', async () => {
    const port = await freePort();
    const clients = new Set<net.Socket>();
    const server = net.createServer((s) => {
      clients.add(s);
      s.on('close', () => clients.delete(s));
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));

    const src = new TcpSource({ host: '127.0.0.1', port, backoffCapMs: 200, idleTimeoutMs: 2000 });
    const lines: string[] = [];
    const states: ConnectionState['kind'][] = [];
    src.on((e) => {
      if (e.type === 'line') lines.push(e.line);
      if (e.type === 'state') states.push(e.state.kind);
    });
    src.start();
    cleanups.push(() => src.stop());

    await until(() => clients.size === 1);
    for (const c of clients) c.write(`${RMC}\r\n$IIMTW,20.0,C*` + '1B\r\npartial');
    await until(() => lines.length === 2);
    expect(lines[0]).toBe(RMC);

    // Server drops the client: adapter goes disconnected then reconnects.
    for (const c of clients) c.destroy();
    await until(() => states.includes('disconnected'));
    await until(
      () => clients.size === 1 && states.filter((s) => s === 'connected').length === 2,
      5000,
    );
    for (const c of clients) c.write(`${RMC}\r\n`);
    await until(() => lines.length === 3);
    expect(src.stats().reconnects).toBe(1);
    expect(src.getConnectionState().kind).toBe('connected');
  });

  it('keeps retrying while nothing is listening, with backoff, and stops cleanly', async () => {
    const port = await freePort();
    const src = new TcpSource({ host: '127.0.0.1', port, backoffCapMs: 100 });
    const states: ConnectionState[] = [];
    src.on((e) => {
      if (e.type === 'state') states.push(e.state);
    });
    src.start();
    await until(() => states.filter((s) => s.kind === 'connecting').length >= 3, 5000);
    await src.stop();
    expect(src.getConnectionState().kind).toBe('disconnected');
    expect(
      states.some((s) => s.kind === 'disconnected' && /ECONNREFUSED|refused/i.test(s.reason ?? '')),
    ).toBe(true);
  });

  it('treats an idle connection as dead and reconnects', async () => {
    const port = await freePort();
    let connections = 0;
    const server = net.createServer(() => {
      connections++;
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const src = new TcpSource({ host: '127.0.0.1', port, idleTimeoutMs: 150, backoffCapMs: 50 });
    src.start();
    cleanups.push(() => src.stop());
    await until(() => connections >= 2, 5000);
    expect(src.stats().idleTimeouts).toBeGreaterThanOrEqual(1);
  });
});

describe('UdpSource', () => {
  it('receives datagrams and goes disconnected when they stop', async () => {
    const port = await freePort();
    const src = new UdpSource({ port, host: '127.0.0.1', idleTimeoutMs: 200 });
    const lines: string[] = [];
    const states: ConnectionState['kind'][] = [];
    src.on((e) => {
      if (e.type === 'line') lines.push(e.line);
      if (e.type === 'state') states.push(e.state.kind);
    });
    src.start();
    cleanups.push(() => src.stop());
    await wait(50);
    const sender = dgram.createSocket('udp4');
    cleanups.push(() => new Promise<void>((r) => sender.close(() => r())));
    sender.send(`${RMC}\r\n`, port, '127.0.0.1');
    await until(() => lines.length === 1);
    expect(states).toContain('connected');
    await until(() => states.at(-1) === 'disconnected', 2000);
    expect(src.stats().idleTimeouts).toBe(1);
  });
});

describe('SignalKSource', () => {
  function fakeSocketFactory() {
    const listeners: Record<string, ((ev: { data?: unknown; reason?: string }) => void)[]> = {};
    const sock: WebSocketLike & {
      fire: (t: string, ev?: { data?: unknown; reason?: string }) => void;
      closed: number;
    } = {
      readyState: 0,
      closed: 0,
      addEventListener(type, l) {
        (listeners[type] ??= []).push(l);
      },
      close() {
        this.closed++;
      },
      fire(type, ev = {}) {
        for (const l of listeners[type] ?? []) l(ev);
      },
    };
    return sock;
  }

  it('maps a delta to SI fields and handles heading magnetic + variation', () => {
    const events: SourceEvent[] = [];
    const src = new SignalKSource({
      url: 'ws://sk.local:3000/signalk/v1/stream',
      now: () => 1_000_000,
    });
    src.on((e) => events.push(e));
    src.handleDelta({
      context: 'vessels.self',
      updates: [
        {
          $source: 'cortex.GP',
          timestamp: new Date(1_000_000 - 500).toISOString(),
          values: [
            { path: 'navigation.position', value: { latitude: 32.29, longitude: -64.83 } },
            { path: 'navigation.speedOverGround', value: 0.3 },
            { path: 'navigation.magneticVariation', value: degToRad(-12) },
            { path: 'navigation.headingMagnetic', value: degToRad(100) },
            { path: 'environment.depth.belowTransducer', value: 4.0 },
            { path: 'environment.wind.angleApparent', value: -0.5 },
            { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.82 },
            { path: 'electrical.solar.mppt1.panelPower', value: 240 },
            { path: 'environment.inside.freezer.temperature', value: 255 },
            { path: 'some.unknown.path', value: 1 },
          ],
        },
      ],
    });
    const byName: Record<string, SourceEvent> = {};
    for (const e of events) if (e.type === 'field') byName[e.name] = e;
    expect(byName.position?.type === 'field' && byName.position.value).toEqual({
      lat: 32.29,
      lon: -64.83,
    });
    expect(byName.sog?.type === 'field' && byName.sog.value).toBe(0.3);
    expect(byName.heading?.type === 'field' && byName.heading.value).toBeCloseTo(degToRad(88), 6);
    expect(byName.depth?.type === 'field' && byName.depth.value).toBe(4.0);
    expect(byName.batterySoc?.type === 'field' && byName.batterySoc.value).toBe(0.82);
    expect(byName.solarPower?.type === 'field' && byName.solarPower.value).toBe(240);
    expect(byName.freezerTemp?.type === 'field' && byName.freezerTemp.value).toBe(255);
    expect(byName.position?.type === 'field' && byName.position.timestamp).toBe(1_000_000 - 500);
    expect(byName.position?.type === 'field' && byName.position.source).toBe('signalk:cortex.GP');
    expect(src.stats().ignored).toBe(2); // magneticVariation (consumed) and unknown path
  });

  it('ignores other vessels and connects/reconnects through the socket lifecycle', async () => {
    const sockets: ReturnType<typeof fakeSocketFactory>[] = [];
    const src = new SignalKSource({
      url: 'ws://sk.local:3000/signalk/v1/stream',
      backoffCapMs: 20,
      createSocket: () => {
        const s = fakeSocketFactory();
        sockets.push(s);
        return s;
      },
    });
    const states: string[] = [];
    const events: SourceEvent[] = [];
    src.on((e) => {
      events.push(e);
      if (e.type === 'state') states.push(e.state.kind);
    });
    src.start();
    cleanups.push(() => src.stop());
    expect(sockets).toHaveLength(1);
    sockets[0]?.fire('open');
    expect(src.getConnectionState().kind).toBe('connected');
    sockets[0]?.fire('message', {
      data: JSON.stringify({
        context: 'vessels.urn:mrn:imo:mmsi:123',
        updates: [{ values: [{ path: 'navigation.speedOverGround', value: 5 }] }],
      }),
    });
    expect(events.filter((e) => e.type === 'field')).toHaveLength(0);
    sockets[0]?.fire('close', { reason: 'server went away' });
    expect(src.getConnectionState()).toMatchObject({
      kind: 'disconnected',
      reason: 'server went away',
    });
    await until(() => sockets.length === 2);
    sockets[1]?.fire('open');
    expect(src.stats().reconnects).toBe(1);
  });
});

describe('SimulatorSource', () => {
  const scenario: Scenario = {
    id: 't',
    name: 't',
    description: '',
    expectation: 'n/a for this unit test',
    durationS: 3,
    startEpochMs: 0,
    boat: DEFAULT_SIM_BOAT,
    commands: [{ at: 1, command: { type: 'drop' } }],
    state: (t) => ({ ...baseState(t * 1000), position: SIM_ANCHOR, connected: t !== 2 }),
  };

  it('emits sentences per scenario second, state changes on outages, and scripted commands', () => {
    const src = new SimulatorSource({
      scenario,
      autoCommands: true,
      schedule: () => () => undefined,
    });
    const events: SourceEvent[] = [];
    src.on((e) => events.push(e));
    src.start();
    for (let i = 0; i < 5; i++) src.step();
    const kinds: string[] = [];
    for (const e of events) if (e.type === 'state') kinds.push(e.state.kind);
    expect(kinds).toEqual(['connected', 'disconnected', 'connected', 'disconnected']); // outage at t=2, end at t=4
    expect(events.filter((e) => e.type === 'command')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'line').length).toBeGreaterThan(6);
  });
});

describe('Recorder + ReplaySource', () => {
  it('records timestamped lines and replays them with scaled timing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rode-rec-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'test.nmea');
    const rec = new Recorder({ path: file, now: () => 0 });
    rec.start();
    rec.write('$A', 1000);
    rec.write('$B', 1500);
    rec.write('$C', 1600);
    await rec.stop();
    expect(readFileSync(file, 'utf8')).toBe('1000\t$A\n1500\t$B\n1600\t$C\n');

    const src = new ReplaySource({ path: file, speed: 10 });
    const lines: { line: string; at: number }[] = [];
    const states: string[] = [];
    src.on((e) => {
      if (e.type === 'line') lines.push({ line: e.line, at: Date.now() });
      if (e.type === 'state') states.push(e.state.kind);
    });
    src.start();
    cleanups.push(() => src.stop());
    await until(() => lines.length === 3);
    await until(() => states.at(-1) === 'disconnected');
    expect(lines.map((l) => l.line)).toEqual(['$A', '$B', '$C']);
    // 500 ms gap at 10x ≈ 50 ms; allow generous slack on CI.
    const gap = (lines[1]?.at ?? 0) - (lines[0]?.at ?? 0);
    expect(gap).toBeGreaterThanOrEqual(30);
    expect(gap).toBeLessThan(400);
  });
});

describe('FakeHub + TcpSource end to end', () => {
  it('drops clients during a scripted outage and the adapter reconnects', async () => {
    const port = await freePort();
    const scenario: Scenario = {
      id: 'outage',
      name: 'outage',
      description: '',
      expectation: 'n/a for this unit test',
      durationS: 60,
      startEpochMs: Date.UTC(2026, 8, 11),
      boat: DEFAULT_SIM_BOAT,
      commands: [],
      state: (t) => ({
        ...baseState(Date.UTC(2026, 8, 11) + t * 1000),
        position: SIM_ANCHOR,
        connected: !(t >= 4 && t < 8),
      }),
    };
    const hub = new FakeHub({ scenario, port, host: '127.0.0.1', speed: 40, loop: true });
    await hub.start();
    cleanups.push(() => hub.stop());
    const src = new TcpSource({ host: '127.0.0.1', port, backoffCapMs: 50, idleTimeoutMs: 1000 });
    const states: string[] = [];
    let lines = 0;
    src.on((e) => {
      if (e.type === 'state') states.push(e.state.kind);
      if (e.type === 'line') lines++;
    });
    src.start();
    cleanups.push(() => src.stop());
    await until(() => lines > 5);
    await until(() => states.includes('disconnected'), 5000);
    const before = lines;
    await until(() => states.filter((s) => s === 'connected').length >= 2, 5000);
    await until(() => lines > before + 5, 5000);
  });
});
