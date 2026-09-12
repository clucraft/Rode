// @rode/ingest — gets data off the boat and into a normalized stream.
//
// Consumed as a library by @rode/server (same process, see
// docs/decisions.md#single-process). The `rode-sim` CLI in ./cli.ts runs the
// simulator standalone as a fake Cortex so the real TCP adapter path can be
// exercised end to end.

export * from './adapter.js';
