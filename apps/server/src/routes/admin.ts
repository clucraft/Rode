import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { backupTo } from '../db/database.js';
import { actorName, type AppContext } from '../context.js';
import { requireRole } from '../auth/guard.js';

/**
 * Admin utilities. The backup is a VACUUM INTO snapshot streamed as a
 * download, so the owner can pull a consistent copy of the database from a
 * phone before hauling out, without a shell on the box.
 */
export function adminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/admin/backup', { preHandler: requireRole('admin') }, async (req, reply) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rode-backup-'));
    const stamp = new Date(ctx.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `rode-${stamp}.db`);
    try {
      backupTo(ctx.db, file);
      const size = (await stat(file)).size;
      ctx.repos.events.append('backup-downloaded', { bytes: size, by: actorName(req) });
      void reply
        .header('Content-Type', 'application/vnd.sqlite3')
        .header('Content-Disposition', `attachment; filename="rode-${stamp}.db"`)
        .header('Content-Length', String(size));
      const stream = createReadStream(file);
      stream.on('close', () => void rm(dir, { recursive: true, force: true }));
      return await reply.send(stream);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  });
}
