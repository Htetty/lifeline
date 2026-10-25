// The dashboard's flood and road models, loaded in Node (the browser loader decodes tiles
// with OffscreenCanvas). Used by the demo scenario builder. Run with scripts/run.mjs.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Region } from "../../convex/regions";
import { DEM_ZOOM, ElevationGrid, type Bounds } from "../../src/lib/elevation";
import { buildRegionGrid, gridShape } from "../../src/lib/flood";
import { buildGraph, type RoadFile } from "../../src/lib/router";

const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TILE_SIZE = 256;

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z;
};

export async function loadElevation(bounds: Bounds) {
  const x0 = Math.floor(lonToX(bounds.west, DEM_ZOOM));
  const x1 = Math.floor(lonToX(bounds.east, DEM_ZOOM));
  const y0 = Math.floor(latToY(bounds.north, DEM_ZOOM));
  const y1 = Math.floor(latToY(bounds.south, DEM_ZOOM));
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const w = cols * TILE_SIZE;
  const data = new Float32Array(w * rows * TILE_SIZE);
  const jobs: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const url = TILE_URL.replace("{z}", String(DEM_ZOOM)).replace("{x}", String(tx)).replace("{y}", String(ty));
      jobs.push(
        fetch(url)
          .then(async (res) => {
            if (!res.ok) throw new Error(`Elevation tile ${tx}/${ty} failed: ${res.status}`);
            return sharp(Buffer.from(await res.arrayBuffer())).ensureAlpha().raw().toBuffer();
          })
          .then((px) => {
            const ox = (tx - x0) * TILE_SIZE;
            const oy = (ty - y0) * TILE_SIZE;
            for (let py = 0; py < TILE_SIZE; py++) {
              for (let pxl = 0; pxl < TILE_SIZE; pxl++) {
                const i = (py * TILE_SIZE + pxl) * 4;
                data[(oy + py) * w + ox + pxl] = px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768;
              }
            }
          }),
      );
    }
  }
  await Promise.all(jobs);
  return new ElevationGrid(data, x0, y0, cols, rows);
}

/** A region's flood grid (with its buildings) and road graph, as the dashboard builds them. */
export async function loadModel(region: Region) {
  const elevation = await loadElevation(region.bounds);
  const data = (file: string) => JSON.parse(readFileSync(join(__dirname, `../../public/data/${region.id}/${file}`), "utf8"));
  const buildings = new Float32Array(gridShape(region.bounds).cols * gridShape(region.bounds).rows);
  for (const [start, length, dm] of data("buildings.json").runs as number[][]) buildings.fill(dm / 10, start, start + length);
  const grid = { ...buildRegionGrid(elevation, region), buildings };
  return { elevation, grid, roads: buildGraph(data("roads.json") as RoadFile) };
}
