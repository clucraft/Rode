/**
 * Unit conversion constants and helpers.
 *
 * Internal representation is always SI. These helpers exist so that the
 * display layer and the NMEA parser convert in exactly one place each.
 */

export const METRES_PER_NAUTICAL_MILE = 1852;
export const METRES_PER_FOOT = 0.3048;
export const METRES_PER_FATHOM = 1.8288;
export const SECONDS_PER_HOUR = 3600;

/** Knots → metres per second. */
export function knotsToMps(knots: number): number {
  return (knots * METRES_PER_NAUTICAL_MILE) / SECONDS_PER_HOUR;
}

/** Metres per second → knots. */
export function mpsToKnots(mps: number): number {
  return (mps * SECONDS_PER_HOUR) / METRES_PER_NAUTICAL_MILE;
}

/** Degrees → radians. */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Radians → degrees. */
export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Feet → metres. */
export function feetToMetres(ft: number): number {
  return ft * METRES_PER_FOOT;
}

/** Metres → feet. */
export function metresToFeet(m: number): number {
  return m / METRES_PER_FOOT;
}

/** Celsius → kelvin. */
export function celsiusToKelvin(c: number): number {
  return c + 273.15;
}

/** Kelvin → celsius. */
export function kelvinToCelsius(k: number): number {
  return k - 273.15;
}
