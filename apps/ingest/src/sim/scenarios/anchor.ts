import { degToRad, destination, normaliseAngle, normaliseRelativeAngle } from '@rode/core';
import {
  baseState,
  C,
  DEFAULT_SIM_BOAT,
  kn,
  noiseAt,
  PROLOGUE,
  prologueCommands,
  prologueRun,
  ramp,
  ride,
  SIM_ANCHOR,
  swingState,
  type BoatState,
  type Scenario,
} from '../scenario.js';

const START = Date.UTC(2026, 8, 10, 22, 0, 0); // 22:00 UTC, local evening in Bermuda
const RUN = 30;
const HOUR = 3600;

function anchorBase(t: number, overrides: Partial<BoatState>): BoatState {
  return { ...baseState(START + t * 1000), ...overrides };
}

/** The neighbours: a couple of anchored boats and one passing motor yacht. */
function neighbours(t: number) {
  return [
    {
      mmsi: 316001234,
      name: 'WANDERER',
      position: destination(SIM_ANCHOR, degToRad(70), 180),
      sog: 0,
      cog: 0,
    },
    {
      mmsi: 316005678,
      name: 'MOONSHADOW',
      position: destination(SIM_ANCHOR, degToRad(300), 220),
      sog: 0,
      cog: 0,
      classB: true,
    },
    {
      mmsi: 319009999,
      name: 'PASSING YACHT',
      position: destination(
        destination(SIM_ANCHOR, degToRad(180), 600),
        degToRad(90),
        ((t * 4) % 2400) - 1200,
      ),
      sog: kn(8),
      cog: degToRad(90),
    },
  ];
}

// ---------------------------------------------------------------- 1. quiet night

export const quietNight: Scenario = {
  id: 'quiet-night',
  name: 'Quiet night',
  description:
    'Twelve hours swinging normally on a slow wind shift from SSW to W. Yaw, run breathing, SOG jitter, light AIS traffic.',
  expectation:
    'No warning or alarm of any kind. Anything raised here is a false positive and a test failure.',
  durationS: 12 * HOUR,
  startEpochMs: START,
  boat: DEFAULT_SIM_BOAT,
  commands: prologueCommands,
  state: (t) =>
    anchorBase(t, {
      ...swingState({
        seed: 1,
        t,
        anchor: SIM_ANCHOR,
        boat: DEFAULT_SIM_BOAT,
        finalRun: RUN,
        bearingFrom: degToRad(200),
        bearingTo: degToRad(260),
        driftOverS: 10 * HOUR,
      }),
      depth: 6 + 0.15 * Math.sin(t / 30),
      ais: neighbours(t),
    }),
};

// ---------------------------------------------------------------- 2. slow drag

const DRAG_START = 600;
const DRAG_END = DRAG_START + 20 * 60;

export const slowDrag: Scenario = {
  id: 'slow-drag',
  name: 'Slow drag',
  description:
    'Ten minutes settled, then the anchor drags 1.5 m/min for twenty minutes: the run grows from 30 m to 60 m, past the 48 m circle.',
  expectation:
    'The position warning fires before the alarm, with several minutes of lead time. Final state ALARM with position-outside.',
  durationS: DRAG_END + 10 * 60,
  startEpochMs: START,
  boat: DEFAULT_SIM_BOAT,
  commands: prologueCommands,
  state: (t) => {
    const s = swingState({
      seed: 2,
      t,
      anchor: SIM_ANCHOR,
      boat: DEFAULT_SIM_BOAT,
      finalRun: RUN,
      bearingFrom: degToRad(210),
      bearingTo: degToRad(215),
      driftOverS: HOUR,
    });
    if (t >= DRAG_START) {
      const run = ramp(t, DRAG_START, DRAG_END, RUN, 60) + noiseAt(2, t).n1 * 0.5;
      const r = ride({ anchor: SIM_ANCHOR, bearing: degToRad(212), run, boat: DEFAULT_SIM_BOAT });
      s.position = r.antenna;
      s.heading = r.heading;
      // Dragging slowly: the boat still lies to the wind, SOG barely above rest.
      s.sog = kn(0.15) + Math.abs(noiseAt(2, t).n2) * kn(0.2);
    }
    return anchorBase(t, s);
  },
};

// ---------------------------------------------------------------- 3. break-out

const BREAK_START = 600;
const BREAK_DRIFT = BREAK_START + 60;

