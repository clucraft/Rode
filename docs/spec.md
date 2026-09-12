# Build "Rode" — a self-hosted boat monitor and anchor watch

Paste everything below into Claude Code as the opening prompt. It assumes an empty repo.

---

## 1. What you're building

**Rode** is a Dockerized, self-hosted monitoring system for a sailboat/powerboat fitted with a **Vesper Marine Cortex M1** AIS/VHF hub. It runs on a small always-on computer aboard the vessel, ingests live NMEA data from the Cortex over WiFi, and serves a mobile-first, password-protected web app the owner can open from a phone — on board, from the dinghy, or from a bar ashore over cellular.

Its headline feature is a **custom anchor watch** that is materially better than the radius-only alarms built into chartplotters and phone apps: it measures actual rode paid out, computes real scope, warns before it alarms, and — critically — detects its own failures.

The name: *rode* is the anchor line. Everything the system does hangs off knowing how much of it is out.

### Why not just use the Cortex's own features

The Cortex has a native anchor watch and a cloud monitoring service, but there is **no public API** to read its anchor-watch state or receive its alarm events. What the Cortex *does* expose is a generous stream of NMEA 0183 sentences over WiFi/TCP — AIS, GPS, heading, plus anything translated in from the NMEA 2000 bus (depth, wind, temps, tanks). So Rode consumes the raw data and implements the watch logic itself.

### Prior art to learn from, not copy

A cruising couple built something similar on Home Assistant + Signal K and published their hard-won lessons (svsabado.com, Aug 2026). The specific thresholds and failure modes in section 6 come from that real-world experience. Their headline finding, which should shape your engineering throughout: **every serious bug they hit was a silent one** — notifications that quietly stopped sending, a freezer alarm that cleared itself by failing further, a mode that never restored its UI after reboot while still running underneath. Most of their work went into catching silent failures, not into the alarms you can hear. Build accordingly.

---

## 2. Non-negotiables

This is a safety system. These are hard requirements, not preferences.

1. **The alarm engine evaluates server-side, always.** It must never depend on a browser being open, a phone being awake, or a WebSocket being connected. The web app is a *view* of the alarm state, never the thing computing it.
2. **No silent failures.** Every path that can fail quietly gets a liveness check: notification delivery, GPS freshness, data-source connection, the process itself. When in doubt, alert.
3. **Fail loud, fail toward alarming.** Missing data is an alarm condition, not a reason to stay quiet.
4. **Survives hard power loss.** Boats get switched off at the battery isolator mid-write. No corruption, no lost anchor session, clean restart into the correct state.
5. **Works with zero internet.** Full functionality on the boat's LAN. Remote access and push notifications are additive, not load-bearing.
6. **Every state transition is persisted to an append-only event log** with a timestamp and the values that caused it. When something goes wrong at 0300 the owner needs to reconstruct what happened.
7. **No default credentials, ever.** First run is a setup wizard.
8. **The UI must state plainly that it does not replace a proper anchor watch or keeping a lookout.** One line, in Settings and in the About screen. Not a modal that nags.

---

## 3. Deployment context

- **Target hardware:** Raspberry Pi 5 (arm64) or an N100 mini PC (amd64). Build multi-arch images. Assume 4–8 GB RAM and an SSD or good SD card.
- **Power budget matters.** The box runs off a house battery bank at anchor. Target < 10% CPU at idle on a Pi 5. No busy-polling, no chatty 10 Hz writes to disk, no headless Chrome.
- **Network:** the box sits on the boat's LAN alongside the Cortex hub and a cellular router. Remote access is via Tailscale or WireGuard (carrier CGNAT makes port-forwarding a non-starter) — assume the tunnel exists, do not build it.
- **No RTC on a Pi.** Clock may be wrong at boot with no internet. Take time from GPS (RMC/ZDA sentences) as a fallback and treat "time not yet synced" as an explicit state rather than silently logging 1970 timestamps.
- **Cellular link is slow, expensive and intermittent.** The web app must be usable on a bad LTE connection from a dinghy.

