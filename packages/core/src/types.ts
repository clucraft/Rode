/**
 * Core domain types. Everything is SI and UTC:
 *   - distances in metres, speeds in m/s, temperatures in kelvin
 *   - angles (heading, COG, wind angle, bearings) in radians
 *   - latitude/longitude in decimal degrees, WGS84 (see docs/decisions.md 1.1)
 *   - timestamps in milliseconds since the Unix epoch
 */

/** A WGS84 position in decimal degrees. */
export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * A normalised telemetry value. Every field the engine sees carries its own
 * timestamp and provenance; staleness is judged per field because depth going
 * stale is routine and position going stale is an emergency.
 */
export interface Field<T> {
  value: T;
  /** When the underlying sample was produced (ms epoch). */
  timestamp: number;
  /** Adapter or sentence that produced it, e.g. "nmea:GGA", "signalk", "manual". */
  source: string;
  /** True when the normaliser judged the sample older than its per-field max age. */
  stale: boolean;
}

/** Connection state of the upstream data source, as seen by the engine. */
export interface SourceState {
  connected: boolean;
  /** When the current connected/disconnected state began (ms epoch). */
  since: number;
}

/**
 * Snapshot of everything the engine may look at on a tick. Fields are optional
 * because a boat only has the instruments it has; the engine renders and
 * evaluates only what is present.
 */
export interface Telemetry {
  /** GNSS antenna position. Not the bow roller: see BoatGeometry. */
  position?: Field<LatLon>;
  /** Speed over ground, m/s. */
  sog?: Field<number>;
  /** Course over ground, radians true, 0..2π. */
  cog?: Field<number>;
  /** Heading, radians true, 0..2π. */
  heading?: Field<number>;
  /** Depth below the waterline, metres (transducer offset already applied). */
  depth?: Field<number>;
  /** Apparent wind angle relative to the bow, radians, -π..π, positive to starboard. */
  awa?: Field<number>;
  /** Apparent wind speed, m/s. */
  aws?: Field<number>;
  /** Horizontal dilution of precision, dimensionless. */
  hdop?: Field<number>;
  /** GNSS fix quality per GGA: 0 = none, 1 = GPS, 2 = DGPS, ... */
  fixQuality?: Field<number>;
  /** Number of satellites in use. */
  satellites?: Field<number>;

  // Marina-mode inputs (phase 8). Present only when the boat reports them.
  /** House bank state of charge, 0..1. */
  batterySoc?: Field<number>;
  /** House bank voltage, volts. */
  batteryVoltage?: Field<number>;
  /** Solar charge power, watts. */
  solarPower?: Field<number>;
  /** Fridge box temperature, kelvin. */
  fridgeTemp?: Field<number>;
  /** Freezer box temperature, kelvin. */
  freezerTemp?: Field<number>;
  /** Cabin / ambient air temperature, kelvin. */
  airTemp?: Field<number>;

  source: SourceState;
}

/**
 * Physical layout the geometry maths needs. All metres.
 *
 * The GNSS antenna is rarely at the bow roller; on a 12 m boat it is often
 * 8–10 m aft of it. Ignoring that puts several metres of false radius into
 * every swing circle. Measure it once, enter it once.
 */
export interface BoatGeometry {
  /** Distance from antenna to bow roller along the centreline. Positive = roller is forward. */
  antennaToBowForward: number;
  /** Distance from antenna to bow roller athwartships. Positive = roller is to starboard. */
  antennaToBowStarboard: number;
  /** Height of the bow roller above the waterline. */
  bowRollerHeight: number;
}

export type Severity = 'warning' | 'critical';
