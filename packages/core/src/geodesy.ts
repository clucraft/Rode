import type { LatLon } from './types.js';
import { degToRad, radToDeg } from './units.js';

/** WGS84 mean earth radius, metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

const TWO_PI = 2 * Math.PI;

/** Normalise an angle to [0, 2π). */
export function normaliseAngle(rad: number): number {
  const a = rad % TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}

/** Normalise an angle to (-π, π]. Useful for relative angles such as AWA. */
export function normaliseRelativeAngle(rad: number): number {
  let a = normaliseAngle(rad);
  if (a > Math.PI) a -= TWO_PI;
  return a;
}

/** Smallest absolute difference between two angles, in [0, π]. */
export function angleDifference(a: number, b: number): number {
  return Math.abs(normaliseRelativeAngle(a - b));
}

/**
 * Great-circle distance in metres (haversine).
 *
 * At anchor-watch scales (tens to hundreds of metres) the spherical error is
 * millimetres; not worth Vincenty's cost on a Pi at 1 Hz.
 */
export function distanceM(a: LatLon, b: LatLon): number {
  const φ1 = degToRad(a.lat);
  const φ2 = degToRad(b.lat);
  const Δφ = degToRad(b.lat - a.lat);
  const Δλ = degToRad(b.lon - a.lon);
  const h =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, radians true, [0, 2π). */
export function bearingRad(a: LatLon, b: LatLon): number {
  const φ1 = degToRad(a.lat);
  const φ2 = degToRad(b.lat);
  const Δλ = degToRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normaliseAngle(Math.atan2(y, x));
}

/** Destination point given start, bearing (radians true) and distance (metres). */
export function destination(from: LatLon, bearing: number, distance: number): LatLon {
  const δ = distance / EARTH_RADIUS_M;
  const φ1 = degToRad(from.lat);
  const λ1 = degToRad(from.lon);
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(bearing);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(bearing) * Math.sin(δ) * Math.cos(φ1);
  const x = Math.cos(δ) - Math.sin(φ1) * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);
  return { lat: radToDeg(φ2), lon: normaliseLon(radToDeg(λ2)) };
}

/** Wrap a longitude into [-180, 180). */
export function normaliseLon(lon: number): number {
  let l = ((lon + 180) % 360) - 180;
  if (l < -180) l += 360;
  return l;
}

/**
 * Translate a position by a body-frame offset rotated to the given heading.
 *
 * This is how the antenna position becomes the bow-roller position:
 * `offsetByHeading(antenna, heading, geometry.antennaToBowForward, geometry.antennaToBowStarboard)`.
 */
export function offsetByHeading(
  pos: LatLon,
  headingRad: number,
  forwardM: number,
  starboardM: number,
): LatLon {
  if (forwardM === 0 && starboardM === 0) return pos;
  const distance = Math.hypot(forwardM, starboardM);
  // Body-frame angle of the offset, measured clockwise from the bow.
  const relative = Math.atan2(starboardM, forwardM);
  return destination(pos, normaliseAngle(headingRad + relative), distance);
}

/** Position after travelling at `sogMps` on `cogRad` for `seconds`. */
export function projectPosition(
  pos: LatLon,
  cogRad: number,
  sogMps: number,
  seconds: number,
): LatLon {
  return destination(pos, cogRad, sogMps * seconds);
}

/** Local east/north metres of `p` relative to `origin` (equirectangular). */
export interface LocalXY {
  x: number;
  y: number;
}

/**
 * Project to a local tangent plane centred on `origin`. Accurate to well under
 * a metre for anything within a few kilometres, which covers every anchorage
 * and exclusion zone this system will ever see.
 */
export function toLocalXY(origin: LatLon, p: LatLon): LocalXY {
  const cosLat = Math.cos(degToRad(origin.lat));
  return {
    x: degToRad(normaliseRelativeLon(p.lon - origin.lon)) * cosLat * EARTH_RADIUS_M,
    y: degToRad(p.lat - origin.lat) * EARTH_RADIUS_M,
  };
}

/** Inverse of toLocalXY. */
export function fromLocalXY(origin: LatLon, xy: LocalXY): LatLon {
  const cosLat = Math.cos(degToRad(origin.lat));
  return {
    lat: origin.lat + radToDeg(xy.y / EARTH_RADIUS_M),
    lon: normaliseLon(origin.lon + radToDeg(xy.x / (EARTH_RADIUS_M * cosLat))),
  };
}

