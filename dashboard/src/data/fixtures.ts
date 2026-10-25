import { EXERCISE_BOUNDS, EXERCISE_NAME } from "../../convex/seedData";

// Map settings for the demo area. Exercise data (incidents, teams) lives in
// Convex and is seeded from convex/seedData.ts.

export const DEMO_AREA = {
  name: EXERCISE_NAME,
  center: [-117.1635, 32.7628] as [number, number],
  zoom: 15.4,
  pitch: 60,
  bearing: -20,
  // Area over which the simulated flood is computed.
  floodBounds: EXERCISE_BOUNDS,
};
