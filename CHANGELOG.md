# Changelog

All notable changes to Rode are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) and correspond to git tags
(`vX.Y.Z`), which publish `ghcr.io/clucraft/rode:X.Y.Z` and `:latest`.
`ghcr.io/clucraft/rode:edge` follows `main` and includes everything under
_Unreleased_.

## [Unreleased]

Nothing yet.

## [0.3.0] - 2026-09-13

First tagged release. Includes the field-feedback round of 2026-09-12 (manual
radius, imagery, shared preferences) and the second round below.

### Removed

- **Marina mode** (the MARINA phase, refrigeration/battery/solar monitors,
  marina thresholds, the marina simulator scenario) and the **wind-angle
  warning** with its break-out rule. Wind is still shown and charted, it no
  longer alarms. Persisted state from earlier versions is brought forward on
  boot: a marina session is ended, stale conditions dropped.
- The Wind readout under the Watch graphic, the radius labels on the Traffic
  graphic, and the "here" button in the zone editor.

### Added

- **Rode out.** Enter the rode actually paid out; the circle is derived from
  it (`run = sqrt(rode² − vertical²)`) instead of the measured run at set.
  (`POST /api/anchor/rode`)
- **Traffic:** targets drawn red; a **Track** button per vessel draws its
  last hour in orange (server-side history, `GET /api/ais/:mmsi/track`);
  hover or tap a target for a card with range, bearing, SOG/COG, CPA/TCPA
  and last seen; ring labels in nautical miles past 1000 ft / 1000 m; zoom
  from 10 m to 100 nm; targets silent for 30 minutes are dropped with their
  track.
- **Data screen** (renamed from Now): STW next to SOG, apparent wind
  direction, true wind direction and speed computed when the instruments do
  not send them, and rolling 24-hour charts of apparent wind speed and
  direction, barometer, SOG and STW (`GET /api/series/buckets`).
- Watch: **Hide** collapses the control panel to a slim bar (the Acknowledge
  button stays); the weigh-anchor confirmation says how many zones it will
  remove; a **Delete** button per zone on the zones settings page.
- Units and display: the time zone is a searchable list of every IANA zone.
- VHW (speed through water) parsing; the simulator emits it.
- **Manual alarm radius.** "Edit alarm radius" on the Watch screen: drag
  either ring on the view or type both numbers. Unchecked, the warning ring
  follows the alarm ring at the configured warn distance and either field
  moves the other; "Ignore configured radius scale" sets them independently.
  "Reset to computed" restores the derived circle. The override lives on the
  session (`radiusOverride`), is enforced by the engine (5–2000 m, warning
  inside alarm), survives restarts, and is logged as `radius-overridden` /
  `radius-override-cleared`. Also works for marina sessions.
  (`POST`/`DELETE /api/anchor/radius`)
- **Apparent wind on the polar view:** an arrow on the outer ring showing
  where the wind blows from (heading + AWA, live), with wind speed and depth
  readouts in the top-right corner of the graphic.
- **Radius labels on the rings** (`alarm 47 m`, `warning 37 m`, `· manual`
  when overridden) and a **Warning radius** readout next to Alarm radius.
- **Previous anchor** stays on the view, greyed with its circle, after
  weighing until the next drop.
- **Add exclusion zone** button on the Watch screen; zones can be drawn
  over the imagery.
- **Shared view preferences.** Track hours, AIS toggle, polar/chart view,
  background imagery, Traffic fit-all and the previous-anchor switch are
  stored on the boat (`GET`/`PATCH /api/prefs`, crew-level), included in
  every snapshot and pushed as a websocket delta, so a phone and a laptop
  show the same thing.
- **Imagery under the anchor view.** Settings › Imagery holds up to five
  raster sources selected from a **Background** menu on Watch and Traffic:
  MBTiles files in `/data/mbtiles` read directly by Rode (raster only; no
  tile server needed), or online XYZ/quadkey templates with Esri World
  Imagery, Google Satellite and Bing Aerial presets. Online tiles are
  fetched by the server and cached under `/data/tile-cache`; "Cache around
  the boat" prefetches 1.5 km at zoom 13–19. Phones never contact the
  provider. Night mode red-shifts the imagery. (`/api/imagery`,
  `/api/tiles/:id/:z/:x/:y`, `RODE_MBTILES_DIR`)
