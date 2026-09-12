import Database from 'better-sqlite3';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { quadkey, tilesCovering, type LatLon, type TileXY } from '@rode/core';
import type { ImagerySource, ImageryStatus, PrefetchRequest } from '@rode/protocol';
import type { Logger } from '../logger.js';

/*
 * Raster imagery for the polar view. Two kinds of source:
 *
 *   mbtiles  a file in RODE_MBTILES_DIR read directly with SQLite; nothing
 *            else needs to run. Raster only (jpg/png/webp): the polar view
 *            draws tiles as images, it does not render vector data.
 *   xyz      an online template. Every tile the browser asks for is fetched
 *            once and kept on disk, so an anchorage looked at with the
 *            cellular link up is still there when it drops. "Cache around
 *            the boat" pulls a box at several zooms ahead of time.
 *
 * The browser never talks to a provider: it only sees /api/tiles/<id>/z/x/y
 * behind the normal session, so no provider URL or key reaches a phone.
 */

export interface Tile {
  data: Buffer;
  contentType: string;
}

export interface ImageryServiceOptions {
  sources: () => ImagerySource[];
  mbtilesDir: string;
  cacheDir: string;
  log: Logger;
  now?: () => number;
  /** Injected in tests. */
  fetch?: typeof fetch;
  userAgent?: string;
}

interface PrefetchJob {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  startedAt: number;
  cancel: boolean;
}

const FETCH_TIMEOUT_MS = 15_000;
const PREFETCH_CONCURRENCY = 4;
/** After an online fetch fails, do not hit the network for that tile again for a while. */
const NEGATIVE_TTL_MS = 60_000;
const MAX_PREFETCH_TILES = 4000;

export class ImageryService {
  private readonly dbs = new Map<string, { file: string; db: Database.Database }>();
  private readonly negative = new Map<string, number>();
  private readonly jobs = new Map<string, PrefetchJob>();
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ImageryServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  source(id: string): ImagerySource | null {
    return this.opts.sources().find((s) => s.id === id) ?? null;
  }

