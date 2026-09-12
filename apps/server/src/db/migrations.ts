/**
 * Schema migrations. Append only; never edit a shipped migration. Timestamps
 * are ms epoch integers, positions decimal degrees, everything else SI.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      -- Key/value settings; values are JSON. One row per top-level key
      -- (boat, units, source, alarm, marina, ...).
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Small runtime flags: clean_shutdown, boot_count, last_boot_at.
      CREATE TABLE runtime (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- The engine's full serialised WatchState. One row. Written on every
      -- event and periodically; read once at boot to rehydrate.
      CREATE TABLE engine_state (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        state      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- One row per drop-to-weigh (or marina start-to-stop) cycle, with the
      -- derived geometry so history is self-describing.
      CREATE TABLE anchor_sessions (
        id             TEXT PRIMARY KEY,
        mode           TEXT NOT NULL,
        started_at     INTEGER NOT NULL,
        ended_at       INTEGER,
        ended_by       TEXT,
        drop_lat       REAL,
        drop_lon       REAL,
        drop_at        INTEGER,
        drop_corrected INTEGER NOT NULL DEFAULT 0,
        depth_at_drop  REAL,
        depth_source   TEXT,
        anchor_lat     REAL,
        anchor_lon     REAL,
        set_lat        REAL,
        set_lon        REAL,
        set_at         INTEGER,
        tide_range     REAL NOT NULL DEFAULT 0,
        geometry       TEXT,
        marina_lat     REAL,
        marina_lon     REAL,
        marina_radius  REAL,
        max_distance   REAL,
        warning_count  INTEGER NOT NULL DEFAULT 0,
        alarm_count    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX anchor_sessions_started ON anchor_sessions (started_at DESC);

      -- Append-only event log. Every state transition, alarm, ack,
      -- notification attempt and result, login attempt. Never updated.
      CREATE TABLE events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        at         INTEGER NOT NULL,
        session_id TEXT,
        type       TEXT NOT NULL,
        severity   TEXT NOT NULL DEFAULT 'info',
        data       TEXT NOT NULL
      );
      CREATE INDEX events_at ON events (at);
      CREATE INDEX events_session ON events (session_id, at);
      CREATE INDEX events_type ON events (type, at);

      -- Normalised telemetry at 1 Hz. Downsampled nightly past 48 h to 10 s,
      -- pruned past the retention setting.
      CREATE TABLE samples (
        at        INTEGER PRIMARY KEY,
        lat       REAL,
        lon       REAL,
        sog       REAL,
        cog       REAL,
        heading   REAL,
        depth     REAL,
        awa       REAL,
        aws       REAL,
        hdop      REAL,
        distance  REAL,
        extra     TEXT
      );

      -- Exclusion zones persist across sessions.
      CREATE TABLE zones (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        polygon    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'auth',
    sql: `
      CREATE TABLE users (
        id             TEXT PRIMARY KEY,
        username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name   TEXT NOT NULL,
        role           TEXT NOT NULL CHECK (role IN ('admin', 'crew')),
        password_hash  TEXT NOT NULL,
        totp_secret    TEXT,
        totp_enabled   INTEGER NOT NULL DEFAULT 0,
        -- JSON array of sha256 hex digests of unused recovery codes.
        recovery_codes TEXT NOT NULL DEFAULT '[]',
        disabled       INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      -- Server-side sessions. The cookie carries a random id; only its hash
      -- is stored so a copy of the database cannot be replayed.
      CREATE TABLE auth_sessions (
        id_hash      TEXT PRIMARY KEY,
        public_id    TEXT NOT NULL UNIQUE,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token   TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        ip           TEXT,
        user_agent   TEXT,
        revoked_at   INTEGER
      );
      CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

      -- Long-lived read-only tokens for Home Assistant / Grafana. Shown once.
      CREATE TABLE api_tokens (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        scope        TEXT NOT NULL DEFAULT 'read',
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at   INTEGER
      );

      -- Login attempts feed the lockout logic and the event log.
      CREATE TABLE login_attempts (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        at       INTEGER NOT NULL,
        username TEXT NOT NULL COLLATE NOCASE,
        ip       TEXT,
        success  INTEGER NOT NULL,
        reason   TEXT
      );
      CREATE INDEX login_attempts_user ON login_attempts (username, at);
      CREATE INDEX login_attempts_ip ON login_attempts (ip, at);
    `,
  },
];
