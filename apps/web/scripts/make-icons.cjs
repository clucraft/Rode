/*
 * Generates the PWA icons without any image library: rasterises the Rode
 * mark (a bearing ring with a centre dot, the "watching" glyph) into RGBA
 * and writes PNGs with node's zlib. Run: node scripts/make-icons.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance helpers on a unit square [-1, 1]. */
function render(size, { maskable }) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [0x0b, 0x0f, 0x14];
  const ink = [0xf3, 0xef, 0xe6];
  const accent = [0x4c, 0xa3, 0xf2];
  const pad = maskable ? 0.72 : 0.9; // keep the mark inside the safe zone
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const r = Math.hypot(u, v);
      let col = bg;
      let a = 255;
      // Rounded-square background for non-maskable so it looks like an app tile.
      if (!maskable) {
        const q = Math.max(Math.abs(u), Math.abs(v));
        const corner = Math.hypot(Math.max(Math.abs(u) - 0.78, 0), Math.max(Math.abs(v) - 0.78, 0));
        if (q > 0.78 && corner > 0.22) a = 0;
      }
      const ring = Math.abs(r - 0.62 * pad) < 0.07 * pad;
      const dot = r < 0.14 * pad;
      const north = Math.abs(u) < 0.045 * pad && v < -0.62 * pad && v > -0.9 * pad;
      const ticks = [0.5 * Math.PI, Math.PI, 1.5 * Math.PI].some((ang) => {
        const dx = u - Math.cos(ang) * 0.62 * pad;
        const dy = v - Math.sin(ang) * 0.62 * pad;
        return Math.hypot(dx, dy) < 0.045 * pad;
      });
      if (ring || dot || north) col = ink;
      if (dot) col = accent;
      if (ticks) col = ink;
      const i = (y * size + x) * 4;
      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = a;
    }
  }
  return png(size, size, rgba);
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), render(192, { maskable: false }));
fs.writeFileSync(path.join(out, 'icon-512.png'), render(512, { maskable: false }));
fs.writeFileSync(path.join(out, 'maskable-512.png'), render(512, { maskable: true }));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), render(180, { maskable: true }));
console.log('icons written to', out);
