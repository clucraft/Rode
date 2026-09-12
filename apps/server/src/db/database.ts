import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

/*
 * One SQLite file in WAL mode. Chosen over Postgres/Timescale deliberately:
 * it survives yanked power with fewer moving parts, backup is a single file,
 * and it runs comfortably on a Pi. See docs/decisions.md 0.4.
 *
 * Durability settings:
 *   journal_mode = WAL       readers never block the 1 Hz writer
 *   synchronous  = NORMAL    fsync at checkpoint, not every commit; WAL keeps
 *                            this crash-safe (a power cut loses at most the
 *                            last few transactions, never corrupts the file)
 */

export type Db = Database.Database;

export interface OpenOptions {
  /** Path to the database file, or ':memory:' for tests. */
  file: string;
  readonly?: boolean;
}

export function openDatabase(opts: OpenOptions): Db {
  if (opts.file !== ':memory:') mkdirSync(path.dirname(opts.file), { recursive: true });
  const db = new Database(opts.file, { readonly: opts.readonly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Keep the WAL from growing without bound on a box that is never idle.
  db.pragma('wal_autocheckpoint = 1000');
  if (!opts.readonly) migrate(db);
  return db;
}

/** Apply pending migrations in order, each in its own transaction. */
export function migrate(db: Db): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  );
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    })();
    count++;
  }
  return count;
}

export function databaseSizeBytes(file: string): number {
  if (file === ':memory:') return 0;
  try {
    let size = statSync(file).size;
    try {
      size += statSync(`${file}-wal`).size;
    } catch {
      // no WAL file yet
    }
    return size;
  } catch {
    return 0;
  }
}

/**
 * Consistent online backup using VACUUM INTO: produces a compact, complete
 * copy while the database is in use. Used by `make backup` and the admin API.
 */
export function backupTo(db: Db, destination: string): void {
  mkdirSync(path.dirname(destination), { recursive: true });
  db.prepare('VACUUM INTO ?').run(destination);
}
