import { degToRad, destination } from '@rode/core';
import { baseState, C, DEFAULT_SIM_BOAT, kn, noiseAt, ramp, type Scenario } from '../scenario.js';

const START = Date.UTC(2026, 8, 10, 14, 0, 0); // 14:00 UTC ≈ 11:00 local in Bermuda
const SLIP = { lat: 32.2915, lon: -64.8355 };
const HOUR = 3600;

const FAIL_START = 600;
/** Warms from -18 °C to ambient over 40 minutes: 1 °C/min. */
const FAIL_END = FAIL_START + 40 * 60;

// ---------------------------------------------------------------- 9. marina fridge failure

export const marinaFridgeFailure: Scenario = {
  id: 'marina-fridge-failure',
  name: 'Marina fridge failure',
  description:
    'Boat in a slip, marina mode, nobody aboard. After ten minutes the freezer compressor dies and the box warms 1 °C/min from -18 °C through the warning and alarm bands all the way to the 22 °C cabin, where it sits for the rest of the run.',
  expectation:
    'A band transition is reported for every step: normal → warm → failing → off. The failing condition raises and then clears itself when the box reaches ambient, but the transition log shows the whole story. No position, speed or wind alarm.',
  durationS: 2 * HOUR,
  startEpochMs: START,
  boat: DEFAULT_SIM_BOAT,
  marinaConfig: { bandHoldMs: 60_000 },
  utcOffsetHours: -3,
  commands: [{ at: 5, command: { type: 'marina' } }],
  state: (t) => {
    const n = noiseAt(9, t);
    const freezer =
      t < FAIL_START
        ? C(-18) + 0.3 * Math.sin(t / 300)
        : C(ramp(t, FAIL_START, FAIL_END, -18, 22)) + 0.1 * n.n1;
    return {
      ...baseState(START + t * 1000),
      // Tied up: a metre or two of movement on the lines, the vane spinning in
      // the marina eddies, which is exactly why the wind detector is off here.
      position: destination(
        destination(SLIP, 0, 1.2 * Math.sin(t / 50)),
        degToRad(90),
        0.8 * Math.cos(t / 37),
      ),
      heading: degToRad(45) + degToRad(3) * Math.sin(t / 20),
      sog: Math.abs(n.n1) * kn(0.2),
      cog: n.u * 2 * Math.PI,
      awa: degToRad(((t * 53) % 360) - 180),
      aws: kn(9) + kn(6) * Math.sin(t / 100),
      depth: 3.2,
      airTemp: C(22),
      fridgeTemp: C(4) + 0.4 * Math.sin(t / 200),
      freezerTemp: freezer,
      batterySoc: 0.86,
      batteryVoltage: 13.4,
      solarPower: 210 + 40 * Math.sin(t / 600),
      ais: [],
    };
  },
};
