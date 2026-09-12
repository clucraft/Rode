import {
  distanceM,
  distanceToPolygonEdgeM,
  pathEntersPolygon,
  pointInPolygon,
  projectPosition,
} from './geodesy.js';
import type { LatLon } from './types.js';

/**
 * A polygon the boat must never enter (reef, cable area, lee shore) or must
 * never leave (fairway, channel). Checked independently of the swing circle,
 * because a radius alarm cannot know that the coral is *inside* the circle.
 */
export interface ExclusionZone {
  id: string;
  name: string;
  kind: 'never-enter' | 'must-stay-inside';
  enabled: boolean;
  /** Ring of at least three vertices; closure is implicit. */
  polygon: LatLon[];
}

export interface ZoneEvaluation {
  zoneId: string;
  /** Inside a never-enter zone, or outside a must-stay zone, right now. */
  breached: boolean;
  /** Current course and speed reach a breach within the look-ahead window. */
  projected: boolean;
  /** Metres to the zone boundary. */
  distanceToEdge: number;
  /** Seconds until projected breach, if projected. */
  secondsToBreach: number | null;
}

/** Minimum SOG for a projection to mean anything; below this COG is noise. */
const MIN_PROJECTION_SOG = 0.15; // m/s ≈ 0.3 kn

export function evaluateZone(
  zone: ExclusionZone,
  boat: LatLon,
  cogRad: number | null,
  sogMps: number | null,
  lookaheadMs: number,
): ZoneEvaluation {
  const inside = pointInPolygon(boat, zone.polygon);
  const breached = zone.kind === 'never-enter' ? inside : !inside;
  const distanceToEdge = distanceToPolygonEdgeM(boat, zone.polygon);

  let projected = false;
  let secondsToBreach: number | null = null;
  if (
    !breached &&
    cogRad !== null &&
    sogMps !== null &&
    sogMps >= MIN_PROJECTION_SOG &&
    lookaheadMs > 0
  ) {
    const seconds = lookaheadMs / 1000;
    const ahead = projectPosition(boat, cogRad, sogMps, seconds);
    if (zone.kind === 'never-enter') {
      projected = pathEntersPolygon(boat, ahead, zone.polygon);
    } else {
      projected = !pointInPolygon(ahead, zone.polygon);
    }
    if (projected) {
      // Straight-line estimate: distance to the edge along the track. Good
      // enough for "how long have I got"; the UI rounds it anyway.
      secondsToBreach = Math.max(0, Math.min(seconds, distanceToEdge / sogMps));
    }
  }

  return { zoneId: zone.id, breached, projected, distanceToEdge, secondsToBreach };
}

/** Basic validity: three or more vertices, all finite, non-degenerate span. */
export function validateZonePolygon(polygon: readonly LatLon[]): string | null {
  if (polygon.length < 3) return 'A zone needs at least three points.';
  for (const p of polygon) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon))
      return 'Zone contains an invalid point.';
    if (Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return 'Zone point is out of range.';
  }
  const first = polygon[0];
  if (first && polygon.every((p) => distanceM(first, p) < 1)) {
    return 'Zone points are all in the same place.';
  }
  return null;
}