function normaliseRelativeLon(dlon: number): number {
  let d = dlon;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/**
 * Ray-casting point-in-polygon on the local plane. The polygon is a ring of
 * at least three vertices; closure is implicit.
 */
export function pointInPolygon(p: LatLon, polygon: readonly LatLon[]): boolean {
  if (polygon.length < 3) return false;
  const pts = polygon.map((v) => toLocalXY(p, v));
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (!a || !b) continue;
    // Point is at the origin of the local frame.
    const intersects = a.y > 0 !== b.y > 0 && 0 < ((b.x - a.x) * (0 - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Shortest distance from `p` to the polygon's boundary, metres. */
export function distanceToPolygonEdgeM(p: LatLon, polygon: readonly LatLon[]): number {
  if (polygon.length === 0) return Number.POSITIVE_INFINITY;
  const pts = polygon.map((v) => toLocalXY(p, v));
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (!a || !b) continue;
    best = Math.min(best, distancePointToSegment(a, b));
  }
  return best;
}

/** Distance from the origin to segment ab, on the local plane. */
function distancePointToSegment(a: LocalXY, b: LocalXY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(a.x, a.y);
  // Projection of origin onto the segment, clamped to it.
  const t = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2));
  return Math.hypot(a.x + t * dx, a.y + t * dy);
}

/**
 * True if the straight-line path from `from` to `to` enters the polygon,
 * sampled at `steps` points. Used for projected-entry warnings.
 */
export function pathEntersPolygon(
  from: LatLon,
  to: LatLon,
  polygon: readonly LatLon[],
  steps = 12,
): boolean {
  const total = distanceM(from, to);
  if (total === 0) return pointInPolygon(from, polygon);
  const brg = bearingRad(from, to);
  for (let i = 1; i <= steps; i++) {
    const p = destination(from, brg, (total * i) / steps);
    if (pointInPolygon(p, polygon)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- web mercator tiles

/**
 * Slippy-map tile arithmetic (EPSG:3857, 256 px tiles). Used to place raster
 * imagery under the polar view and by the server's tile cache. Pure; the
 * tile grid is a property of the projection, not of any provider.
 */
export interface TileXY {
  z: number;
  x: number;
  y: number;
}

const MAX_MERCATOR_LAT = 85.05112878;

/** Tile containing a position at zoom z. */
export function tileAt(p: LatLon, z: number): TileXY {
  const n = 2 ** z;
  const lat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, p.lat));
  const latRad = degToRad(lat);
  const x = Math.floor(((p.lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { z, x: clampTile(x, n), y: clampTile(y, n) };
}

function clampTile(v: number, n: number): number {
  return Math.max(0, Math.min(n - 1, v));
}

/** North-west corner of a tile. */
export function tileOrigin(t: TileXY): LatLon {
  const n = 2 ** t.z;
  const lon = (t.x / n) * 360 - 180;
  const lat = radToDeg(Math.atan(Math.sinh(Math.PI * (1 - (2 * t.y) / n))));
  return { lat, lon };
}

/** Bounding box of a tile as [west, south, east, north] degrees. */
export function tileBounds(t: TileXY): { nw: LatLon; se: LatLon } {
  return { nw: tileOrigin(t), se: tileOrigin({ z: t.z, x: t.x + 1, y: t.y + 1 }) };
}

/** Bing-style quadkey for a tile. */
export function quadkey(t: TileXY): string {
  let key = '';
  for (let i = t.z; i > 0; i--) {
    const mask = 1 << (i - 1);
    let digit = 0;
    if ((t.x & mask) !== 0) digit += 1;
    if ((t.y & mask) !== 0) digit += 2;
    key += String(digit);
  }
  return key;
}

/** Ground resolution at a latitude and zoom, metres per pixel (256 px tiles). */
export function metresPerPixel(lat: number, z: number): number {
  return (156543.03392 * Math.cos(degToRad(lat))) / 2 ** z;
}

/**
 * The tiles covering a box of `halfWidth` metres around a centre at zoom z,
 * as inclusive x/y ranges. Used by the polar view (what to draw) and the
 * prefetcher (what to download).
 */
export function tilesCovering(
  centre: LatLon,
  halfWidth: number,
  z: number,
): { z: number; x0: number; x1: number; y0: number; y1: number } {
  const dLat = radToDeg(halfWidth / EARTH_RADIUS_M);
  const dLon = radToDeg(halfWidth / (EARTH_RADIUS_M * Math.cos(degToRad(centre.lat))));
  const a = tileAt({ lat: centre.lat + dLat, lon: centre.lon - dLon }, z);
  const b = tileAt({ lat: centre.lat - dLat, lon: centre.lon + dLon }, z);
  return { z, x0: a.x, x1: b.x, y0: a.y, y1: b.y };
}