---

## 4. Architecture

A Docker Compose stack. Keep the service count low — fewer moving parts is a marine virtue.

```
rode/
  apps/
    ingest/      NMEA acquisition + normalization + simulator
    server/      API, auth, alarm engine, notifications, scheduler
    web/         React PWA
  packages/
    core/        units, geodesy, rode/scope math, alarm state machine (pure, heavily tested)
    protocol/    shared TypeScript types for the WS/REST contract
  docker/
  docs/
```

**Language:** TypeScript end to end (Node 22 LTS). One toolchain, shared types between the alarm engine and the UI, and the pure-math package is trivially unit-testable. Use pnpm workspaces.

**Services in compose:**

| Service | Role |
|---|---|
| `ingest` | Connects to the data source, parses, normalizes, publishes to the bus, writes samples |
| `server` | Fastify API + WebSocket, alarm engine, auth, notifications, cron jobs |
| `web` | Static build served by `server` in production (one fewer container); Vite dev server in development |
| `tiles` | Optional profile. TileServer-GL serving local MBTiles for offline charts |
| `mosquitto` | Optional profile. MQTT bridge for Home Assistant / external siren |

`ingest` and `server` may be one container if you can justify it, but keep the module boundary clean — ingestion must be restartable without dropping the anchor session.

**Internal bus:** do not add Redis for this. Use a Unix socket or a small in-process pub/sub with a persisted last-known-state snapshot. Fewer containers, less RAM, one less thing to fail.

**Storage: SQLite, WAL mode, one file.** Deliberate choice over Postgres/Timescale — it survives yanked power better with fewer moving parts, backup is `cp rode.db`, and it runs comfortably on a Pi. Schema:
- `users`, `sessions`, `settings`
- `anchor_sessions` — one row per drop-to-weigh cycle, with all the derived geometry
- `events` — append-only, every state transition, alarm, ack, notification attempt and result
- `samples` — normalized telemetry at 1 Hz, with a nightly job downsampling anything older than 48 h to 10 s intervals and pruning past the retention setting (default 180 days)

Do not write position at 10 Hz to disk. 1 Hz is plenty for track history; the alarm engine works off the in-memory stream.

---

## 5. Data ingestion

### 5.1 Sources

Build an adapter interface with three implementations, selectable by config:

1. **`nmea0183-tcp` (primary).** Opens a TCP socket to the Cortex hub and parses the NMEA 0183 sentence stream. Host and port must be configurable — do not hardcode. Document in the README that the user finds the hub's IP via the Cortex Onboard app and that Vesper transponders have historically served this on port 39150, but they must verify. Support UDP as an alternate transport.
2. **`signalk-ws`.** Subscribes to a Signal K server's delta stream if the owner already runs one. Map Signal K paths to the internal model.
3. **`simulator`.** See section 12. Mandatory, not optional.

Auto-reconnect with exponential backoff capped at 30 s. Connection state is first-class: exposed on the API, visible in the UI, and an alarm input.

### 5.2 Sentences to parse

