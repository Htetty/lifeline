import { describe, expect, it } from "vitest";
import { buildFloodGrid, computeFlood, depthAt, observationAt, type WaterObservation } from "../src/lib/flood";
import type { ElevationGrid } from "../src/lib/elevation";

// A flat valley floor at 5 m, about 40 x 40 cells of 15 m.
const bounds = { west: -117.17, south: 32.76, east: -117.1635, north: 32.7655 };
const flat = { sample: () => 5 } as unknown as ElevationGrid;
const grid = buildFloodGrid(flat, bounds, bounds.west);
const at = { lon: -117.16675, lat: 32.76275 };

function observation(meters: number, raiseOnly: boolean): WaterObservation {
  const o = observationAt(grid, { meters, floor: 0, gaugeSurface: 7 }, at.lon, at.lat, 3)!;
  return { lon: at.lon, lat: at.lat, ...o, weight: 1, raiseOnly };
}

describe("caller water in the flood model", () => {
  it("a report of shallower water lowers the river model", () => {
    const flood = computeFlood(grid, 7, [observation(0.3, false)]);
    expect(depthAt(grid, flood, at.lon, at.lat)).toBeLessThan(1);
  });

  it("a report with no depth never lowers the river model", () => {
    const flood = computeFlood(grid, 7, [observation(0.3, true)]);
    expect(depthAt(grid, flood, at.lon, at.lat)).toBeCloseTo(2, 1);
  });

  it("a report with no depth still adds water where the model is dry", () => {
    const dry = computeFlood(grid, 4, []);
    expect(depthAt(grid, dry, at.lon, at.lat)).toBe(0);
    const o = observationAt(grid, { meters: 0.3, floor: 0, gaugeSurface: 4 }, at.lon, at.lat, 3)!;
    const flood = computeFlood(grid, 4, [{ lon: at.lon, lat: at.lat, ...o, weight: 1, raiseOnly: true }]);
    expect(depthAt(grid, flood, at.lon, at.lat)).toBeCloseTo(0.3, 1);
  });
});