export const breakOut: Scenario = {
  id: 'break-out',
  name: 'Break-out',
  description:
    'The anchor lets go. For a minute the boat sails around it at 1.5 kn with the wind 110° off the bow while still inside the circle, then drifts out.',
  expectation:
    'The combined wind-angle + speed rule escalates straight to critical (break-out) before the position alarm fires.',
  durationS: BREAK_DRIFT + 5 * 60,
  startEpochMs: START,
  boat: DEFAULT_SIM_BOAT,
  commands: prologueCommands,
  state: (t) => {
    const s = swingState({
      seed: 3,
      t,
      anchor: SIM_ANCHOR,
      boat: DEFAULT_SIM_BOAT,
      finalRun: RUN,
      bearingFrom: degToRad(200),
      bearingTo: degToRad(205),
      driftOverS: HOUR,
      awsMps: kn(16),
    });
    if (t >= BREAK_START) {
      const speed = kn(1.5);
      // Sailing around the anchor: bearing advances at v/r, run constant until drift.
      const omega = speed / RUN;
      const bearing = degToRad(205) + omega * (t - BREAK_START);
      const run = t < BREAK_DRIFT ? RUN : RUN + speed * (t - BREAK_DRIFT);
      const heading = normaliseAngle(bearing + Math.PI / 2); // beam-on to the anchor
      const r = ride({ anchor: SIM_ANCHOR, bearing, run, heading, boat: DEFAULT_SIM_BOAT });
      s.position = r.antenna;
      s.heading = heading;
      s.sog = speed + noiseAt(3, t).n1 * kn(0.1);
      s.cog = normaliseAngle(heading);
      s.awa = normaliseRelativeAngle(degToRad(110) + degToRad(6) * noiseAt(3, t).n2);
      s.aws = kn(18);
    }
    return anchorBase(t, s);
  },
};

// ---------------------------------------------------------------- 4. light-air vane spin

export const lightAirVaneSpin: Scenario = {
  id: 'light-air-vane-spin',
  name: 'Light-air vane spin',
  description:
    'Two hours of glassy calm. Apparent wind 0–4 kn and the vane wanders the full circle. The boat sits still on its rode.',
  expectation:
    'No wind-shift warning, ever. This is the regression test for the most common false alarm.',
  durationS: 2 * HOUR,
  startEpochMs: START,
  boat: DEFAULT_SIM_BOAT,
  commands: prologueCommands,
  state: (t) => {
    const s = swingState({
      seed: 4,
      t,
      anchor: SIM_ANCHOR,
      boat: DEFAULT_SIM_BOAT,
      finalRun: RUN,
      bearingFrom: degToRad(180),
      bearingTo: degToRad(190),
      driftOverS: HOUR,
    });
    if (t >= PROLOGUE.setAt) {
      // Random walk around the full circle; speed floor never reached.
      s.awa = normaliseRelativeAngle(degToRad(((t * 37) % 360) - 180 + 30 * noiseAt(4, t).n1));
      s.aws = kn(2) + kn(2) * Math.sin(t / 90) + Math.abs(noiseAt(4, t).n2) * kn(0.5);
      s.sog = Math.abs(noiseAt(4, t).n1) * kn(0.15);
    }
    return anchorBase(t, s);
  },
};

// ---------------------------------------------------------------- 5. GPS noise floor

export const gpsNoiseFloor: Scenario = {
  id: 'gps-noise-floor',
  name: 'GPS noise floor',
  description:
    'One hour stationary with realistic position scatter (σ ≈ 2.5 m), HDOP 1.8 and reported SOG hovering 0.6–1.1 kn: what a cheap receiver says about a boat that is not moving.',
  expectation:
    'No warning or alarm. The 1.2 kn speed threshold and the 10 s position hold exist for exactly this.',
  durationS: HOUR,
  startEpochMs: START,
  boat: DEFAULT_SIM_BOAT,
  commands: prologueCommands,
  state: (t) => {
    const s = swingState({
      seed: 5,
      t,
      anchor: SIM_ANCHOR,
      boat: DEFAULT_SIM_BOAT,
      finalRun: 28,
      bearingFrom: degToRad(220),
      bearingTo: degToRad(222),
      driftOverS: HOUR,
    });
    if (t >= PROLOGUE.setAt) {
      const n = noiseAt(5, t);
      const r = ride({
        anchor: SIM_ANCHOR,
        bearing: degToRad(221),
        run: 28,
        boat: DEFAULT_SIM_BOAT,
      });
      s.position = destination(destination(r.antenna, 0, n.n1 * 2.5), Math.PI / 2, n.n2 * 2.5);
      s.heading = r.heading;
      s.sog = kn(0.6) + n.u * kn(0.5);
      s.cog = n.u * 2 * Math.PI;
      s.hdop = 1.8;
    }
    return anchorBase(t, s);
  },
};

// ---------------------------------------------------------------- 6. GPS dropout

const DROPOUT_AT = 600;
const DROPOUT_FOR = 90;