- **Traffic:** the view widens to fit every AIS target (toggle), and range /
  CPA switch to nautical miles beyond 1000 ft (1000 m for metric boats).
- Core: web-mercator tile arithmetic (`tileAt`, `tileOrigin`, `quadkey`,
  `tilesCovering`, `metresPerPixel`).

### Changed

- Watch and Traffic are independent: each keeps its own background imagery
  and zoom, stored as shared preferences. The Watch extent changes only when
  you zoom or the circle changes; Traffic's "fit all targets" follows the
  targets while on and freezes the extent when turned off.
- Imagery fills the whole graphic, not just the compass rose.
- The wind box on the graphic shows apparent wind **direction** and speed.
- Weighing anchor removes every exclusion zone.
- README screenshots (phone, night mode, ALARM, Traffic over imagery,
  Imagery settings) captured from the simulator by `pnpm screenshots`.
- **Settings changes apply to the running session.** Editing alarm
  thresholds or boat geometry re-derives the active circle and marina
  radius (`recompute` command, logged as `geometry-recomputed`) instead of
  waiting for the next drop. Hold times and thresholds were already read
  live.
- History shows the manually set radius alongside the computed one.
- The `rode-tiles` compose volume is now also mounted into the `rode`
  service at `/data/mbtiles`.
- Static web files are resolved at request time rather than at boot.

### Fixed

- Changing one setting reset the others (track slider back to 6 h after
  picking a background, units resetting each other): zod 4's `.partial()`
  kept field defaults, so every PATCH carried them. All patch schemas now
  strip defaults (`patchOf`).
- The zone editor could not scroll once it had more than a few points, so
  Save was unreachable and points could not be deleted on a phone.
- On laptops the left navigation rail overlapped the top status bar on the
  Watch and Traffic screens (a leftover `bottom: 0` from the phone layout
  on the sticky rail; only pages taller than the viewport were affected).
- On phones the page would not scroll when the finger landed on the
  graphic. The polar view now scrolls the page and only captures touches
  while adjusting the anchor, drawing a zone or editing the rings.
- The Watch control row could push the layout past a phone's right edge.
- Seams between imagery tiles at fractional pixel positions.

## [0.1.0] - 2026-09-11

First complete build from the specification (never tagged; `edge` only) (`docs/spec.md`).

### Added

- Pure anchor-watch engine: drop → set → watching with derived WARNING /
  ALARM from a conditions map; rode, scope and swing-circle geometry from
  the actual set position, depth, tide range and HDOP; sustained detectors
  for position, wind angle, speed, break-out, depth, GPS staleness, source
  disconnect and exclusion zones; acknowledgement that snoozes audio but
  never clears a condition, with escalating re-fires. Marina mode with
  refrigeration bands, battery and solar monitors.
- NMEA 0183 parser and normaliser, AIS decoding, adapters for TCP, UDP,
  Signal K, simulator and replay; ten checked-in scenarios with integration
  tests; `rode-sim` CLI, recorder and fake hub.
- Server: Fastify + SQLite (WAL), 1 Hz engine host persisting state and
  events atomically, append-only event log, REST API, websocket snapshot +
  delta feed, supervisor, GPS-backed process clock, backups (`VACUUM INTO`).
- Authentication: first-run setup wizard (no default credentials), argon2id
  passwords, hashed sessions with CSRF, admin/crew roles, TOTP two-factor,
  lockout, read-only API tokens.
- Notifications: ntfy, Pushover, Telegram, webhook, MQTT and email
  heartbeat with delivery confirmation and retries.
- Web app: Watch screen with the schematic polar view, Now, Traffic,
  History with per-session charts, Settings with documented thresholds,
  exclusion-zone editor, MapLibre chart over local tiles, PWA, day and
  red-on-black night palettes, wake lock, honest audio-armed state.
- Packaging: multi-arch Docker image (amd64/arm64), compose profiles for
  tiles, MQTT and TLS, `make backup` / `make restore`, README, SECURITY.md.

[Unreleased]: https://github.com/clucraft/Rode/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/clucraft/Rode/releases/tag/v0.3.0
[0.1.0]: https://github.com/clucraft/Rode/commit/a30611e
