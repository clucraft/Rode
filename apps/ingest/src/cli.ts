#!/usr/bin/env node
/*
 * rode-sim — simulator, recorder and replay tooling.
 *
 *   rode-sim list                                  list scenarios
 *   rode-sim run <scenario>                        headless run, print the event log
 *   rode-sim serve --scenario <id> [--port 39150] [--speed 60] [--loop] [--udp-port 39151]
 *                                                  fake Cortex hub on TCP (+UDP)
 *   rode-sim record --host <ip> [--port 39150] [--out recordings/<date>.nmea]
 *                                                  capture the real hub to a file
 *   rode-sim replay --file <path> [--port 39150] [--speed 1] [--loop]
 *                                                  serve a recording as a fake hub
 */
import net from 'node:net';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findScenario, SCENARIOS } from './sim/scenarios/index.js';
import { runScenario } from './sim/run.js';
import { FakeHub } from './sim/server.js';
import { TcpSource } from './sources/tcp.js';
import { Recorder, ReplaySource } from './sources/replay.js';

const [command, ...rest] = process.argv.slice(2);

function usage(code: number): never {
  const text = `rode-sim <command> [options]

  list                      List scenarios
  run <scenario>            Headless run through the real engine; prints the event log
  serve --scenario <id>     Fake Cortex hub: --port 39150 --speed 60 --loop --udp-port <port>
  record --host <ip>        Record the live stream: --port 39150 --out recordings/<date>.nmea
  replay --file <path>      Serve a recording as a fake hub: --port 39150 --speed 1 --loop
`;
  (code === 0 ? console.log : console.error)(text);
  process.exit(code);
}

const opts = {
  scenario: { type: 'string' as const },
  port: { type: 'string' as const },
  host: { type: 'string' as const },
  speed: { type: 'string' as const },
  loop: { type: 'boolean' as const },
  'udp-port': { type: 'string' as const },
  out: { type: 'string' as const },
  file: { type: 'string' as const },
  help: { type: 'boolean' as const, short: 'h' },
};

function num(v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    console.error(`not a number: ${v}`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ args: rest, options: opts, allowPositionals: true });
  if (values.help || !command) usage(command ? 0 : 2);

  switch (command) {
    case 'list': {
      for (const s of SCENARIOS) {
        console.log(`${s.id.padEnd(24)} ${s.name.padEnd(24)} ${Math.round(s.durationS / 60)} min`);
        console.log(`${''.padEnd(24)} ${s.description}`);
        console.log(`${''.padEnd(24)} expect: ${s.expectation}\n`);
      }
      return;
    }
    case 'run': {
      const id = positionals[0] ?? values.scenario;
      const scenario = id ? findScenario(id) : undefined;
      if (!scenario) {
        console.error(`unknown scenario: ${id ?? '(none)'}; try: rode-sim list`);
        process.exit(2);
      }
      const started = Date.now();
      const r = runScenario(scenario);
      const t0 = scenario.startEpochMs;
      for (const e of r.events) {
        const t = ((e.at - t0) / 1000).toFixed(0).padStart(6);
        const { at: _at, type, ...restOfEvent } = e;
        console.log(`t=${t}s  ${type.padEnd(22)} ${JSON.stringify(restOfEvent)}`);
      }
      console.log(
        `\n${scenario.id}: ${r.events.length} events, final state ${r.finalState.stateName}, ` +
          `${r.normalizer.counters.sentences} sentences in ${Date.now() - started} ms`,
      );
      console.log(`expected: ${scenario.expectation}`);
      return;
    }
    case 'serve': {
      const scenario = values.scenario ? findScenario(values.scenario) : undefined;
      if (!scenario) {
        console.error(`--scenario is required; try: rode-sim list`);
        process.exit(2);
      }
      const udpPort = values['udp-port'] ? num(values['udp-port'], 39151) : undefined;
      const hub = new FakeHub({
        scenario,
        port: num(values.port, 39150),
        ...(values.host ? { host: values.host } : {}),
        speed: num(values.speed, 1),
        loop: values.loop ?? false,
        udp: udpPort === undefined ? undefined : { port: udpPort },
        log: (m) => console.error(m),
      });
      await hub.start();
      onExit(() => hub.stop());
      return;
    }
    case 'record': {
      if (!values.host) {
        console.error('--host is required (the Cortex hub address from the Onboard app)');
        process.exit(2);
      }
      const out =
        values.out ??
        path.join('recordings', `${new Date().toISOString().replace(/[:.]/g, '-')}.nmea`);
      mkdirSync(path.dirname(out), { recursive: true });
      const source = new TcpSource({ host: values.host, port: num(values.port, 39150) });
      const recorder = new Recorder({ path: out });
      recorder.attach(source);
      source.on((e) => {
        if (e.type === 'state')
          console.error(
            `source: ${e.state.kind}${'reason' in e.state && e.state.reason ? ` (${e.state.reason})` : ''}`,
          );
      });
      source.start();
      console.error(
        `recording ${values.host}:${num(values.port, 39150)} → ${out} (Ctrl-C to stop)`,
      );
      const report = setInterval(
        () => console.error(`  ${recorder.lines} lines, ${(recorder.bytes / 1024).toFixed(0)} KiB`),
        10_000,
      );
      onExit(async () => {
        clearInterval(report);
        await source.stop();
        await recorder.stop();
        console.error(`saved ${recorder.lines} lines to ${out}`);
      });
      return;
    }
    case 'replay': {
      if (!values.file) {
        console.error('--file is required');
        process.exit(2);
      }
      const port = num(values.port, 39150);
      const clients = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        clients.add(socket);
        socket.on('close', () => clients.delete(socket));
        socket.on('error', () => clients.delete(socket));
      });
      await new Promise<void>((resolve) => server.listen(port, values.host ?? '0.0.0.0', resolve));
      const source = new ReplaySource({
        path: values.file,
        speed: num(values.speed, 1),
        loop: values.loop ?? false,
      });
      source.on((e) => {
        if (e.type === 'line') for (const c of clients) c.write(`${e.line}\r\n`);
        if (e.type === 'state') console.error(`replay: ${e.state.kind}`);
      });
      source.start();
      console.error(`replaying ${values.file} on tcp :${port} at ${num(values.speed, 1)}x`);
      onExit(async () => {
        await source.stop();
        for (const c of clients) c.destroy();
        server.close();
      });
      return;
    }
    default:
      usage(2);
  }
}

function onExit(fn: () => Promise<void> | void): void {
  const handler = () => {
    void Promise.resolve(fn()).finally(() => process.exit(0));
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
