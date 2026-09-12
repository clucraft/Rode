# Changelog

All notable changes to Rode are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) and correspond to git tags
(`vX.Y.Z`), which publish `ghcr.io/clucraft/rode:X.Y.Z` and `:latest`.
`ghcr.io/clucraft/rode:edge` follows `main` and includes everything under
_Unreleased_.

## [Unreleased]

### Added

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

- On laptops the left navigation rail overlapped the top status bar on the
  Watch and Traffic screens (a leftover `bottom: 0` from the phone layout
  on the sticky rail; only pages taller than the viewport were affected).
- On phones the page would not scroll when the finger landed on the
  graphic. The polar view now scrolls the page and only captures touches
  while adjusting the anchor, drawing a zone or editing the rings.
- The Watch control row could push the layout past a phone's right edge.
- Seams between imagery tiles at fractional pixel positions.

## [0.1.0] - 2026-09-11

First complete build from the specification (`docs/spec.md`).

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

[Unreleased]: https://github.com/clucraft/Rode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/clucraft/Rode/releases/tag/v0.1.0
