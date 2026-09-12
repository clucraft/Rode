// @rode/core — pure domain logic. No I/O, no timers, no globals.
//
// Everything in here is SI internally: metres, metres/second, radians, kelvin,
// milliseconds since epoch (UTC). Conversion to display units happens at the
// edge, never here. See docs/decisions.md#si-internally.

export * from './units.js';
