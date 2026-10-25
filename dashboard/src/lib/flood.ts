import type { Bounds, ElevationGrid } from "./elevation";

// Simplified flood: the water surface is set by the river gauge and runs parallel
// to the river channel (same depth above the channel along the valley). Callers'
// reports of how deep the water is raise or lower that surface around them. Water
// fills every cell lower than the surface AND connected to the channel or to a
// caller's report. It ignores flow, levees, drainage and backwater, so it is an
// approximation, not a hydraulic model.

export const CELL_METERS = 15;
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

/** A caller's report of the water where they are. */
export interface WaterObservation {
  lon: number;
  lat: number;
  /** The caller's water surface: ground + floor + depth, metres NAVD88. */
  surface: number;
  /** That surface minus the river model's surface when they said it, metres. */
  offset: number;
  /** How much a report of shallower water lowers the model: 1 for a confirmed location, less otherwise. */
  weight: number;
}

/** A report sets the water within this distance and fades out by twice it. */
export const OBSERVATION_RADIUS_M = 250;
/** Pulls a lowering correction towards zero where reports are faint (far away or unconfirmed). */
const OBSERVATION_PRIOR = 0.05;
const MIN_DEPTH = 0.02;

/**
 * Lowering from reports of shallower water than the model: a Gaussian-weighted
 * average of their offsets. Near a confirmed report it is almost that report's offset.
 */
function loweringField(grid: FloodGrid, observations: WaterObservation[]): Float32Array {
  const { cols, rows, bounds, dLon, dLat } = grid;
  const num = new Float32Array(cols * rows);
  const den = new Float32Array(cols * rows);
  const reach = Math.ceil((3 * OBSERVATION_RADIUS_M) / CELL_METERS);
  for (const o of observations) {
    const c0 = Math.floor((o.lon - bounds.west) / dLon);
    const r0 = Math.floor((bounds.north - o.lat) / dLat);
    for (let r = Math.max(0, r0 - reach); r <= Math.min(rows - 1, r0 + reach); r++) {
      for (let c = Math.max(0, c0 - reach); c <= Math.min(cols - 1, c0 + reach); c++) {
        const d = Math.hypot(r - r0, c - c0) * CELL_METERS;
        const w = o.weight * Math.exp(-((d / OBSERVATION_RADIUS_M) ** 2));
        num[r * cols + c] += w * o.offset;
        den[r * cols + c] += w;
      }
    }
  }
  for (let i = 0; i < num.length; i++) num[i] = den[i] > 0 ? num[i] / (den[i] + OBSERVATION_PRIOR) : 0;
  return num;
}

/**
 * Water around a caller: ground connected to them and below their water level gets up
 * to the depth they reported (water spreading over the land, not a valley-wide level),
 * in full within OBSERVATION_RADIUS_M and fading to nothing by twice that. It never
 * raises the river; where both apply the deeper water counts.
 */
function addReportedWater(grid: FloodGrid, depth: Float32Array, wet: Uint8Array, o: WaterObservation, surface: number) {
  const { cols, rows, ground, bounds, dLon, dLat } = grid;
  const c0 = Math.floor((o.lon - bounds.west) / dLon);
  const r0 = Math.floor((bounds.north - o.lat) / dLat);
  if (r0 < 0 || r0 >= rows || c0 < 0 || c0 >= cols) return;
  const cap = o.surface - ground[r0 * cols + c0];
  const seen = new Uint8Array(cols * rows);
  const queue = [r0 * cols + c0];
  seen[queue[0]] = 1;
  while (queue.length) {
    const i = queue.pop()!;
    const r = Math.floor(i / cols);
    const c = i % cols;
    const d = Math.hypot(r - r0, c - c0) * CELL_METERS;
    const fade = d <= OBSERVATION_RADIUS_M ? 1 : Math.max(0, 2 - d / OBSERVATION_RADIUS_M);
    const here = Math.min(surface - ground[i], cap) * fade;
    if (here > MIN_DEPTH) {
      depth[i] = Math.max(depth[i], here);
      wet[i] = 1;
    }
    const neighbours = [r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1, c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1];
    for (const n of neighbours) {
      if (n < 0 || seen[n] || !(ground[n] < surface)) continue;
      if (Math.hypot(Math.floor(n / cols) - r0, (n % cols) - c0) * CELL_METERS >= 2 * OBSERVATION_RADIUS_M) continue;
      seen[n] = 1;
      queue.push(n);
    }
  }
}

