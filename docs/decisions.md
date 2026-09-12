# Architectural decisions

Each entry records a non-obvious choice and the reasoning behind it, so that
whoever maintains this at 0300 in a rolling anchorage knows _why_ and not only
_what_. Newest at the bottom. Reversals are appended, not edited away.

Format: context, decision, consequences.

---

## 0.1 — Ingest directly from the Cortex; Signal K is optional, not required

**Context.** The Cortex M1 exposes a raw NMEA 0183 stream over TCP/UDP. A
Signal K server could sit between the Cortex and Rode, normalising data for us.

**Decision.** `nmea0183-tcp` is the primary adapter. `signalk-ws` is a second
adapter for owners who already run Signal K. Signal K is never a dependency.

**Why.**

- Signal K is a second Node process with a plugin ecosystem: RAM and CPU on a
  Pi that runs off a house bank, and a second thing that can fail silently.
- A safety system should observe the real socket. If the Cortex drops, Rode's
  liveness check must see it directly, not through a proxy that may keep a
  stale "connected" state.
- The sentence set we need (spec §5.2) is small and well-specified; parsing it
  is not the hard part of this project.

**Consequences.** Rode carries its own parser and normaliser. The Signal K
adapter maps SK paths to the same internal model and gets the same tests.

## 0.2 — Alarm engine runs in the `server` process, not a separate one

**Context.** The spec asks whether the engine should be isolated in its own
process so that a crash in request handling can never take down the watch.

**Decision.** One process. Ingest, engine, API and WebSocket fanout share a
Node event loop. The engine is a pure state machine in `@rode/core` driven by a
thin host in `apps/server/src/engine/`; the host is the only thing that touches
the database or the clock.

**Why.**

- Fastify has a per-route error boundary. A thrown error in a handler is a
  500 response, not a process crash. The realistic "request crash" does not
  reach the engine.
- Truly uncaught exceptions get a process-level handler that flushes state and
  exits fast. Docker restarts the container; boot rehydrates the anchor session
  from SQLite in seconds; the missing clean-shutdown flag fires an "unexpected
  restart" notification. Bounded, and loud.
- Two processes need IPC, and IPC is a new place for the engine and the UI to
  silently disagree, which is the exact class of bug the spec warns about.
  In-process, the WebSocket view reads the engine's memory; nothing can go
  stale between them.
- The failure a second process would guard against (event-loop starvation) is
  covered by the supervisor heartbeat (spec §9), which restarts the container
  via `readyz`.
- One Node process is roughly 70 MB; two is double, on a box with a power budget.

**Consequences.** The engine host is behind an explicit interface. If field
experience proves this wrong, moving it to a child process is a contained
change: the core is already pure.

## 0.3 — `ingest` and `server` are one container

**Context.** The spec lists them as separate services but allows merging with
justification.

**Decision.** `@rode/ingest` is a library consumed by `@rode/server` in the
same process. The `rode-sim` CLI runs the simulator standalone as a fake
Cortex (a TCP server emitting NMEA), which exercises the real TCP adapter path
in development and in integration tests.

**Why.** Same reasoning as 0.2: the internal bus is in-process pub/sub with a
persisted last-known-state snapshot; a second container would need a socket
protocol between them for no isolation gain. Ingestion restarts are handled at
the module level: the adapter has `start`/`stop` and owns no session state.

## 0.4 — SQLite in WAL mode, one file

Chosen by the spec; recorded here for completeness. `better-sqlite3`
(synchronous, in-process) over a client/server database. Survives yanked power
better, `cp` is a backup, and it runs comfortably on a Pi. A nightly job
downsamples `samples` older than 48 h to 10 s and prunes past retention.

## 0.5 — SI internally, always

Metres, m/s, radians, kelvin, epoch milliseconds UTC. Conversion happens in
exactly two places: the parser (in) and the display layer (out). `@rode/core`
never sees a knot or a foot. This is the single easiest way to get the rode
math wrong, and the bug would not show until someone drags.

## 0.6 — TypeScript 5.9, not 6 or 7

`typescript-eslint` caps supported TypeScript below 6.1 and the 7.x native
compiler is not yet supported by the lint toolchain. Type-aware lint rules
(`no-floating-promises`, exhaustive switches) matter more here than compiler
speed. Revisit when typescript-eslint supports 7.

## 0.7 — Workspace packages export TypeScript source; apps bundle

`@rode/core`, `@rode/protocol` and `@rode/ingest` expose `src/index.ts`
directly. `apps/server` bundles them with tsup into one ESM file; `apps/web`
bundles with Vite. No `dist/` in library packages, no project references, no
build-order problems, and Vitest runs against source.

## 0.8 — Makefile over justfile

Both were allowed. `make` is present on Raspberry Pi OS and Debian by default
and the target list is short. Every target is also a `pnpm` script so Windows
developers without `make` are not stranded.

## 0.9 — Health probes hit `/readyz`, not `/healthz`

`healthz` proves the process is alive. `readyz` proves the database is open and
the alarm engine's heartbeat counter is advancing. Docker's healthcheck uses
`readyz` so a wedged engine, alive but not evaluating, gets restarted. This is
the "process is up but not doing its job" failure the spec's prior art hit.
