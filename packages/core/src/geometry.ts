import type { AlarmConfig } from './config.js';
import { bearingRad, distanceM, offsetByHeading } from './geodesy.js';
import type { BoatGeometry, LatLon } from './types.js';

/**
 * Everything derived at "Anchor set". Recomputed on nudge and on a tide
 * change; otherwise fixed for the session. All metres / radians.
 */
export interface AnchorGeometry {
  /** Great-circle distance from anchor to the set position. */
  horizontalRun: number;
  /** Depth at drop plus bow-roller height: the vertical leg of the rode triangle. */
  verticalDrop: number;
  /** Straight-line rode from bow roller to anchor. A lower bound on rode actually paid out. */
  rodeLength: number;
  /** rodeLength / verticalDrop. What skippers mean by "5:1". */
  scopeRatio: number;
  /** Scope at the top of the expected tide, i.e. the worst case. Equals scopeRatio with no tide. */
  scopeRatioAtHighWater: number;
  /** Total margin applied: swingMargin + HDOP term. */
  swingMargin: number;
  /** HDOP-derived part of the margin, reported separately for the UI. */
  hdopMargin: number;
  /** Radius of the alarm circle around the anchor. */
  swingRadius: number;
  /** Inner edge of the warning band: swingRadius - warnDistance, never below zero. */
  warnRadius: number;
  /** Bearing from anchor to set position, radians true. */
  bearingAnchorToBoat: number;
  /** Inputs, echoed so a session row is self-describing. */
  depthAtDrop: number;
  bowRollerHeight: number;
  tideRange: number;
  hdopAtSet: number | null;
}

export interface GeometryInputs {
  /** Anchor position, bow-roller corrected at drop and possibly nudged since. */
  anchor: LatLon;
  /** Boat's bow-roller position when the skipper pressed "Anchor set". */
  setPosition: LatLon;
  /** Depth below waterline at drop, metres. Captured once; reused all session. */
  depthAtDrop: number;
  /** Expected tidal range during the stay, metres. Zero if unknown. */
  tideRange: number;
  /** HDOP at set, if known. Widens the margin. */
  hdop: number | null;
  boat: BoatGeometry;
  config: AlarmConfig;
}

/**
 * The core rode/scope computation. Pure; documented in the spec §6.2.
 *
 *   horizontalRun = distance(anchor, setPosition)
 *   verticalDrop  = depthAtDrop + bowRollerHeight
 *   rodeLength    = hypot(horizontalRun, verticalDrop)
 *   scopeRatio    = rodeLength / verticalDrop
 *   swingRadius   = maxHorizontalRun + margin
 *
 * Tide: with a fixed rode, a falling tide lets the boat lie further from the
 * anchor (the horizontal leg grows as the vertical leg shrinks). The radius
 * uses the horizontal run at the *lowest* expected water so the circle stays
 * honest through the night; the displayed worst-case scope uses the *highest*.
 */
export function computeAnchorGeometry(inputs: GeometryInputs): AnchorGeometry {
  const { anchor, setPosition, boat, config } = inputs;
  const depthAtDrop = Math.max(0, inputs.depthAtDrop);
  const tideRange = Math.max(0, inputs.tideRange);
  const bowRollerHeight = Math.max(0, boat.bowRollerHeight);

  const horizontalRun = distanceM(anchor, setPosition);
  const verticalDrop = depthAtDrop + bowRollerHeight;
  const rodeLength = Math.hypot(horizontalRun, verticalDrop);

  // Guard the ratio against a zero vertical leg (dinghy in a puddle).
  const scopeRatio = verticalDrop > 0 ? rodeLength / verticalDrop : Number.POSITIVE_INFINITY;
  const highWaterDrop = verticalDrop + tideRange;
  const scopeRatioAtHighWater =
    highWaterDrop > 0 ? rodeLength / highWaterDrop : Number.POSITIVE_INFINITY;

  // Horizontal run possible at low water with the same rode out.
  const lowWaterDrop = Math.max(0, verticalDrop - tideRange);
  const maxHorizontalRun = Math.sqrt(Math.max(0, rodeLength ** 2 - lowWaterDrop ** 2));

  const hdopMargin =
    inputs.hdop !== null && Number.isFinite(inputs.hdop) && inputs.hdop > 0
      ? Math.min(config.hdopMarginCap, inputs.hdop * config.hdopUere)
      : 0;
  const swingMargin = config.swingMargin + hdopMargin;
  const swingRadius = maxHorizontalRun + swingMargin;
  const warnRadius = Math.max(0, swingRadius - config.warnDistance);

  return {
    horizontalRun,
    verticalDrop,
    rodeLength,
    scopeRatio,
    scopeRatioAtHighWater,
    swingMargin,
    hdopMargin,
    swingRadius,
    warnRadius,
    bearingAnchorToBoat: horizontalRun > 0 ? bearingRad(anchor, setPosition) : 0,
    depthAtDrop,
    bowRollerHeight,
    tideRange,
    hdopAtSet: inputs.hdop,
  };
}

/**
 * Suggested rode for a target scope at the current depth. Shown in IDLE so the
 * skipper knows what to pay out before the hook goes down.
 */
export function suggestedRode(depth: number, bowRollerHeight: number, scope: number): number {
  return Math.max(0, depth + bowRollerHeight) * scope;
}

/**
 * Bow-roller position from the antenna position and heading. When heading is
 * unavailable the antenna position is returned and `corrected` is false so the
 * UI can say so rather than silently using the wrong point.
 */
export function bowRollerPosition(
  antenna: LatLon,
  headingRad: number | null,
  boat: BoatGeometry,
): { position: LatLon; corrected: boolean } {
  if (headingRad === null || !Number.isFinite(headingRad)) {
    return { position: antenna, corrected: false };
  }
  return {
    position: offsetByHeading(
      antenna,
      headingRad,
      boat.antennaToBowForward,
      boat.antennaToBowStarboard,
    ),
    corrected: boat.antennaToBowForward !== 0 || boat.antennaToBowStarboard !== 0,
  };
}
