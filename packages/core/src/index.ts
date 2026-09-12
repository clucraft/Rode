// @rode/core — pure domain logic. No I/O, no timers, no globals.
//
// Everything in here is SI internally: metres, metres/second, radians, kelvin,
// milliseconds since epoch (UTC). Lat/lon are decimal degrees. Conversion to
// display units happens at the edge, never here. See docs/decisions.md.

export * from './types.js';
export * from './units.js';
export * from './geodesy.js';
export * from './config.js';
export * from './geometry.js';
export * from './detectors.js';
export * from './zones.js';
export * from './anchor.js';
export * from './marina.js';