export const gpsDropout: Scenario = {
  id: 'gps-dropout',
  name: 'GPS dropout',
  description:
    'Ten minutes settled, then the receiver loses the sky for 90 seconds (RMC status V, empty GGA) and recovers.',
  expectation:
    'gps-stale warning at 30 s, critical at 60 s, cleared cleanly when the fix returns. Nothing else fires.',
  durationS: 15 * 60,
  startEpochMs: START,
  boat: DEFAULT_SIM_BOAT,
  commands: prologueCommands,
  state: (t) => {
    const s = swingState({
      seed: 6,
      t,
      anchor: SIM_ANCHOR,
      boat: DEFAULT_SIM_BOAT,
      finalRun: RUN,
      bearingFrom: degToRad(200),
      bearingTo: degToRad(203),
      driftOverS: HOUR,
    });
    if (t >= DROPOUT_AT && t < DROPOUT_AT + DROPOUT_FOR) {
      s.position = null;
      s.satellites = 0;
      s.hdop = 99;
    }
    return anchorBase(t, s);
  },
};

// ---------------------------------------------------------------- 7. source disconnect

const DISCONNECT_AT = 600;
const DISCONNECT_FOR = 60;

export const sourceDisconnect: Scenario = {
  id: 'source-disconnect',
  name: 'Source disconnect',
  description:
    'The TCP connection to the hub drops for 60 seconds mid-session, then the hub comes back.',
  expectation:
    'source-disconnected goes critical after the grace period, gps-stale rides along, both clear on reconnect, and the anchor session is untouched.',
  durationS: 15 * 60,
  startEpochMs: START,
  boat: DEFAULT_SIM_BOAT,
  commands: prologueCommands,
  state: (t) => {
    const s = swingState({
      seed: 7,
      t,
      anchor: SIM_ANCHOR,
      boat: DEFAULT_SIM_BOAT,
      finalRun: RUN,
      bearingFrom: degToRad(200),
      bearingTo: degToRad(203),
      driftOverS: HOUR,
    });
    return anchorBase(t, {
      ...s,
      connected: !(t >= DISCONNECT_AT && t < DISCONNECT_AT + DISCONNECT_FOR),
    });
  },
};

// ---------------------------------------------------------------- 8. hard power cut

const CUT_AT = 600;
const RESTART_AT = 645;
const POST_CUT_DRAG = 700;

export const hardPowerCut: Scenario = {
  id: 'hard-power-cut',
  name: 'Hard power cut',
  description:
    'The box loses power at t=600 s and boots again at t=645 s. From t=700 s the anchor drags so the resumed watch has something to catch.',
  expectation:
    'After restart the session is rehydrated with identical geometry, no spurious alarm on boot, and the drag is caught: WARNING then ALARM.',
  durationS: 20 * 60,
  startEpochMs: START,
  boat: DEFAULT_SIM_BOAT,
  commands: prologueCommands,
  powerCut: { cutAt: CUT_AT, restartAt: RESTART_AT },
  state: (t) => {
    const s = swingState({
      seed: 8,
      t,
      anchor: SIM_ANCHOR,
      boat: DEFAULT_SIM_BOAT,
      finalRun: RUN,
      bearingFrom: degToRad(200),
      bearingTo: degToRad(203),
      driftOverS: HOUR,
    });
    if (t >= POST_CUT_DRAG) {
      const run = ramp(t, POST_CUT_DRAG, POST_CUT_DRAG + 10 * 60, RUN, 65);
      const r = ride({ anchor: SIM_ANCHOR, bearing: degToRad(202), run, boat: DEFAULT_SIM_BOAT });
      s.position = r.antenna;
      s.heading = r.heading;
    }
    return anchorBase(t, s);
  },
};

// ---------------------------------------------------------------- 10. tidal swing

export const tidalSwing: Scenario = {
  id: 'tidal-swing',
  name: 'Tidal swing',
  description:
    'Twelve hours over a full tide: the sounder reads 6 m at drop and swings ±1.5 m through the night. The boat swings normally.',
  expectation:
    'Geometry stays computed from the captured 6 m drop depth for the whole session; the live depth changes and nothing alarms.',
  durationS: 12 * HOUR,
  startEpochMs: START,
  boat: DEFAULT_SIM_BOAT,
  commands: [
    ...prologueCommands,
    { at: PROLOGUE.setAt + 60, command: { type: 'set-tide', tideRange: 1.5 } },
  ],
  state: (t) =>
    anchorBase(t, {
      ...swingState({
        seed: 10,
        t,
        anchor: SIM_ANCHOR,
        boat: DEFAULT_SIM_BOAT,
        finalRun: RUN,
        bearingFrom: degToRad(190),
        bearingTo: degToRad(230),
        driftOverS: 8 * HOUR,
      }),
      // 12.42 h lunar tide, starting at mid-tide falling.
      depth: 6 + 1.5 * Math.sin((2 * Math.PI * t) / (12.42 * HOUR) + Math.PI),
      waterTemp: C(24),
      ais: neighbours(t),
    }),
};

export { prologueRun };
