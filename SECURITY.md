# Security

Rode is a safety system that lives on a boat's LAN and is reached over a
private tunnel. It is built as if it were on the open internet anyway.

## Threat model

**Assets**

- The alarm engine's availability: a watch that silently stops is the worst
  failure. Most of the engineering in this project is about that, not about
  attackers.
- Control of the watch: drop, set, weigh, acknowledge, thresholds. An
  attacker who can weigh the anchor session or raise the thresholds can make
  the system lie.
- Position history and AIS: where the boat is and has been.
- Notification credentials: ntfy/Pushover/Telegram tokens, SMTP password,
  Signal K token.

**Assumed environment**

- The box sits on the boat LAN with the Cortex hub and, optionally, a
  cellular router. Remote access is through Tailscale or WireGuard that
  the owner runs; Rode does not implement the tunnel.
- The Cortex's NMEA stream is unauthenticated (that is how NMEA works).
  Anyone on the boat LAN can read it or inject sentences. Rode treats the
  LAN as semi-trusted for _data_ and untrusted for _control_.
- Physical access to the box is game over for anything on it, as with any
  device.

**In scope**

- Unauthenticated access to the API or web app.
- Credential guessing.
- Session theft (cookie replay, XSS, CSRF).
- Privilege escalation from crew to admin, or from a read-only token to
  anything else.
- Leaking secrets through logs, diagnostics, backups or the API.
- A compromised or malicious data source causing a crash or a wrong watch.

**Out of scope**

- Spoofed NMEA on the LAN making the boat _appear_ somewhere else. That is
  a property of the input. If your LAN has hostile devices on it, the anchor
  alarm is not your biggest problem; still, GPS/source liveness alarms fire
  if the stream stops, and the event log records every value that caused a
  transition.
- Denial of service from the boat LAN.
- Attacks on the Cortex hub itself.

## What Rode does

- **No default credentials.** The first request serves the setup wizard;
  the API returns 503 for everything else until the first admin exists.
- **Passwords**: argon2id (19 MiB, t=2, p=1), minimum 10 characters,
  zxcvbn-based guessability check, no composition rules.
- **Sessions**: 256-bit random ids in an `HttpOnly; SameSite=Lax` cookie
  (`Secure` when `RODE_TLS=true`); only the SHA-256 of the id is stored.
  Sliding 30-day idle expiry, 90-day absolute cap. Revocable per device;
  password change signs out every other device.
- **CSRF**: state-changing cookie requests must carry the session's CSRF
  token in a header. Bearer tokens are exempt because they never come from
  a browser session.
- **Roles**: `admin` (settings, users, integrations) and `crew` (view,
  acknowledge, drop/set/weigh). The last enabled admin cannot be demoted,
  disabled or deleted.
- **API tokens**: read-only, crew-level, shown once, stored hashed,
  revocable.
- **Two-factor**: optional TOTP with single-use hashed recovery codes.
- **Lockout**: five failed logins per username or twenty-five per IP in
  fifteen minutes lock that username/IP for the window. Every attempt is in
  the event log. Login and setup are additionally rate-limited per IP.
- **Headers**: strict CSP on the app shell, `X-Content-Type-Options`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, HSTS when TLS.
- **Input**: every request body validated with zod; NMEA sentences are
  bounded (16 KiB line buffer), checksummed, and malformed ones counted
  rather than thrown.
- **Secrets**: from the environment or the settings table; pino redacts
  `*.token`, `*.password`, `*.secret`, cookies and `Authorization`. The
  notifications API returns secrets masked. Backups contain the settings
  table, including notification tokens, so treat a backup like a password
  file.
- **Containers**: run as `node` (uid 1000), read-only root filesystem,
  `no-new-privileges`, all capabilities dropped, tmpfs for scratch, named
  volume for `/data`, log rotation.
- **Dependencies**: pinned lockfile; base image pinned by digest; native
  modules limited to `better-sqlite3` and `argon2`.

## What Rode does not do

- It does not encrypt the database at rest. Full-disk encryption on the
  box is the right layer for that.
- It does not authenticate the NMEA source.
- It does not protect against a compromised phone that holds a valid
  session cookie; revoke it from Settings › Your account.
- It does not run a firewall. Bind `RODE_PORT` to the LAN/tailnet interface
  you mean to serve.

## Reporting

Please report vulnerabilities privately to the repository owner rather than
opening a public issue. Include the version (`/api/config`), reproduction
steps, and impact.
