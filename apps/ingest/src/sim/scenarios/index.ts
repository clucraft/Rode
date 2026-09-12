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
import { marinaFridgeFailure } from './marina.js';

/** The ten checked-in scenarios, in the order the spec lists them. */
export const SCENARIOS: readonly Scenario[] = [
  quietNight,
  slowDrag,
  breakOut,
  lightAirVaneSpin,
  gpsNoiseFloor,
  gpsDropout,
  sourceDisconnect,
  hardPowerCut,
  marinaFridgeFailure,
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
  marinaFridgeFailure,
  quietNight,
  slowDrag,
  sourceDisconnect,
  tidalSwing,
};
