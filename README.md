# Rode

Self-hosted boat monitor and anchor watch for vessels fitted with a Vesper
Marine Cortex M1. Runs on a Raspberry Pi 5 or small x86 box aboard, ingests
live NMEA 0183 from the Cortex over WiFi, and serves a mobile-first web app.

Its headline feature is an anchor watch that measures the rode actually paid
out, computes real scope, warns before it alarms, and detects its own failures.

> Rode does not replace a proper anchor watch or keeping a lookout.

**Status: phase 0 of 10 (repo scaffold).** Nothing here watches an anchor yet.
The build order and full specification are in [docs/spec.md](docs/spec.md);
design choices are logged in [docs/decisions.md](docs/decisions.md).

## Layout

```
apps/
  ingest/     NMEA acquisition, normalisation, simulator, record/replay
  server/     Fastify API + WebSocket, alarm engine host, auth, notifications
  web/        React PWA (a view of the alarm state, never the thing computing it)
packages/
  core/       Pure domain logic: units, geodesy, rode/scope math, state machine
  protocol/   Shared zod schemas + types for the REST/WS contract
docker/       Dockerfile, mosquitto config, tiles notes
docs/         Specification and decision log
```

TypeScript end to end, Node 22, pnpm workspaces, Vitest, ESLint, Prettier.
One runtime container (`rode`) plus optional compose profiles for offline chart
tiles (`tiles`) and an MQTT broker (`mqtt`).

## Development

```
pnpm install
pnpm dev          # server on :8080 (tsx watch) + web on :5173 (vite)
pnpm test         # every package
pnpm check        # lint, format, typecheck, test: what CI runs
```

`make` lists the same targets plus Docker and simulator entry points.

## Running with Docker

```
cp .env.example .env     # set RODE_SOURCE, RODE_NMEA_HOST, RODE_NMEA_PORT
docker compose -f docker-compose.yml up -d
```

`docker compose up` without `-f` applies the development override (source
mounted, hot reload, a simulated Cortex on the compose network).

The database lives in the `rode-data` named volume. Backup tooling, the setup
wizard, notification configuration and the full operator guide arrive in later
phases; this README grows with them.
