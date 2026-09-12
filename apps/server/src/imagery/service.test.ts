import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { tileAt } from '@rode/core';
import type { ImagerySource } from '@rode/protocol';
import { ImageryService, sniff } from './service.js';

/* A 1×1 PNG and the JPEG start-of-image marker are enough for the sniffer. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)]);

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function setup(sources: ImagerySource[], fetchImpl?: typeof fetch) {
  dir = mkdtempSync(path.join(tmpdir(), 'rode-imagery-'));
  const mbtilesDir = path.join(dir, 'mbtiles');
  mkdirSync(mbtilesDir);
  const svc = new ImageryService({
    sources: () => sources,
    mbtilesDir,
    cacheDir: path.join(dir, 'cache'),
    log: pino({ level: 'silent' }),
    now: () => 1_000_000,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return { svc, mbtilesDir };
}

function writeMbtiles(file: string, format: string, tiles: [number, number, number][]): void {
  const db = new Database(file);
  db.exec(
    'CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)',
  );
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('format', format);
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('bounds', '-65,32,-64,33');
  const ins = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
  for (const [z, x, tmsRow] of tiles) ins.run(z, x, tmsRow, format === 'png' ? PNG : JPEG);
  db.close();
}

const src = (over: Partial<ImagerySource>): ImagerySource => ({
  id: 'a',
  name: 'A',
  kind: 'xyz',
  minZoom: 0,
  maxZoom: 19,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('sniff', () => {
  it('recognises png, jpeg and webp and rejects the rest', () => {
    expect(sniff(PNG)).toBe('image/png');
    expect(sniff(JPEG)).toBe('image/jpeg');
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBP'),
      Buffer.alloc(4),
    ]);
    expect(sniff(webp)).toBe('image/webp');
    expect(sniff(Buffer.from('<html>not a tile at all</html>'))).toBeNull();
    expect(sniff(Buffer.from([0x1f, 0x8b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull(); // gzip pbf
  });
});

describe('mbtiles sources', () => {
  it('serves raster tiles with the TMS row flip and reports metadata', async () => {
    const s = src({ id: 'm', kind: 'mbtiles', path: 'bermuda.mbtiles' });
    const { svc, mbtilesDir } = setup([s]);
    // XYZ (12, 1310, 1659) is TMS row 4095 - 1659 = 2436.
    writeMbtiles(path.join(mbtilesDir, 'bermuda.mbtiles'), 'png', [[12, 1310, 2436]]);
    const t = await svc.tile('m', { z: 12, x: 1310, y: 1659 });
    expect(t?.contentType).toBe('image/png');
    expect(t?.data.equals(PNG)).toBe(true);
    expect(await svc.tile('m', { z: 12, x: 1310, y: 2436 })).toBeNull();
    const st = await svc.status('m');
    expect(st).toMatchObject({ ok: true, format: 'png', tileCount: 1, zoomRange: [12, 12] });
    expect(st?.bounds).toEqual([-65, 32, -64, 33]);
    svc.close();
  });

  it('refuses paths outside the directory and vector files', async () => {
    const bad = src({ id: 'b', kind: 'mbtiles', path: '../outside.mbtiles' });
    const vec = src({ id: 'v', kind: 'mbtiles', path: 'vector.mbtiles' });
    const { svc, mbtilesDir } = setup([bad, vec]);
    writeMbtiles(path.join(mbtilesDir, 'vector.mbtiles'), 'pbf', []);
    expect(svc.resolveMbtiles('../outside.mbtiles')).toBeNull();
    expect(svc.resolveMbtiles('')).toBeNull();
    expect(await svc.tile('b', { z: 1, x: 0, y: 0 })).toBeNull();
    expect(await svc.status('b')).toMatchObject({ ok: false });
    expect((await svc.status('v'))?.message).toMatch(/vector/i);
    expect(await svc.listFiles()).toEqual([{ name: 'vector.mbtiles', bytes: expect.any(Number) }]);
    svc.close();
  });
});

describe('online sources', () => {
  it('expands templates including quadkeys and subdomains', () => {
    const { svc } = setup([]);
    const q = src({ urlTemplate: 'https://t{s}.example/a{q}.jpeg', subdomains: '01' });
    expect(svc.expand(q, { z: 3, x: 3, y: 5 })).toBe('https://t0.example/a213.jpeg');
    const xyz = src({ urlTemplate: 'https://e/{z}/{x}/{y}.png' });
    expect(svc.expand(xyz, { z: 1, x: 1, y: 0 })).toBe('https://e/1/1/0.png');
    expect(
      svc.expand(src({ urlTemplate: 'ftp://e/{z}/{x}/{y}' }), { z: 1, x: 0, y: 0 }),
    ).toBeNull();
    expect(
      svc.expand(src({ urlTemplate: 'https://e/static.png' }), { z: 1, x: 0, y: 0 }),
    ).toBeNull();
  });

  it('fetches once, caches on disk, and remembers failures briefly', async () => {
    const calls: string[] = [];
    const fake: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes('/9/')) return Promise.resolve(new Response('nope', { status: 404 }));
      return Promise.resolve(new Response(JPEG, { status: 200 }));
    };
    const s = src({ id: 'x', urlTemplate: 'https://e/{z}/{x}/{y}.jpg' });
    const { svc } = setup([s], fake);
    const t1 = await svc.tile('x', { z: 12, x: 1, y: 2 });
    expect(t1?.contentType).toBe('image/jpeg');
    const t2 = await svc.tile('x', { z: 12, x: 1, y: 2 });
    expect(t2?.data.equals(JPEG)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(readdirSync(path.join(dir, 'cache', 'x', '12', '1'))).toEqual(['2.tile']);

    expect(await svc.tile('x', { z: 9, x: 0, y: 0 })).toBeNull();
    expect(await svc.tile('x', { z: 9, x: 0, y: 0 })).toBeNull();
    expect(calls.filter((u) => u.includes('/9/'))).toHaveLength(1); // negative cache
    expect(await svc.status('x')).toMatchObject({ ok: true, cachedTiles: 1 });
    // Disabled or out-of-range: nothing, and no fetch.
    expect(await svc.tile('x', { z: 20, x: 0, y: 0 })).toBeNull();
    svc.close();
  });

  it('prefetches a box around a centre and skips tiles it already has', async () => {
    let n = 0;
    const fake: typeof fetch = () => {
      n++;
      return Promise.resolve(new Response(PNG, { status: 200 }));
    };
    const s = src({ id: 'p', urlTemplate: 'https://e/{z}/{x}/{y}.png' });
    const { svc } = setup([s], fake);
    const centre = { lat: 32.29, lon: -64.83 };
    await svc.tile('p', tileAt(centre, 15)); // inside the box below
    const planned = svc.prefetch('p', centre, { radius: 300, minZoom: 15, maxZoom: 16 });
    expect(planned).toBeGreaterThan(4);
    await new Promise<void>((resolve) => {
      const poll = () => {
        void svc.status('p').then((st) => {
          if (st?.prefetch && !st.prefetch.running) resolve();
          else setTimeout(poll, 5);
        });
      };
      poll();
    });
    const st = await svc.status('p');
    expect(st?.prefetch).toMatchObject({ running: false, done: planned, failed: 0 });
    expect(st?.cachedTiles).toBe(planned);
    expect(n).toBe(planned); // the centre tile was fetched once, before the prefetch, not twice
    expect(svc.prefetch('m', centre, { radius: 100, minZoom: 1, maxZoom: 1 })).toBeNull();
    svc.close();
  });
});

describe('reconcile', () => {
  it('drops the cache of a source that was removed', async () => {
    let sources = [src({ id: 'gone', urlTemplate: 'https://e/{z}/{x}/{y}.png' })];
    const fake: typeof fetch = () => Promise.resolve(new Response(PNG, { status: 200 }));
    dir = mkdtempSync(path.join(tmpdir(), 'rode-imagery-'));
    mkdirSync(path.join(dir, 'mbtiles'));
    const svc = new ImageryService({
      sources: () => sources,
      mbtilesDir: path.join(dir, 'mbtiles'),
      cacheDir: path.join(dir, 'cache'),
      log: pino({ level: 'silent' }),
      fetch: fake,
    });
    await svc.tile('gone', { z: 3, x: 1, y: 1 });
    expect(readdirSync(path.join(dir, 'cache'))).toEqual(['gone']);
    sources = [];
    svc.reconcile();
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(path.join(dir, 'cache'))).toEqual([]);
    svc.close();
  });
});
