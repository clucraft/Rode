/*
 * Consistent online backup: `node dist/backup.js [destination]`.
 *
 * Uses SQLite's VACUUM INTO, which produces a compact, complete copy while
 * the server is running and writing. Default destination is
 * <RODE_DATA_DIR>/backups/rode-<UTC timestamp>.db. Prints the path.
 */
import path from 'node:path';
import { backupTo, openDatabase } from './db/database.js';

const dataDir = process.env.RODE_DATA_DIR ?? '/data';
const file = process.env.RODE_DB_FILE ?? path.join(dataDir, 'rode.db');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const destination = process.argv[2] ?? path.join(dataDir, 'backups', `rode-${stamp}.db`);

const db = openDatabase({ file, readonly: true });
try {
  backupTo(db, destination);
  console.log(destination);
} catch (err) {
  console.error(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  db.close();
}
