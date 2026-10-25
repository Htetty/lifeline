// Downloads OpenStreetMap building footprints in a region's area and writes
// public/data/<region>/buildings.json: which flood-grid cells are covered by a building, and how
// tall it is, so boats in the router go around buildings the water isn't deep enough to clear.
// Run from dashboard/: `npm run fetch:buildings -- --region sf-waterfront`
// (add `--from overpass.json` to skip the download).
// Building data © OpenStreetMap contributors.

import { readFileSync, writeFileSync } from "node:fs";
import { overpass } from "./overpass";
import { regionArg } from "./regionArg";
import { CELL_METERS, gridShape } from "../src/lib/flood";

const region = regionArg();
const BOUNDS = region.bounds;

/** Height when OSM has none: about one storey plus a roof, or three per storey for flats and hotels. */
const DEFAULT_HEIGHT_M: Record<string, number> = { apartments: 9, hotel: 12, residential: 9, house: 6, detached: 6 };
const OTHER_HEIGHT_M = 5;
const STOREY_M = 3;
/** A cell counts as building when at least this many of its 3×3 sample points are inside buildings. */
const MIN_SAMPLES = 4;
const SAMPLE = [0.2, 0.5, 0.8];
const bitCount = (n: number) => {
  let count = 0;
  for (; n; n &= n - 1) count++;
  return count;
};
const SKIP = new Set(["roof", "carport", "construction", "ruins"]);

interface Way {
  type: string;
  geometry?: { lat: number; lon: number }[];
  tags: Record<string, string>;
}

async function download(): Promise<Way[]> {
  const { west, south, east, north } = BOUNDS;
  return overpass<Way>(`[out:json][timeout:150];way["building"](${south},${west},${north},${east});out geom tags;`);
}

function heightOf(tags: Record<string, string>) {
  const h = Number.parseFloat(tags.height ?? "");
  if (Number.isFinite(h) && h > 0) return h;
  const levels = Number.parseInt(tags["building:levels"] ?? "", 10);
  if (Number.isFinite(levels) && levels > 0) return levels * STOREY_M + 1;
  return DEFAULT_HEIGHT_M[tags.building] ?? OTHER_HEIGHT_M;
}

function inside(x: number, y: number, ring: { lat: number; lon: number }[]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.lat > y !== b.lat > y && x < ((b.lon - a.lon) * (y - a.lat)) / (b.lat - a.lat) + a.lon) hit = !hit;
  }
  return hit;
}

const from = process.argv.indexOf("--from");
const ways: Way[] = from > 0 ? JSON.parse(readFileSync(process.argv[from + 1], "utf8")).elements : await download();
const { dLat, dLon, cols, rows } = gridShape(BOUNDS);
const height = new Float32Array(cols * rows);
// Which of each cell's 3×3 sample points fall in any building, so a row of narrow houses
// sharing walls fills its cells even when no single house covers enough of one.
const sampled = new Uint16Array(cols * rows);
let used = 0;
for (const way of ways) {
  const ring = way.geometry;
  if (way.type !== "way" || !ring || ring.length < 4 || SKIP.has(way.tags.building)) continue;
  const h = heightOf(way.tags);
  const lons = ring.map((p) => p.lon);
  const lats = ring.map((p) => p.lat);
  const c0 = Math.max(0, Math.floor((Math.min(...lons) - BOUNDS.west) / dLon));
  const c1 = Math.min(cols - 1, Math.floor((Math.max(...lons) - BOUNDS.west) / dLon));
  const r0 = Math.max(0, Math.floor((BOUNDS.north - Math.max(...lats)) / dLat));
  const r1 = Math.min(rows - 1, Math.floor((BOUNDS.north - Math.min(...lats)) / dLat));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      let hits = 0;
      for (let k = 0; k < 9; k++) {
        if (inside(BOUNDS.west + (c + SAMPLE[k % 3]) * dLon, BOUNDS.north - (r + SAMPLE[Math.floor(k / 3)]) * dLat, ring)) hits |= 1 << k;
      }
      if (!hits) continue;
      sampled[r * cols + c] |= hits;
      height[r * cols + c] = Math.max(height[r * cols + c], h);
    }
  }
  used++;
}
for (let i = 0; i < height.length; i++) if (bitCount(sampled[i]) < MIN_SAMPLES) height[i] = 0;

// Runs of cells with the same height: [first cell, number of cells, height in decimetres].
const runs: number[][] = [];
for (let i = 0; i < height.length; ) {
  if (!height[i]) {
    i++;
    continue;
  }
  let j = i + 1;
  while (j < height.length && height[j] === height[i]) j++;
  runs.push([i, j - i, Math.round(height[i] * 10)]);
  i = j;
}
const covered = runs.reduce((n, [, len]) => n + len, 0);
writeFileSync(
  new URL(`../public/data/${region.id}/buildings.json`, import.meta.url),
  JSON.stringify({ source: "© OpenStreetMap contributors (ODbL)", bounds: BOUNDS, cellMeters: CELL_METERS, cols, rows, runs }),
);
console.log(`${used} buildings → ${covered} of ${cols * rows} cells (${runs.length} runs)`);
