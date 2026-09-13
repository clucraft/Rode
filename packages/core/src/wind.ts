import { normaliseAngle } from './geodesy.js';

/*
 * Wind arithmetic. Apparent wind is what the masthead feels: the true wind
 * with the boat's own motion folded in. Everything here is radians, m/s,
 * "from" directions true.
 */

export interface WindInputs {
  /** Apparent wind angle relative to the bow, radians, positive to starboard. */
  awa: number;
  /** Apparent wind speed, m/s. */
  aws: number;
  /** Heading, radians true. */
  heading: number;
  /** Boat velocity: speed m/s and direction radians true. SOG/COG, or STW/heading. */
  speed: number;
  course: number;
}

export interface TrueWind {
  /** True wind speed, m/s. */
  tws: number;
  /** Direction the true wind blows from, radians true, 0..2π. */
  twd: number;
  /** True wind angle relative to the bow, radians, positive to starboard. */
  twa: number;
}

/** Direction the apparent wind blows from, radians true. */
export function apparentWindDirection(awa: number, heading: number): number {
  return normaliseAngle(heading + awa);
}

/**
 * True wind from apparent wind and boat motion. The air's motion relative
 * to the boat plus the boat's motion is the air's motion over the ground
 * (or water, if STW/heading are given). With the boat stopped, true equals
 * apparent.
 */
export function trueWind(w: WindInputs): TrueWind {
  const awd = apparentWindDirection(w.awa, w.heading);
  // Velocity of the air relative to the boat (it moves *towards* awd + π).
  const ax = w.aws * Math.sin(awd + Math.PI);
  const ay = w.aws * Math.cos(awd + Math.PI);
  const bx = w.speed * Math.sin(w.course);
  const by = w.speed * Math.cos(w.course);
  const tx = ax + bx;
  const ty = ay + by;
  const tws = Math.hypot(tx, ty);
  // Direction the true air comes from is opposite to where it goes.
  const twd = tws < 1e-9 ? awd : normaliseAngle(Math.atan2(tx, ty) + Math.PI);
  let twa = twd - w.heading;
  while (twa > Math.PI) twa -= 2 * Math.PI;
  while (twa <= -Math.PI) twa += 2 * Math.PI;
  return { tws, twd, twa };
}