`GGA`, `RMC`, `GLL`, `VTG`, `ZDA` (position, SOG, COG, time, fix quality, HDOP, satellites), `HDG`/`HDT`/`HDM` (heading), `DBT`/`DPT` (depth — capture the transducer offset), `MWV`/`MWD`/`VWR` (apparent and true wind), `MTW`/`MDA` (water and air temp), `XDR` (generic transducers — battery voltage, tank levels), `VDM`/`VDO` (AIS — decode with a maintained library, don't write an AIS decoder).

Ignore unknown sentences silently but count them, and expose the counts in a diagnostics view. Log checksum failures as a rate, not as a line per failure.

### 5.3 Normalization

**Store and compute in SI internally. Always.** Meters, m/s, radians, Kelvin, ISO 8601 UTC. Convert only at the display layer, per-user. This is the single easiest way to get the rode math wrong and you will not notice until someone drags.

Every normalized value carries `{ value, timestamp, source, stale: boolean }`. Staleness is per-field with per-field max-age — depth going stale is normal when the sounder is off; position going stale is an emergency.

Handle the **GPS antenna offset**: the Cortex's GNSS antenna is not at the bow roller. Make the offset (X/Y from the antenna to the bow roller, and bow roller height above waterline) a configuration input, and apply it using current heading when computing anchor geometry. Most anchor alarms skip this and it's worth several metres of false radius.

---

## 6. The anchor watch engine

The heart of the project. Implement as a pure state machine in `packages/core` with no I/O, driven by normalized samples, fully unit-tested.

### 6.1 States

```
IDLE ──drop──> DROPPING ──set──> SET ──┬──> WARNING ──> ALARM
  ^                │                    │       │          │
  │                │                    └───────┴──ack─────┘
  └────────weigh───┴────────────────────────────┘

IDLE ──marina──> MARINA ──> WARNING/ALARM
```

- **IDLE** — underway or not watching. The anchor screen shows a live suggested rode based on current depth so the skipper knows what to pay out *before* the hook goes down.
- **DROPPING** — skipper presses **Drop anchor** as the anchor hits bottom. Record position (corrected to the bow roller) and depth at that instant. Start accumulating the track.
- **SET** — skipper presses **Anchor set** after backing down. Compute the geometry (6.2) and start watching.
- **WARNING** / **ALARM** — see 6.3 and 6.4.
- **MARINA** — section 7.

Transitions are idempotent and survive a restart: on boot, `server` rehydrates the active session from SQLite and resumes watching within seconds. **Weigh anchor requires a confirmation prompt** — one accidental tap must not wipe a session.

### 6.2 Geometry — measure it, don't assume it

The whole point. Do not use a flat assumed scope ratio.

At **Anchor set**, compute:

```
horizontalRun = great-circle distance from drop position to set position
verticalDrop  = depthAtDrop + bowRollerHeightAboveWaterline
rodeLength    = sqrt(horizontalRun² + verticalDrop²)
scopeRatio    = rodeLength / verticalDrop
swingRadius   = horizontalRun + swingMargin
```

Notes that matter:

- **Depth is captured once, at drop, and reused for the whole session.** The sounder gets powered down overnight; scope and rode must stay valid without it. If depth is unavailable at drop, prompt for a manual entry rather than guessing.
- `swingMargin` accounts for GPS error, veering, and rode stretch. Default it to a configurable absolute distance (suggest 15 m / 50 ft), and add a term for current HDOP-derived position uncertainty.
- Tidal range is a real second-order effect on scope. Add an optional manual "expected tide rise" input that widens the radius accordingly; don't try to fetch tide tables.
- Let the skipper **nudge the anchor position** on the chart afterwards if the recorded drop point was off, and recompute cleanly.
- Show the computed scope prominently. Skippers routinely believe they have more rode out than they do — surfacing the measured truth is half the value of this feature.

### 6.3 Early warnings — catch it developing, not after

Three independent detectors, each requiring a **sustained** condition to fire (no single-sample triggers).

| Detector | Condition | Default |
|---|---|---|
| Position | Boat within `warnDistance` of the swing circle edge | 10 m / 30 ft, **absolute, not a percentage** |
| Wind angle | Apparent wind angle outside ±`awaWindow` from the bow, continuously | ±70°, 30 s, **suppressed below 5 kn apparent** |
| Speed | SOG sustained above threshold | 1.2 kn, 30 s |

The reasons these specific numbers exist, from the field:

- **Percentage-based position warnings are useless at tight radii** — they fire constantly and the crew learns to ignore them. Fixed distance from the edge works at any radius.
- **A wind vane spins freely in light air and reports garbage.** Without the 5 kn floor you get false alarms on the calmest, most pleasant nights, which is exactly how a safety system loses credibility.
- **0.5 kn SOG sits inside GPS noise.** 1.2 kn was the value that stopped tripping on calm nights.

Every threshold is configurable in the UI with the default and a one-line explanation of *why* it's that value. Ship a "restore recommended defaults" button.

**If the wind-angle and speed detectors fire simultaneously, escalate straight to critical** — that combination is a boat that has broken out and is moving, and it should bypass Do Not Disturb.

### 6.4 Alarm conditions

- Boat position outside the swing circle (the primary).
- Both early-warning detectors active at once.
- **GPS staleness: warning at 30 s without a position update, critical at 60 s, auto-clear when it returns.** This was added after the fact on the system that inspired it, and the lesson was that it should have been in v1 — an anchor watch with no position is blind and does not know it. Treat it as a first-class alarm, not a diagnostic.
- Data source disconnected beyond a grace period.
- Depth below a configurable minimum, if a live sounder is present (shoaling on a falling tide).
- Entry into an exclusion zone (section 8).

### 6.5 Acknowledgement

Acking silences audio for a configurable snooze (default 10 min) but **never clears the underlying condition** — the UI stays in an alarm state, visually unmistakable, until the condition itself resolves. Log who acked, when, and what the values were at that moment. Re-fire after snooze if still alarming, at escalating volume.

---

## 7. Marina mode

A completely separate watch profile for when the boat is in a slip and nobody is aboard for weeks. One button, no drop-and-set sequence: record current position, apply a tight radius, start watching.

Rode and scope math is meaningless in a slip, and the **wind-shift detector must be disabled** — a docked boat doesn't weathervane, so it would fire constantly.

What marina mode watches instead:

- **Position and SOG** — a boat moving in a marina is always wrong.
- **Battery state of charge** — if the telemetry is available via XDR or an optional Victron/Cerbo integration. The threshold must tolerate a normal overnight dip and recovery and only complain when something is genuinely wrong.
- **Solar yield** — near-zero production by mid-afternoon means a controller, breaker or DVCC failure, and that's actionable days before the batteries get low.
- **Refrigeration** — with the subtlety that makes it actually work: distinguish "off" from "failing" by temperature. A box reading ambient was deliberately shut down; a box at 14 °C while running is dying. And handle the trap — **a freezer that fails while nobody is aboard climbs through the alarm band and eventually reaches ambient, where it reads as "off" and the alarm clears itself.** Do not solve this by latching the alarm (a temperature spike from loading provisions then leaves a sticky alarm that can't be cleared). Instead, **notify on every state transition, including the transition into the "off" band.** Current state may return to normal on its own; the message history doesn't disappear.
- **Unexpected reboot** — always notify. A restart while the owner is away is exactly the thing not to paper over.

### The daily heartbeat

Every morning at a configurable local time, send both configured recipients a status snapshot: position, battery SoC, solar yield, fridge and freezer temps, GPS health, uptime, last data-source reconnect.

The reasoning is worth encoding in a code comment: three weeks of silence is ambiguous when you're a thousand miles away — is everything fine, or did the system die on day two? **A daily message turns silence into a signal.** If it stops arriving, something is wrong.

---

## 8. Exclusion zones

Let the owner draw polygons on the chart — a reef, a shoal, a lee shore, a cable area — and check boat position against them **independently of the swing radius**.

The scenario this solves: anchored off a reef, the wind normally holds the boat over open water, but if it dies the boat can swing or drift onto coral that sits well inside the alarm circle. A radius-only alarm never fires.

Zones persist across sessions, can be named and toggled, and support both "never enter" and "must stay inside" (a fairway or a channel) semantics. Alarm on projected entry too, using current SOG/COG, with a configurable look-ahead.

---

## 9. Alarms and notification delivery

### Channels

- **In-app audio.** Escalating tones, distinct for warning versus critical. Note the iOS constraint: audio cannot start without a user gesture, so require an explicit "Enable alarm sound on this device" tap and show unmistakably whether audio is armed on *this* device. A safety app that looks armed but is muted is the worst outcome.
- **Push.** Support **ntfy** (self-hostable, free, good iOS critical-alert support), **Pushover**, and **Telegram**. Critical alarms use maximum priority and bypass Do Not Disturb where the platform allows.
- **Webhook / MQTT out.** So the owner can fire a Zigbee siren, a relay, or a Home Assistant automation. Loud local noise matters when the phone is ashore and the boat is not.
- **Optional email** via SMTP for the daily heartbeat only.

Multiple recipients, each with per-channel and per-severity routing. Warnings and criticals must sound and read differently — there is a real difference between "look at this" and "get up now."

### Delivery must be verified, not assumed

Every notification attempt is logged with its result. Retry with backoff. Surface a **"notifications last confirmed working: 3 minutes ago"** indicator in the UI.

And the trick that makes this robust: **on every anchor set and every weigh, send a confirmation notification.**

> "Anchor watch active — radius 72 m, rode 41 m, scope 5.7:1"

It reads as a convenience. Its real job is proving the notification path is alive at the exact moment the crew is paying attention to it. On the system that inspired this, a misconfigured notification target silently stopped delivering to one phone for weeks — the siren and the other phone still worked, so nothing looked broken. Every anchor set is now a live test. Do the same.

### Self-monitoring

- `/healthz` and `/readyz` on every service, wired to Docker healthchecks with sensible restart policies.
- A supervisor loop that checks the alarm engine is actually evaluating (heartbeat counter), not just that the process is alive.
- Persist a "clean shutdown" flag; absence of it on boot means an unexpected restart, which notifies.
- Diagnostics page: sentence rates per type, checksum error rate, source uptime, last sample age per field, DB size, notification success rate, CPU/RAM.

---

## 10. Authentication and security

Assume it's behind Tailscale. Build as if it isn't.

- **First-run setup wizard** creates the first admin account. No seeded credentials, no default password, and the app refuses to serve anything else until setup completes.
- **Argon2id** password hashing with sensible params for a Pi. Minimum length enforced, zxcvbn-style strength feedback, no composition rules.
- **Session cookies**: HTTP-only, `Secure`, `SameSite=Lax`, server-side session store in SQLite, sliding expiry with an absolute cap, revocable from a "signed-in devices" screen showing device/IP/last-seen. No JWTs in localStorage.
- **Optional TOTP 2FA** with recovery codes.
- **Rate limiting and lockout** on login, with attempts logged to the event log.
- CSRF tokens on state-changing requests. Strict CSP, `X-Content-Type-Options`, `Referrer-Policy`, HSTS when served over TLS.
- **Roles:** `admin` (settings, users, integrations) and `crew` (view, ack alarms, drop/set/weigh). A guest should be able to help without being able to reconfigure the boat.
- **A long-lived read-only API token** for Home Assistant / Grafana, scoped and revocable, shown once at creation.
- TLS terminated by an optional Caddy profile, or Tailscale certs. Document both.
- Secrets from environment/`.env`, never baked into images, never logged. Redact tokens in logs and diagnostics output.
- Containers run as non-root with read-only root filesystems where practical, and a named volume for the database.

---

## 11. The web app

Mobile-first PWA, installable to the home screen, works offline for the last-known state. React + Vite + TypeScript. State over a WebSocket with **delta updates, not full-state pushes** — the cellular link is slow and metered. Configurable update rate, and a low-bandwidth mode that drops to 0.2 Hz and suspends the chart.

### Screens

1. **Watch** — the home screen when a session is active. Chart, anchor position, swing circle, warning ring, boat icon rotating with heading, track history with a 1–48 h slider. Big, unmissable state banner. Drop / Set / Weigh controls sized for wet hands in a rocking dinghy.
2. **Now** — live instruments: depth, wind, SOG, heading, position, battery, temps. Only render what's actually present in the data.
3. **Traffic** — AIS targets, list and overlay, with CPA/TCPA for the anchored case (something coming at you at anchor is the scenario that matters).
4. **History** — past anchor sessions with their geometry and event log; charts of the night.
5. **Settings** — thresholds with explanations, boat geometry, units, notifications, users, zones, diagnostics.

### Charting

MapLibre GL JS. Offline **MBTiles** served by the optional `tiles` container is the primary path — assume no internet at anchor.

**Critical fallback:** when no tiles are available, the anchor view must degrade to a fully functional **schematic polar view** — anchor at centre, swing circle, boat position, track, north indicator, distance rings, exclusion zones — with no basemap at all. This view must be good enough to use as the primary display, because on a bad cell link it will be. Do not treat it as an error state.

### Design direction

Ground it in the subject: this is a marine instrument, used at night, at anchor, by someone who may be anxious. Not a SaaS dashboard.

- **Night mode is a hard requirement, not a theme toggle** — a deep red-shifted palette that preserves dark adaptation, auto-engaging on a schedule or manually. This is the screen someone looks at at 0300 before deciding whether to get up.
- Screen-brightness and colour choices that survive being read in direct sunlight on deck, too. Two genuinely different environments.
- Legibility over density. Distances and bearings are the content; make them the largest thing on the screen. A tabular-figures typeface for all numerics so values don't jitter as they update.
- Alarm states must be distinguishable **without relying on colour alone** — shape, motion and text as well.
- Wake Lock API on the Watch screen so the phone doesn't sleep while someone is actually standing watch.
- One-handed reachability: primary actions in the lower third.
- Spend your boldness on the anchor view itself. Everything else stays quiet and disciplined.
- Avoid the generic tells: identical rounded cards for everything, all-caps eyebrow labels, a decorative gradient wash, arrows appended to buttons. Let the instrument aesthetic come from marine vernacular — bearing rings, range scales, chart conventions — not from a component library's defaults.

Copy is plain and active. Buttons say what happens: "Drop anchor", "Anchor set", "Weigh anchor". The confirmation says what it did. Errors say what broke and what to do, in the interface's voice.

Accessibility floor: visible keyboard focus, respects reduced motion, adequate contrast in both palettes, screen-reader labels on the instrument readouts.

---

## 12. The simulator — build this first

You cannot test against a real boat, and neither can I until this is on the hardware. The simulator is therefore load-bearing infrastructure, not a nice-to-have.

Build an NMEA source that generates a realistic sentence stream from scripted scenarios, at configurable speed-up (a 12-hour night should replay in 30 seconds). Scenarios, each a checked-in fixture:

1. **Quiet night** — boat swinging normally on a wind shift, no alarms. Any alarm here is a false positive and a test failure.
2. **Slow drag** — gradual movement over 20 minutes, ending outside the circle. Assert: position warning fires before the alarm, with the expected lead time.
3. **Break-out** — sudden SOG increase with the wind angle swinging off the bow. Assert: escalates to critical via the combined-detector rule.
4. **Light-air vane spin** — wind under 5 kn with apparent angle swinging wildly. Assert: **no wind-shift warning fires.** This is a regression test for the most common false alarm.
5. **GPS noise floor** — stationary boat with realistic position scatter and SOG hovering near 1 kn. Assert: no alarm.
6. **GPS dropout** — position stops updating for 90 s then resumes. Assert: warning at 30 s, critical at 60 s, clean auto-clear on return.
7. **Source disconnect** — TCP connection drops mid-session. Assert: reconnect, alarm raised, session intact.
8. **Hard power cut** — kill the container mid-session. Assert: on restart the anchor session is rehydrated with identical geometry and watching resumes.
9. **Marina fridge failure** — freezer warms through the alarm band into ambient. Assert: notifications fire on *every* transition including the one into the "off" band, and the failure does not hide.
10. **Tidal swing** — depth changes through the session. Assert: scope reporting stays correct off the captured drop depth.

Also ship a **record mode** that captures a raw NMEA stream from the real Cortex to a file, and a replay mode for those captures. Once this is on the boat, real recordings become the best test fixtures available.

### Testing requirements

- Full unit coverage on `packages/core`: geodesy, rode/scope math, unit conversions, the state machine, and every detector's hysteresis. These are the parts where a bug is a dragged anchor.
- Integration tests running each scenario end to end against the real alarm engine and asserting on the emitted event log.
- Property-based tests on the geometry (e.g. computed rode is never less than vertical drop; radius is monotonic in swing margin).
- A test that asserts the alarm engine still evaluates with the web app entirely absent.

---

## 13. Packaging

- `docker-compose.yml` plus `docker-compose.override.yml` for development, and compose profiles for `tiles` and `mqtt`.
- Multi-arch images (`linux/amd64`, `linux/arm64`) built with buildx; multi-stage builds, non-root users, pinned base images.
- `.env.example` documenting every variable with its default and what it does.
- Named volumes for the database, config and tiles. A documented backup command that produces a consistent SQLite snapshot while running.
- Sensible `restart: unless-stopped`, healthchecks, log rotation limits (an SD card must not fill with logs).
- A `justfile` or `Makefile`: `up`, `dev`, `test`, `sim <scenario>`, `record`, `backup`, `logs`.
- **README** covering: hardware, finding the Cortex's IP and NMEA port via the Onboard app, the note that AIS output over wired NMEA 0183 needs at least 38400 baud, measuring and entering boat geometry (GPS antenna offset, bow roller height), first-run setup, notification setup for ntfy/Pushover/Telegram, remote access via Tailscale, backups, and a troubleshooting section.
- **SECURITY.md** with the threat model and what the system does and doesn't protect against.
- Conventional commits, and commit at the end of each phase. Things go sideways; git has saved this kind of project more than once.

---

## 14. Build order

Do not attempt this in one pass. Work in phases, and stop at the end of each to show me what you have.

| Phase | Deliverable |
|---|---|
| 0 | Repo scaffold, toolchain, compose skeleton, CI running lint + tests |
| 1 | `packages/core`: units, geodesy, rode/scope math, state machine, detectors — with full tests. No I/O. |
| 2 | Simulator + all ten scenarios as passing integration tests against the core |
| 3 | `ingest`: real NMEA 0183 TCP/UDP parsing, normalization, reconnect, record/replay |
| 4 | `server`: SQLite schema, session persistence and rehydration, REST + WebSocket, alarm engine wiring |
| 5 | Auth: setup wizard, sessions, roles, 2FA, rate limiting, API tokens |
| 6 | Web app: Watch screen and schematic polar view first, then Now, then the rest |
| 7 | Notifications, delivery verification, the set/weigh confirmation test, self-monitoring |
| 8 | Marina mode, heartbeat, exclusion zones |
| 9 | Charts/MBTiles, PWA polish, night mode, accessibility pass |
| 10 | Packaging, multi-arch build, README, SECURITY.md, backup tooling |

---

## 15. Before you start

Ask me about anything genuinely ambiguous, but make and document reasonable decisions rather than blocking. Keep a `docs/decisions.md` with each non-obvious architectural choice and its reasoning.

Two things I'd like your view on before phase 1, briefly:

1. Whether to ingest directly from the Cortex or to require Signal K as a dependency. I've specified direct-with-optional-Signal-K; argue if you disagree.
2. Whether the alarm engine should run in its own process, separate from the API, for isolation — given that a crash in request handling must never take down the watch.

Then start with phase 0.
