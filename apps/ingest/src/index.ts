// @rode/ingest — gets data off the boat and into a normalized stream.
//
// Consumed as a library by @rode/server (same process, see
// docs/decisions.md 0.3). The `rode-sim` CLI in ./cli.ts runs the simulator
// standalone as a fake Cortex so the real TCP adapter path can be exercised
// end to end.

export * from './adapter.js';
export * from './normalize.js';
export * from './nmea/sentence.js';
export * from './nmea/parse.js';
export * from './nmea/encode.js';
export * from './nmea/ais.js';
export * from './sim/index.js';
export * from './sources/index.js';
export * from './sim/server.js';
