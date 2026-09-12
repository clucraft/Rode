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

## 1.1 — Lat/lon in decimal degrees; every other angle in radians

**Context.** The spec says "radians internally". Applied literally that
includes latitude and longitude.

**Decision.** Positions are `{ lat, lon }` in decimal degrees (WGS84).
Heading, COG, bearings and wind angles are radians.

**Why.** Every map library, NMEA sentence, chart and human takes lat/lon in
degrees; storing radians in SQLite makes debugging at 0300 harder for no
numerical gain. The angles where deg/rad mix-ups actually bite (wind angle vs.
window, heading rotation of the antenna offset) are the ones held in radians,
and the geodesy functions convert internally.

## 1.2 — WARNING and ALARM are derived, not stored

**Decision.** The persisted phase is one of IDLE / DROPPING / SET / MARINA.
WARNING and ALARM are computed from the set of active conditions, each of
which carries its own severity, timestamp and the values that caused it.

**Why.** It makes "ack silences audio but never clears the condition" a
structural property rather than a rule to remember: an ack touches the ack
record; the conditions stay; the derived state stays ALARM. It also means
several conditions can coexist (GPS stale _and_ outside the circle) and each
clears on its own evidence, with its own event in the log.

## 1.3 — Every detector holds on missing data, suppresses on bad data

**Decision.** `sustainedStep` takes `true | false | null`. `null` freezes the
detector (no accumulation, no clearing); `false` counts toward clearing.

**Why.** A position detector fed no position must not fire _or_ clear: it
cannot know, and the GPS-staleness alarm is already shouting. A wind detector
fed 3 kn of apparent wind must clear: the vane is spinning freely and its
angle means nothing. The two cases are different and the type makes the
caller choose.

## 3.1 — Idle timeout on the TCP source is a liveness check, not a nicety

**Context.** WiFi between the box and the Cortex drops routinely. The TCP
stack does not notice for minutes: the socket stays "connected" and simply
never delivers another byte. That is a silent failure of exactly the kind
the spec's prior art warns about.

**Decision.** `TcpSource` destroys and reconnects any socket that is silent
for 15 s (configurable). A Cortex emits several sentences a second, so
silence is a broken link. UDP has no connection at all; there, "connected"
literally means "datagrams are arriving".

## 3.2 — The simulator is a fake hub, not a fake adapter

**Decision.** `rode-sim serve` is a TCP server emitting the scenario's NMEA
stream; `SimulatorSource` exists for in-process use but the compose dev
stack points the _real_ `nmea0183-tcp` adapter at the fake hub. When a
scenario says the hub is down, the fake hub closes its listener and drops
every client.

**Why.** The reconnect path is where the interesting bugs live. Simulating
"disconnected" inside an adapter tests nothing about the adapter.

## 3.3 — Recording format is `<epochMs>\t<sentence>`

One line per sentence, tab-separated, append-only. Trivially greppable,
replayable with original timing, and a bare NMEA log from any other tool
(no tab) still replays at a fixed rate. Real recordings from the boat become
test fixtures without conversion.

## 4.1 — Engine state and events commit in one transaction

**Decision.** `EngineHost.persist` writes the serialised WatchState and
appends the events that tick produced inside a single SQLite transaction.
Every event forces a write; otherwise state is written every 15 s.

**Why.** If power goes between "engine raised ALARM" and "event logged", the
disk must not end up with one and not the other. The 15 s periodic write
keeps detector timers roughly current across a restart without writing at
1 Hz to an SD card.

## 4.2 — Samples are buffered, never written at 1 Hz

**Decision.** `SampleWriter` captures one row per second in memory and
flushes every 10 s in one transaction. Rows with no usable position are not
written at all.

**Why.** The spec's power budget. Ten small transactions a minute is nothing;
sixty is a needless SD-card workout. The alarm engine never reads this table.

## 4.3 — Every route reads the clock from the context, never `Date.now()`

**Decision.** `AppContext.now` is the process clock; services, routes and
the WebSocket layer all use it.

**Why.** Tests drive the engine with a fake clock. The first version of the
readiness check used `Date.now()` and declared a perfectly healthy engine
stalled because its last tick was "in 2026". The bug was in a test, but the
class of bug (two clocks in one process) is exactly what bites on a Pi with
no RTC when GPS time arrives.

## 5.1 — Session cookie `Secure` flag follows `RODE_TLS`, not the environment

**Decision.** The cookie is `HttpOnly; SameSite=Lax`, and `Secure` only when
`RODE_TLS=true`.

**Why.** The typical deployment is a Tailscale address over plain HTTP on a
private network. A `Secure` cookie on `http://` is silently dropped by the
browser and the login "succeeds" then immediately forgets you: a silent
failure of exactly the kind this project exists to avoid. Owners who
terminate TLS (Caddy profile, Tailscale certs) set `RODE_TLS=true` and get
`Secure` plus HSTS.

## 5.2 — TOTP implemented on `node:crypto`, not a library

Thirty lines of RFC 6238 (HMAC-SHA1, base32) with the published test vector
in the suite, versus another dependency in a safety-critical container. The
verification window is ±1 step because a Pi with no NTP and a phone can
disagree by a minute.

## 5.3 — Session ids and API tokens are stored hashed

The database is on the boat and gets copied around for backups. A copied
`rode.db` must not contain anything that logs you in. Sessions and tokens
are 256-bit random values whose SHA-256 is the primary key; recovery codes
likewise. Passwords are argon2id (19 MiB, t=2).

## 5.4 — API tokens read what crew reads, nothing else

