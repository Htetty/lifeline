import { expect, test } from "vitest";
import type { FloodGrid, FloodResult } from "../src/lib/flood";
import { buildGraph, planRoute } from "../src/lib/router";

// A 20 × 20 grid of 15 m cells under 1.5 m of water, with a wall of buildings across the
// middle that leaves a gap at the east end. Fictional geometry; no roads.
const N = 20;
const grid = (buildings?: Float32Array): FloodGrid => {
  const dLat = 15 / 111_320;
  const dLon = 15 / (111_320 * Math.cos((32.76 * Math.PI) / 180));
  return {
    bounds: { west: -117.17, east: -117.17 + N * dLon, north: 32.76 + N * dLat, south: 32.76 },
    cols: N, rows: N, dLon, dLat, ground: new Float32Array(N * N), seeds: [], channel: new Float32Array(N), gaugeCol: 0, buildings,
  };
};
const flood = (depth: number): FloodResult => ({
  waterSurface: depth, delta: null, wet: new Uint8Array(N * N).fill(1), depth: new Float32Array(N * N).fill(depth),
  geojson: { type: "FeatureCollection", features: [] },
});
const wall = (height: number) => {
  const b = new Float32Array(N * N);
  for (let c = 0; c < N - 3; c++) b[10 * N + c] = height; // row 10, open at the last three columns
  return b;
};
const roads = buildGraph({ bounds: { south: 32.76, north: 32.77 }, classes: [], nodes: [], edges: [] });
const at = (g: FloodGrid, r: number, c: number) => ({ longitude: g.bounds.west + (c + 0.5) * g.dLon, latitude: g.bounds.north - (r + 0.5) * g.dLat });
const boat = (g: FloodGrid) => ({ ...at(g, 2, 2), capabilities: ["boat" as const] });
const rowOf = (g: FloodGrid, p: number[]) => Math.floor((g.bounds.north - p[1]) / g.dLat);
const colOf = (g: FloodGrid, p: number[]) => Math.floor((p[0] - g.bounds.west) / g.dLon);

test("a boat goes around buildings the water doesn't top", () => {
  const g = grid(wall(6));
  const r = planRoute(roads, g, flood(1.5), boat(g), at(g, 17, 2));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const water = r.path.slice(0, r.legs.find((l) => l.mode === "water")!.end + 1);
  expect(water.every((p) => rowOf(g, p) !== 10 || colOf(g, p) >= N - 3)).toBe(true);
  // Straight across would be 15 cells; the detour through the gap is longer.
  const open = planRoute(roads, grid(), flood(1.5), boat(g), at(g, 17, 2));
  expect(open.ok && r.realSeconds > open.realSeconds).toBe(true);
});

test("a boat crosses a building the water is over", () => {
  const g = grid(wall(1));
  const r = planRoute(roads, g, flood(1.5), boat(g), at(g, 17, 2));
  const open = planRoute(roads, grid(), flood(1.5), boat(g), at(g, 17, 2));
  expect(r.ok && open.ok && Math.round(r.realSeconds)).toBe(open.ok && Math.round(open.realSeconds));
});

test("a boat pulls up at the walls of a big building and the crew walks in", () => {
  const b = new Float32Array(N * N);
  for (let r = 12; r < 19; r++) for (let c = 6; c < 14; c++) b[r * N + c] = 8; // 105 × 120 m block
  const g = grid(b);
  const r = planRoute(roads, g, flood(1.5), boat(g), at(g, 15, 9)); // the middle of the block
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.legs.at(-1)!.mode).toBe("foot");
  const water = r.path.slice(0, r.legs.find((l) => l.mode === "water")!.end + 1);
  expect(water.every((p) => !b[rowOf(g, p) * N + colOf(g, p)])).toBe(true);
});
