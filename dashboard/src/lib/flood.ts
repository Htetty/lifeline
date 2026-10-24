import type { Bounds, ElevationGrid } from "./elevation";

// Simplified flood: the water surface is set by the river gauge and runs parallel
// to the river channel (same depth above the channel along the valley). Water fills
// every cell lower than the surface AND connected to the channel. It ignores
// flow, levees, drainage and backwater, so it is an approximation, not a
// hydraulic model.

const CELL_METERS = 15;
const DEPTH_STEP = 0.2; // runs of cells are merged when depths round to the same step

export interface FloodGrid {
  bounds: Bounds;
  cols: number;
  rows: number;
  dLon: number;
  dLat: number;
  ground: Float32Array; // NaN where unknown
  /** For each column, the row index of its lowest cell — used as river seeds. */
  seeds: number[];
  /** River channel elevation per column, smoothed to rise steadily upstream (east). */
  channel: Float32Array;
  /** Column of the stream gauge the water level is measured at. */
  gaugeCol: number;
}

export function buildFloodGrid(elevation: ElevationGrid, bounds: Bounds, gaugeLon: number): FloodGrid {
  const midLat = (bounds.north + bounds.south) / 2;
  const dLat = CELL_METERS / 111_320;
  const dLon = CELL_METERS / (111_320 * Math.cos((midLat * Math.PI) / 180));
  const cols = Math.floor((bounds.east - bounds.west) / dLon);
  const rows = Math.floor((bounds.north - bounds.south) / dLat);
  const ground = new Float32Array(cols * rows);
  const seeds: number[] = [];
  const lowestByCol: number[] = [];

  for (let c = 0; c < cols; c++) {
    let lowest = Infinity;
    let lowestRow = -1;
    for (let r = 0; r < rows; r++) {
      const lon = bounds.west + (c + 0.5) * dLon;
      const lat = bounds.north - (r + 0.5) * dLat;
      const g = elevation.sample(lon, lat) ?? NaN;
      ground[r * cols + c] = g;
      if (g < lowest) {
        lowest = g;
        lowestRow = r;
      }
    }
    seeds.push(lowestRow);
    lowestByCol.push(lowest);
  }
  const gaugeCol = Math.min(cols - 1, Math.max(0, Math.floor((gaugeLon - bounds.west) / dLon)));
  return { bounds, cols, rows, dLon, dLat, ground, seeds, channel: risingProfile(lowestByCol), gaugeCol };
}

/**
 * Least-squares fit that never decreases (pool adjacent violators). The lowest cell
 * of each column is noisy — bridges, pits, gaps — but the channel only climbs upstream.
 */
function risingProfile(values: number[]): Float32Array {
  const blocks: { mean: number; count: number }[] = [];
  for (const v of values) {
    blocks.push({ mean: Number.isFinite(v) ? v : (blocks.at(-1)?.mean ?? 0), count: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].mean > blocks[blocks.length - 1].mean) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      blocks.push({ mean: (a.mean * a.count + b.mean * b.count) / (a.count + b.count), count: a.count + b.count });
    }
  }
  const out = new Float32Array(values.length);
  let i = 0;
  for (const b of blocks) out.fill(b.mean, i, (i += b.count));
  return out;
}

/** Water surface elevation in a column, given the water surface at the gauge. */
function columnSurface(grid: FloodGrid, gaugeSurface: number, c: number) {
  return grid.channel[c] + (gaugeSurface - grid.channel[grid.gaugeCol]);
}

/** Water surface elevation at a longitude, given the water surface at the gauge. */
export function waterSurfaceAt(grid: FloodGrid, gaugeSurface: number, lon: number) {
  const c = Math.min(grid.cols - 1, Math.max(0, Math.floor((lon - grid.bounds.west) / grid.dLon)));
  return columnSurface(grid, gaugeSurface, c);
}

/** Depth of water above the river channel, the same everywhere along the valley. */
export function channelDepth(grid: FloodGrid, gaugeSurface: number) {
  return gaugeSurface - grid.channel[grid.gaugeCol];
}

export interface FloodResult {
  /** Water surface at the gauge. */
  waterSurface: number;
  wet: Uint8Array;
  /** Water blocks with a `depth` property in metres. */
  geojson: GeoJSON.FeatureCollection;
}

