import type { Scenario } from '../scenario.js';
import {
  breakOut,
  gpsDropout,
  gpsNoiseFloor,
  hardPowerCut,
  lightAirVaneSpin,
  quietNight,
  slowDrag,
  sourceDisconnect,
  tidalSwing,
} from './anchor.js';

/** The checked-in scenarios, in the order the spec lists them. */
export const SCENARIOS: readonly Scenario[] = [
  quietNight,
  slowDrag,
  breakOut,
  lightAirVaneSpin,
  gpsNoiseFloor,
  gpsDropout,
  sourceDisconnect,
  hardPowerCut,
  tidalSwing,
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export {
  breakOut,
  gpsDropout,
  gpsNoiseFloor,
  hardPowerCut,
  lightAirVaneSpin,
  quietNight,
  slowDrag,
  sourceDisconnect,
  tidalSwing,
};
