// Downloads OpenStreetMap building footprints in the flood area and writes
// public/data/buildings.json: which flood-grid cells are covered by a building, and how tall
// it is, so boats in the router go around buildings the water isn't deep enough to clear.
// Run from dashboard/: `npm run fetch:buildings` (or `-- --from overpass.json` to skip the download).
// Building data © OpenStreetMap contributors.

import { readFileSync, writeFileSync } from "node:fs";
import { EXERCISE_BOUNDS as BOUNDS } from "../convex/seedData";
import { CELL_METERS, gridShape } from "../src/lib/flood";

/** Height when OSM has none: about one storey plus a roof, or three per storey for flats and hotels. */
const DEFAULT_HEIGHT_M: Record<string, number> = { apartments: 9, hotel: 12, residential: 9, house: 6, detached: 6 };
const OTHER_HEIGHT_M = 5;
const STOREY_M = 3;
/** A cell counts as building when at least this many of its 3×3 sample points are inside one. */
const MIN_SAMPLES = 4;
const SKIP = new Set(["roof", "carport", "construction", "ruins"]);

interface Way {
  type: string;
  geometry?: { lat: number; lon: number }[];
  tags: Record<string, string>;
}

async function download(): Promise<Way[]> {
  const { west, south, east, north } = BOUNDS;
  const query = `[out:json][timeout:150];way["building"](${south},${west},${north},${east});out geom tags;`;
  for (const wait of [0, 20, 40, 80]) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "hurricaneai-flood-demo/0.1" },
      body: new URLSearchParams({ data: query }),
    });
    const text = await res.text();
    if (res.ok && text.startsWith("{")) return JSON.parse(text).elements;
    console.warn(`Overpass busy (${res.status}), retrying…`);
  }
  throw new Error("Overpass unavailable; download the buildings yourself and pass --from <file>");
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
      let samples = 0;
      for (const fy of [0.2, 0.5, 0.8]) {
        for (const fx of [0.2, 0.5, 0.8]) {
          if (inside(BOUNDS.west + (c + fx) * dLon, BOUNDS.north - (r + fy) * dLat, ring)) samples++;
        }
      }
      if (samples >= MIN_SAMPLES) height[r * cols + c] = Math.max(height[r * cols + c], h);
    }
  }
  used++;
}

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
  new URL("../public/data/buildings.json", import.meta.url),
  JSON.stringify({ source: "© OpenStreetMap contributors (ODbL)", bounds: BOUNDS, cellMeters: CELL_METERS, cols, rows, runs }),
);
console.log(`${used} buildings → ${covered} of ${cols * rows} cells (${runs.length} runs)`);