export function computeFlood(grid: FloodGrid, waterSurface: number): FloodResult {
  const { cols, rows, ground, bounds, dLon, dLat } = grid;
  const surface = Float32Array.from({ length: cols }, (_, c) => columnSurface(grid, waterSurface, c));
  const wet = new Uint8Array(cols * rows);
  const queue: number[] = [];

  grid.seeds.forEach((r, c) => {
    if (r < 0) return;
    const i = r * cols + c;
    if (ground[i] < surface[c]) {
      wet[i] = 1;
      queue.push(i);
    }
  });

  while (queue.length) {
    const i = queue.pop()!;
    const r = Math.floor(i / cols);
    const c = i % cols;
    const neighbours = [
      r > 0 ? i - cols : -1,
      r < rows - 1 ? i + cols : -1,
      c > 0 ? i - 1 : -1,
      c < cols - 1 ? i + 1 : -1,
    ];
    for (const n of neighbours) {
      if (n >= 0 && !wet[n] && ground[n] < surface[n % cols]) {
        wet[n] = 1;
        queue.push(n);
      }
    }
  }

  const features: GeoJSON.Feature[] = [];
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      const i = r * cols + c;
      if (!wet[i]) {
        c++;
        continue;
      }
      const step = Math.round((surface[c] - ground[i]) / DEPTH_STEP);
      let end = c + 1;
      while (
        end < cols &&
        wet[r * cols + end] &&
        Math.round((surface[end] - ground[r * cols + end]) / DEPTH_STEP) === step
      ) {
        end++;
      }
      const west = bounds.west + c * dLon;
      const east = bounds.west + end * dLon;
      const north = bounds.north - r * dLat;
      const south = north - dLat;
      features.push({
        type: "Feature",
        properties: { depth: Math.max(step * DEPTH_STEP, 0.05) },
        geometry: {
          type: "Polygon",
          coordinates: [[[west, north], [east, north], [east, south], [west, south], [west, north]]],
        },
      });
      c = end;
    }
  }
  return { waterSurface, wet, geojson: { type: "FeatureCollection", features } };
}

/**
 * Whether water connected to the river reaches this point. Checks the cell and
 * its neighbours, because the cell under a building footprint is often a
 * little higher than the ground around it.
 */
export function isFlooded(grid: FloodGrid, flood: FloodResult, lon: number, lat: number) {
  const c = Math.floor((lon - grid.bounds.west) / grid.dLon);
  const r = Math.floor((grid.bounds.north - lat) / grid.dLat);
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < grid.rows && cc >= 0 && cc < grid.cols && flood.wet[rr * grid.cols + cc]) return true;
    }
  }
  return false;
}

export interface BuildingWaterReport {
  /** Local water surface elevation, metres NAVD88. */
  waterSurface: number;
  groundElevation: number | null;
  depth: number | null; // metres of water at the building; null when unknown
  buildingHeight: number | null;
  floorsUnderwater: number | null;
  totalFloors: number | null;
  submerged: boolean;
  dryClearance: number | null; // metres of building above the water line
}

export const FLOOR_HEIGHT_M = 3;

export function waterAtBuilding(
  groundElevation: number | null,
  waterSurface: number,
  flooded: boolean,
  buildingHeight: number | null,
): BuildingWaterReport {
  const depth = groundElevation == null ? null : flooded ? Math.max(0, waterSurface - groundElevation) : 0;
  const totalFloors = buildingHeight == null ? null : Math.max(1, Math.round(buildingHeight / FLOOR_HEIGHT_M));
  const floorsUnderwater =
    depth == null || totalFloors == null ? null : Math.min(totalFloors, Math.ceil(depth / FLOOR_HEIGHT_M - 0.01));
  return {
    waterSurface,
    groundElevation,
    depth,
    buildingHeight,
    floorsUnderwater: depth === 0 ? 0 : floorsUnderwater,
    totalFloors,
    submerged: depth != null && buildingHeight != null && depth >= buildingHeight,
    dryClearance: depth == null || buildingHeight == null ? null : Math.max(0, buildingHeight - depth),
  };
}