  /** Files an admin can pick from. */
  async listFiles(): Promise<{ name: string; bytes: number }[]> {
    try {
      const names = await readdir(this.opts.mbtilesDir);
      const out: { name: string; bytes: number }[] = [];
      for (const n of names) {
        if (!n.toLowerCase().endsWith('.mbtiles')) continue;
        const st = await stat(path.join(this.opts.mbtilesDir, n));
        if (st.isFile()) out.push({ name: n, bytes: st.size });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  /** Resolve an MBTiles path, refusing anything outside the MBTiles directory. */
  resolveMbtiles(p: string): string | null {
    const base = path.resolve(this.opts.mbtilesDir);
    const full = path.resolve(base, p);
    if (full === base || !full.startsWith(base + path.sep)) return null;
    return full;
  }

  async tile(id: string, t: TileXY): Promise<Tile | null> {
    const s = this.source(id);
    if (!s?.enabled) return null;
    if (t.z < s.minZoom || t.z > s.maxZoom) return null;
    const n = 2 ** t.z;
    if (t.x < 0 || t.y < 0 || t.x >= n || t.y >= n) return null;
    return s.kind === 'mbtiles' ? this.mbtilesTile(s, t) : this.xyzTile(s, t);
  }

  // ---------------------------------------------------------------- mbtiles

  private open(s: ImagerySource): Database.Database | null {
    const file = this.resolveMbtiles(s.path ?? '');
    if (!file) return null;
    const cached = this.dbs.get(s.id);
    if (cached?.file === file) return cached.db;
    if (cached) cached.db.close();
    try {
      const db = new Database(file, { readonly: true, fileMustExist: true });
      this.dbs.set(s.id, { file, db });
      return db;
    } catch (err) {
      this.opts.log.warn({ err, file }, 'cannot open mbtiles');
      return null;
    }
  }

  private mbtilesTile(s: ImagerySource, t: TileXY): Tile | null {
    const db = this.open(s);
    if (!db) return null;
    // MBTiles rows are TMS: y counts up from the south.
    const row = (1 << t.z) - 1 - t.y;
    try {
      const r = db
        .prepare(
          'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
        )
        .get(t.z, t.x, row) as { tile_data: Buffer } | undefined;
      if (!r) return null;
      const contentType = sniff(r.tile_data);
      if (!contentType) return null;
      return { data: r.tile_data, contentType };
    } catch (err) {
      this.opts.log.warn({ err, id: s.id }, 'mbtiles query failed');
      return null;
    }
  }

  private mbtilesStatus(s: ImagerySource): ImageryStatus {
    const file = this.resolveMbtiles(s.path ?? '');
    if (!file)
      return { id: s.id, ok: false, message: 'Path must be inside the MBTiles directory.' };
    const db = this.open(s);
    if (!db) return { id: s.id, ok: false, message: `Cannot open ${s.path ?? ''}.` };
    try {
      const meta: Record<string, string> = {};
      for (const r of db.prepare('SELECT name, value FROM metadata').all() as {
        name: string;
        value: string;
      }[]) {
        meta[r.name] = r.value;
      }
      const format = (meta.format ?? 'unknown').toLowerCase();
      const range = db
        .prepare('SELECT MIN(zoom_level) AS lo, MAX(zoom_level) AS hi, COUNT(*) AS n FROM tiles')
        .get() as { lo: number | null; hi: number | null; n: number };
      const bounds = meta.bounds
        ?.split(',')
        .map(Number)
        .filter((v) => Number.isFinite(v));
      const out: ImageryStatus = {
        id: s.id,
        ok: true,
        message: `${format}, ${String(range.n)} tiles`,
        format,
        tileCount: range.n,
      };
      if (range.lo !== null && range.hi !== null) out.zoomRange = [range.lo, range.hi];
      if (bounds?.length === 4)
        out.bounds = [bounds[0] ?? 0, bounds[1] ?? 0, bounds[2] ?? 0, bounds[3] ?? 0];
      if (format === 'pbf' || format === 'mvt') {
        out.ok = false;
        out.message =
          'Vector tiles (pbf) cannot be drawn under the polar view. Use a raster MBTiles.';
      }
      return out;
    } catch (err) {
      return { id: s.id, ok: false, message: `Not a readable MBTiles file (${String(err)}).` };
    }
  }

  // ---------------------------------------------------------------- xyz

  private cachePath(s: ImagerySource, t: TileXY): string {
    return path.join(this.opts.cacheDir, s.id, String(t.z), String(t.x), `${String(t.y)}.tile`);
  }

  expand(s: ImagerySource, t: TileXY): string | null {
    const tpl = s.urlTemplate ?? '';
    if (!/^https?:\/\//i.test(tpl)) return null;
    if (
      !tpl.includes('{q}') &&
      !(tpl.includes('{x}') && tpl.includes('{y}') && tpl.includes('{z}'))
    )
      return null;
    const subs = s.subdomains && s.subdomains.length > 0 ? s.subdomains : null;
    const sub = subs ? (subs[(t.x + t.y) % subs.length] ?? '') : '';
    return tpl
      .replace(/\{z\}/g, String(t.z))
      .replace(/\{x\}/g, String(t.x))
      .replace(/\{y\}/g, String(t.y))
      .replace(/\{q\}/g, quadkey(t))
      .replace(/\{s\}/g, sub);
  }

  private async xyzTile(s: ImagerySource, t: TileXY): Promise<Tile | null> {
    const file = this.cachePath(s, t);
    try {
      const data = await readFile(file);
      const contentType = sniff(data);
      if (contentType) return { data, contentType };
    } catch {
      // not cached
    }
    return this.download(s, t, file);
  }

  private async download(s: ImagerySource, t: TileXY, file: string): Promise<Tile | null> {
    const key = `${s.id}/${String(t.z)}/${String(t.x)}/${String(t.y)}`;
    const failedAt = this.negative.get(key);
    if (failedAt !== undefined && this.now() - failedAt < NEGATIVE_TTL_MS) return null;
    const url = this.expand(s, t);
    if (!url) return null;
    try {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': this.opts.userAgent ?? 'Rode', accept: 'image/*' },
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      const data = Buffer.from(await res.arrayBuffer());
      const contentType = sniff(data);
      if (!contentType) throw new Error('not an image');
      await mkdir(path.dirname(file), { recursive: true });
      // Write-then-rename so a power cut cannot leave a half tile behind.
      const tmp = `${file}.${String(process.pid)}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, file);
      this.negative.delete(key);
      return { data, contentType };
    } catch (err) {
      this.negative.set(key, this.now());
      if (this.negative.size > 5000) this.negative.clear();
      this.opts.log.debug({ err, url }, 'tile fetch failed');
      return null;
    }
  }

  private async cacheStats(s: ImagerySource): Promise<{ tiles: number; bytes: number }> {
    let tiles = 0;
    let bytes = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith('.tile')) {
          tiles++;
          try {
            bytes += (await stat(p)).size;
          } catch {
            // vanished between readdir and stat
          }
        }
      }
    };
    await walk(path.join(this.opts.cacheDir, s.id));
    return { tiles, bytes };
  }

  // ---------------------------------------------------------------- status

  async status(id: string): Promise<ImageryStatus | null> {
    const s = this.source(id);
    if (!s) return null;
    if (s.kind === 'mbtiles') return this.mbtilesStatus(s);
    const stats = await this.cacheStats(s);
    const job = this.jobs.get(s.id);
    const valid = this.expand(s, { z: 1, x: 0, y: 0 }) !== null;
    const out: ImageryStatus = {
      id: s.id,
      ok: valid,
      message: valid
        ? `${String(stats.tiles)} tiles cached (${fmtBytes(stats.bytes)})`
        : 'URL template must start with http(s):// and contain {z}/{x}/{y} or {q}.',
      cachedTiles: stats.tiles,
      cachedBytes: stats.bytes,
    };
    if (job) {
      out.prefetch = {
        running: job.running,
        done: job.done,
        total: job.total,
        failed: job.failed,
        startedAt: job.startedAt,
      };
    }
    return out;
  }

  // ---------------------------------------------------------------- prefetch

  /**
   * Download every tile in a box around a centre for a range of zooms, in
   * the background. Returns the number of tiles planned, or null if the
   * source is not an online one. Existing tiles are skipped.
   */
  prefetch(id: string, centre: LatLon, req: PrefetchRequest): number | null {
    const s = this.source(id);
    if (s?.kind !== 'xyz') return null;
    const existing = this.jobs.get(id);
    if (existing?.running) return existing.total;
    const minZ = Math.max(req.minZoom, s.minZoom);
    const maxZ = Math.min(req.maxZoom, s.maxZoom);
    const plan: TileXY[] = [];
    for (let z = minZ; z <= maxZ; z++) {
      const c = tilesCovering(centre, req.radius, z);
      for (let x = c.x0; x <= c.x1; x++)
        for (let y = c.y0; y <= c.y1; y++) {
          if (plan.length >= MAX_PREFETCH_TILES) break;
          plan.push({ z, x, y });
        }
    }
    const job: PrefetchJob = {
      running: true,
      done: 0,
      total: plan.length,
      failed: 0,
      startedAt: this.now(),
      cancel: false,
    };
    this.jobs.set(id, job);
    void this.runPrefetch(s, plan, job);
    return plan.length;
  }

  private async runPrefetch(s: ImagerySource, plan: TileXY[], job: PrefetchJob): Promise<void> {
    let i = 0;
    const worker = async () => {
      while (i < plan.length && !job.cancel) {
        const t = plan[i++];
        if (!t) break;
        const file = this.cachePath(s, t);
        let have = false;
        try {
          await stat(file);
          have = true;
        } catch {
          // fetch it
        }
        if (!have) {
          const r = await this.download(s, t, file);
          if (!r) job.failed++;
        }
        job.done++;
      }
    };
    await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
    job.running = false;
    this.opts.log.info(
      { id: s.id, done: job.done, failed: job.failed, ms: this.now() - job.startedAt },
      'imagery prefetch finished',
    );
  }

  cancelPrefetch(id: string): void {
    const job = this.jobs.get(id);
    if (job) job.cancel = true;
  }

  /**
   * Sources were edited: close handles and drop the tile cache of anything
   * that no longer exists, so a removed provider does not keep its megabytes.
   */
  reconcile(): void {
    const ids = new Set(this.opts.sources().map((s) => s.id));
    for (const [id, h] of this.dbs) {
      if (!ids.has(id)) {
        h.db.close();
        this.dbs.delete(id);
      }
    }
    for (const [id, job] of this.jobs) if (!ids.has(id)) job.cancel = true;
    void readdir(this.opts.cacheDir)
      .then((names) =>
        Promise.all(
          names
            .filter((n) => !ids.has(n))
            .map((n) => rm(path.join(this.opts.cacheDir, n), { recursive: true, force: true })),
        ),
      )
      .catch(() => undefined);
  }

  close(): void {
    for (const h of this.dbs.values()) h.db.close();
    this.dbs.clear();
    for (const job of this.jobs.values()) job.cancel = true;
  }
}

/** Content type from magic bytes; null for anything that is not a raster image. */
export function sniff(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