A Home Assistant or Grafana token is a Bearer credential with no CSRF
protection, so it is confined to safe methods and to crew-level endpoints.
It cannot ack, drop or reconfigure anything.

## 6.1 — Day mode is light, not dark

**Context.** Marine apps default to dark themes. The spec asks for colours
that survive direct sunlight on deck _and_ a red-shifted night mode.

**Decision.** Day is warm paper with black ink and saturated marks; night is
black with everything red-shifted. There is no third "dark" theme.

**Why.** In direct sun a light background with black text is far more
legible than any dark theme; at 0300 only red-on-black preserves dark
adaptation. A dark-grey theme serves neither environment well. Alarm state
is carried by shape (octagon, triangle, ring), border weight, motion and
text, so it survives both palettes and colour-blindness.

## 6.2 — Alarm audio shows the real armed state

The "Enable alarm sound on this device" control reflects whether the
AudioContext is actually running, checked via `onstatechange`, not a stored
preference. After a reload it says "tap to re-arm" rather than pretending.
A safety app that looks armed but is muted is the worst outcome.

## 6.3 — The browser never computes alarm state

`api/store.ts` mirrors the server's `FullState` and applies deltas. Distance,
scope, radius, conditions and snooze all come from the server; the web app
only formats them. The one client-side computation is unit conversion in
`lib/format.ts`. When the link drops the UI shows the last known state with
an OFFLINE banner and disables every command.

## 6.4 — react-router, no state library, no CSS framework

Five screens do not justify Redux; a single `useSyncExternalStore` store
mirrors the WebSocket. Plain CSS with custom properties keeps the instrument
aesthetic under control and the bundle at ~108 KB gzipped, which matters on
a metered cellular link.

## 7.1 — Notification secrets live in the database, masked on the way out

**Context.** Tokens for ntfy/Pushover/Telegram must be editable from the
UI, and `.env` is the only other place they could live.

**Decision.** Stored in the `settings` table under `notifications`. The
admin API returns every secret as `••••••••`; a PUT that sends the mask
back keeps the stored value. Environment variables (`RODE_NTFY_URL` and
friends) form an extra implicit recipient named `environment` so a compose
file alone can configure push without touching the UI. Nothing in either
path is ever logged (pino redaction covers `*.token`, `*.password`).

## 7.2 — Every delivery attempt is an event

`notification-sent` and `notification-failed` go into the append-only log
with recipient, channel, attempt, status and duration. The newest success
anywhere is the "notifications last confirmed working" timestamp shown in
the status strip. The anchor-set and weigh confirmations exist to make that
timestamp fresh at the moment the crew is paying attention.

## 7.3 — Pushover criticals use emergency priority

Priority 2 repeats every 60 s for an hour until the phone acknowledges. That
is intrusive by design: it is the "get up now" tier. Warnings use priority
1 (high, respects quiet hours). ntfy criticals use priority 5, which maps to
iOS critical alerts when the app is set up for them.

## 7.4 — The supervisor restarts the tick loop in-process first

When the engine heartbeat stops advancing for 15 s the supervisor logs a
critical event, notifies, and calls `engine.stop(); engine.start()`.
`/readyz` has already gone 503, so if that does not take, Docker restarts
the container. Two layers, because the second one costs a rehydration and a
notification of its own.

## 8.1 — `index.html` is never cached; hashed assets are cached forever

Found by running the app: the shell was served with a one-hour cache and a
phone kept the old bundle against a newer server. Vite fingerprints
everything under `assets/`, so those get `immutable`; the shell, manifest
and service worker get `no-cache` so they always revalidate.

## 8.2 — Marina monitors live under the same thresholds page

Fridge/freezer bands, battery holds and the solar window are edited next
to the anchor thresholds, each with its default and reason, converted to
the boat's temperature unit at the edge. They only run in marina mode.

## 9.1 — The chart is a lazy chunk; the polar view is the product

MapLibre and its CSS are a separate ~280 KB gzipped chunk fetched only when
the owner taps "Chart" on a boat that has `RODE_TILES_URL` set. The default
bundle stays at ~115 KB gzipped for the dinghy-on-LTE case. Style or
TileJSON failures disable the button with the reason; they never replace
the polar view with an error.

## 9.2 — Hand-written service worker, no Workbox

Three rules fit in sixty lines: hashed assets cache-first, the shell
network-first with cache fallback, `/api` and `/ws` untouched. Workbox would
add a build step and a dependency to do the same. The worker registers only
in production builds so development never serves a stale bundle.

## 10.1 — Debian slim, not Alpine, for the runtime image

`better-sqlite3` and `argon2` publish prebuilt binaries for glibc on
amd64 and arm64. On Alpine (musl) the arm64 build compiles both under QEMU,
which takes ten-plus minutes and fails on the first toolchain hiccup. The
image is ~50 MB larger; the build is reliable. The base image is pinned by
its multi-arch index digest and bumped deliberately.

## 10.2 — Backups are `VACUUM INTO`, available from the phone

`make backup` runs `node dist/backup.js` inside the container and copies
the result out; Settings › Diagnostics has a download link that does the
same over HTTPS. Both produce a compact, consistent copy while the server
is writing. `cp rode.db` also works with WAL, but a copy taken mid-checkpoint
can need the `-wal` file next to it; `VACUUM INTO` never does.

## 10.3 — Healthcheck is a 400-byte node script

Debian slim has neither `wget` nor `curl`. Installing one adds packages to
a read-only image for one probe; spawning node every 30 s costs a few
milliseconds of CPU on a Pi 5. The script hits `/readyz`, so a wedged engine
fails the check.