/**
 * Where a caller's water surface sits relative to the river model when they reported
 * it, given their ground, floor and depth. Null outside the grid.
 */
export function observationAt(
  grid: FloodGrid,
  report: { meters: number; floor: number | null; gaugeSurface: number },
  lon: number,
  lat: number,
  floorHeight: number,
  /** Ground elevation at the exact point, when known; otherwise the cell's. */
  groundHere: number | null = null,
) {
  const i = cellAt(grid, lon, lat);
  if (i < 0 || Number.isNaN(grid.ground[i])) return null;
  const surface = (groundHere ?? grid.ground[i]) + (report.floor ?? 0) * floorHeight + report.meters;
  return { surface, offset: surface - columnSurface(grid, report.gaugeSurface, i % grid.cols) };
}

export interface FloodResult {
  /** Water surface at the gauge. */
  waterSurface: number;
  /** Lowering of the river model from callers' reports, or null when there is none. */
  delta: Float32Array | null;
  wet: Uint8Array;
  /** Water depth per cell, metres (0 where dry). */
  depth: Float32Array;
  /** Water blocks with a `depth` property in metres. */
  geojson: GeoJSON.FeatureCollection;
}

export function computeFlood(grid: FloodGrid, waterSurface: number, observations: WaterObservation[] = []): FloodResult {
  const { cols, rows, ground, bounds, dLon, dLat } = grid;
  const column = Float32Array.from({ length: cols }, (_, c) => columnSurface(grid, waterSurface, c));
  const lower = observations.filter((o) => o.offset < 0);
  const delta = lower.length ? loweringField(grid, lower) : null;
  const surface = (i: number) => column[i % cols] + (delta ? delta[i] : 0);
  const wet = new Uint8Array(cols * rows);
  const queue: number[] = [];

  grid.seeds.forEach((r, c) => {
    if (r < 0) return;
    const i = r * cols + c;
    if (ground[i] < surface(i)) {
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
      if (n >= 0 && !wet[n] && ground[n] < surface(n)) {
        wet[n] = 1;
        queue.push(n);
      }
    }
  }

  const depth = new Float32Array(cols * rows);
  for (let i = 0; i < depth.length; i++) if (wet[i]) depth[i] = Math.max(0, surface(i) - ground[i]);
  // Water a caller reports is there even when the model doesn't connect it to the river.
  // If the river has since risen above it, the river is the higher of the two.
  for (const o of observations) {
    if (o.offset <= 0) continue;
    const i = cellAt(grid, o.lon, o.lat);
    if (i >= 0) addReportedWater(grid, depth, wet, o, Math.max(o.surface, surface(i)));
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
      const step = Math.round(depth[i] / DEPTH_STEP);
      let end = c + 1;
      while (end < cols && wet[r * cols + end] && Math.round(depth[r * cols + end] / DEPTH_STEP) === step) {
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
  return { waterSurface, delta, wet, depth, geojson: { type: "FeatureCollection", features } };
}

function cellAt(grid: FloodGrid, lon: number, lat: number) {
  const c = Math.floor((lon - grid.bounds.west) / grid.dLon);
  const r = Math.floor((grid.bounds.north - lat) / grid.dLat);
  return r < 0 || r >= grid.rows || c < 0 || c >= grid.cols ? -1 : r * grid.cols + c;
}

/** Water surface elevation at a point, including callers' reports. */
export function surfaceAtPoint(grid: FloodGrid, flood: FloodResult, lon: number, lat: number) {
  const i = cellAt(grid, lon, lat);
  if (i < 0) return waterSurfaceAt(grid, flood.waterSurface, lon);
  if (flood.wet[i]) return grid.ground[i] + flood.depth[i];
  return columnSurface(grid, flood.waterSurface, i % grid.cols) + (flood.delta ? flood.delta[i] : 0);
}

/** Water depth in the cell containing a point; 0 when dry or outside the grid. */
export function depthAt(grid: FloodGrid, flood: FloodResult, lon: number, lat: number) {
  const i = cellAt(grid, lon, lat);
  return i >= 0 ? flood.depth[i] : 0;
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
  height: number | null,
): BuildingWaterReport {
  // Map tiles report 0 when a building's height isn't known yet.
  const buildingHeight = height != null && height > 0 ? height : null;
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
