// Builds a region's road graph and building mask from OpenFreeMap vector tiles (the same
// OpenStreetMap data the map draws) instead of the Overpass API, which rate-limits heavy use.
// Writes public/data/<region>/roads.json and buildings.json in the same formats as
// fetch-roads.ts and fetch-buildings.ts, and optionally a building list for the scenario
// builder (Overpass "out center tags" shape).
//
//   npm run fetch:tiles -- --region sf-waterfront [--scenario-buildings /tmp/buildings.json]
//
// The tiles carry less than raw OSM: no one-way or bridge flags (every road is two-way and
// at ground level), building types are guessed from height and nearby points of interest,
// and addresses are a house number with the nearest named street. Data © OpenStreetMap contributors.

import { mkdirSync, writeFileSync } from "node:fs";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { CELL_METERS, gridShape } from "../src/lib/flood";
import { regionArg } from "./regionArg";

const region = regionArg();
const B = region.bounds;
const Z = 14;
const TILEJSON = "https://tiles.openfreemap.org/planet";

/** OpenMapTiles road classes the router drives on, as the OSM classes roads.json uses. */
const ROAD_CLASS: Record<string, string> = {
  motorway: "motorway",
  trunk: "trunk",
  primary: "primary",
  secondary: "secondary",
  tertiary: "tertiary",
  minor: "residential",
  service: "service",
};
const CLASSES = [...new Set(Object.values(ROAD_CLASS))];

const lonToX = (lon: number) => ((lon + 180) / 360) * 2 ** Z;
const latToY = (lat: number) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z;

type Ring = number[][];
interface Polygon {
  outer: Ring;
  height: number;
  /** The tile it came from, so a building split across tiles is listed once. */
  tile: [number, number];
}

const template: string = (await (await fetch(TILEJSON)).json()).tiles[0];
const roads: number[][][] = [];
const polygons: Polygon[] = [];
const pois: { lon: number; lat: number; name: string; cls: string }[] = [];
const numbers: { lon: number; lat: number; number: string }[] = [];
const streets: { line: number[][]; name: string }[] = [];

for (let x = Math.floor(lonToX(B.west)); x <= Math.floor(lonToX(B.east)); x++) {
  for (let y = Math.floor(latToY(B.north)); y <= Math.floor(latToY(B.south)); y++) {
    const url = template.replace("{z}", String(Z)).replace("{x}", String(x)).replace("{y}", String(y));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tile ${Z}/${x}/${y} failed: ${res.status}`);
    const tile = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer())));
    const each = (name: string, fn: (f: ReturnType<VectorTile["layers"][string]["feature"]>) => void) => {
      const layer = tile.layers[name];
      for (let i = 0; layer && i < layer.length; i++) fn(layer.feature(i));
    };
    const lines = (g: GeoJSON.Geometry) =>
      g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    each("transportation", (f) => {
      if (!ROAD_CLASS[f.properties.class as string]) return;
      for (const line of lines(f.toGeoJSON(x, y, Z).geometry)) roads.push(line.concat().map((p) => [...p, CLASSES.indexOf(ROAD_CLASS[f.properties.class as string])]));
    });
    each("building", (f) => {
      const g = f.toGeoJSON(x, y, Z).geometry;
      const height = Number(f.properties.render_height) || 0;
      const rings = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      for (const poly of rings) polygons.push({ outer: poly[0], height, tile: [x, y] });
    });
    each("poi", (f) => {
      const g = f.toGeoJSON(x, y, Z).geometry;
      if (g.type === "Point" && f.properties.name) {
        pois.push({ lon: g.coordinates[0], lat: g.coordinates[1], name: String(f.properties.name), cls: String(f.properties.class) });
      }
    });
    each("housenumber", (f) => {
      const g = f.toGeoJSON(x, y, Z).geometry;
      if (g.type === "Point") numbers.push({ lon: g.coordinates[0], lat: g.coordinates[1], number: String(f.properties.housenumber) });
    });
    each("transportation_name", (f) => {
      if (!f.properties.name) return;
      for (const line of lines(f.toGeoJSON(x, y, Z).geometry)) streets.push({ line, name: String(f.properties.name) });
    });
  }
}

// ---- Road graph. Tile geometry is simplified and cut at tile edges, so crossing roads don't
// always share an exact point: snap points within SNAP_M together, then join each dead end to
// a road passing within JOIN_M (a T-junction), and drop repeated edges from tile overlaps.
const SNAP_M = 2.5;
const JOIN_M = 6;
const COS = Math.cos((((B.north + B.south) / 2) * Math.PI) / 180);
const toM = (p: number[]) => [p[0] * 111_320 * COS, p[1] * 111_320];
const inside = (p: number[], margin = 0.002) =>
  p[0] >= B.west - margin && p[0] <= B.east + margin && p[1] >= B.south - margin && p[1] <= B.north + margin;

const nodes: number[] = [];
const cellOf = (m: number[], size: number) => `${Math.floor(m[0] / size)},${Math.floor(m[1] / size)}`;
const snapGrid = new Map<string, number[]>();
const node = (p: number[]) => {
  const m = toM(p);
  const [cx, cy] = [Math.floor(m[0] / SNAP_M), Math.floor(m[1] / SNAP_M)];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const n of snapGrid.get(`${cx + dx},${cy + dy}`) ?? []) {
        const q = toM([nodes[2 * n], nodes[2 * n + 1]]);
        if (Math.hypot(q[0] - m[0], q[1] - m[1]) <= SNAP_M) return n;
      }
    }
  }
  const n = nodes.length / 2;
  nodes.push(Number(p[0].toFixed(6)), Number(p[1].toFixed(6)));
  const k = `${cx},${cy}`;
  snapGrid.set(k, [...(snapGrid.get(k) ?? []), n]);
  return n;
};
let edges: [number, number, number, number][] = [];
for (const line of roads) {
  for (let i = 1; i < line.length; i++) {
    if (!inside(line[i - 1]) || !inside(line[i])) continue;
    edges.push([node(line[i - 1]), node(line[i]), line[i][2], 0]);
  }
}
const dedupe = () => {
  const seen = new Set<string>();
  edges = edges.filter(([a, b]) => {
    const id = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (a === b || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};
dedupe();

// T-junctions: a dead end within JOIN_M of another road's segment is split into it.
const nodeM = (n: number) => toM([nodes[2 * n], nodes[2 * n + 1]]);
const degree = new Map<number, number>();
for (const [a, b] of edges) {
  degree.set(a, (degree.get(a) ?? 0) + 1);
  degree.set(b, (degree.get(b) ?? 0) + 1);
}
const SEG_CELL = 25;
const segGrid = new Map<string, number[]>();
edges.forEach(([a, b], e) => {
  const [p, q] = [nodeM(a), nodeM(b)];
  const cells = new Set([cellOf(p, SEG_CELL), cellOf(q, SEG_CELL), cellOf([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], SEG_CELL)]);
  for (const k of cells) segGrid.set(k, [...(segGrid.get(k) ?? []), e]);
});
const splits = new Map<number, { t: number; n: number }[]>();
let joined = 0;
for (const [n, d] of degree) {
  if (d !== 1) continue;
  const m = nodeM(n);
  const [cx, cy] = [Math.floor(m[0] / SEG_CELL), Math.floor(m[1] / SEG_CELL)];
  let best: { e: number; t: number; d: number } | null = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const e of segGrid.get(`${cx + dx},${cy + dy}`) ?? []) {
        const [a, b] = edges[e];
        if (a === n || b === n) continue;
        const [p, q] = [nodeM(a), nodeM(b)];
        const len2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
        const t = len2 ? Math.max(0, Math.min(1, ((m[0] - p[0]) * (q[0] - p[0]) + (m[1] - p[1]) * (q[1] - p[1])) / len2)) : 0;
        const dist = Math.hypot(p[0] + t * (q[0] - p[0]) - m[0], p[1] + t * (q[1] - p[1]) - m[1]);
        if (dist <= JOIN_M && (!best || dist < best.d)) best = { e, t, d: dist };
      }
    }
  }
  if (!best) continue;
  joined++;
  splits.set(best.e, [...(splits.get(best.e) ?? []), { t: best.t, n }]);
}
const split: typeof edges = [];
edges.forEach(([a, b, cls, flags], e) => {
  const cuts = (splits.get(e) ?? []).sort((x, y) => x.t - y.t);
  let from = a;
  for (const { n } of cuts) {
    split.push([from, n, cls, flags]);
    from = n;
  }
  split.push([from, b, cls, flags]);
});
edges = split;
dedupe();
console.log(`joined ${joined} dead ends to passing roads`);

mkdirSync(new URL(`../public/data/${region.id}/`, import.meta.url), { recursive: true });
writeFileSync(
  new URL(`../public/data/${region.id}/roads.json`, import.meta.url),
  JSON.stringify({ source: "© OpenStreetMap contributors (ODbL), via OpenFreeMap", bounds: B, classes: CLASSES, nodes, edges }),
);
console.log(`roads: ${nodes.length / 2} nodes, ${edges.length} edges`);

// ---- Building mask: same rasterisation as fetch-buildings.ts.
const STOREY_M = 3;
const DEFAULT_HEIGHT_M = 5;
const MIN_SAMPLES = 4;
const { dLat, dLon, cols, rows } = gridShape(B);
const heights = new Float32Array(cols * rows);
// Which of each cell's 3×3 sample points fall in any building, so a row of narrow houses
// sharing walls (or a building split across tiles) fills its cells.
const covered = new Uint16Array(cols * rows);
const SAMPLE = [0.2, 0.5, 0.8];
const bitCount = (n: number) => {
  let count = 0;
  for (; n; n &= n - 1) count++;
  return count;
};
const within = (lon: number, lat: number, ring: Ring) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[j];
    if (ay > lat !== by > lat && lon < ((bx - ax) * (lat - ay)) / (by - ay) + ax) hit = !hit;
  }
  return hit;
};
for (const p of polygons) {
  const h = p.height > 0 ? p.height : DEFAULT_HEIGHT_M;
  const lons = p.outer.map((q) => q[0]);
  const lats = p.outer.map((q) => q[1]);
  const c0 = Math.max(0, Math.floor((Math.min(...lons) - B.west) / dLon));
  const c1 = Math.min(cols - 1, Math.floor((Math.max(...lons) - B.west) / dLon));
  const r0 = Math.max(0, Math.floor((B.north - Math.max(...lats)) / dLat));
  const r1 = Math.min(rows - 1, Math.floor((B.north - Math.min(...lats)) / dLat));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      let hits = 0;
      for (let k = 0; k < 9; k++) {
        if (within(B.west + (c + SAMPLE[k % 3]) * dLon, B.north - (r + SAMPLE[Math.floor(k / 3)]) * dLat, p.outer)) hits |= 1 << k;
      }
      if (!hits) continue;
      covered[r * cols + c] |= hits;
      heights[r * cols + c] = Math.max(heights[r * cols + c], h);
    }
  }
}
for (let i = 0; i < heights.length; i++) if (bitCount(covered[i]) < MIN_SAMPLES) heights[i] = 0;
const runs: number[][] = [];
for (let i = 0; i < heights.length; ) {
  if (!heights[i]) {
    i++;
    continue;
  }
  let j = i + 1;
  while (j < heights.length && heights[j] === heights[i]) j++;
  runs.push([i, j - i, Math.round(heights[i] * 10)]);
  i = j;
}
writeFileSync(
  new URL(`../public/data/${region.id}/buildings.json`, import.meta.url),
  JSON.stringify({ source: "© OpenStreetMap contributors (ODbL), via OpenFreeMap", bounds: B, cellMeters: CELL_METERS, cols, rows, runs }),
);
console.log(`buildings: ${polygons.length} footprints → ${runs.reduce((n, [, len]) => n + len, 0)} cells`);

// ---- Building list for the scenario builder.
const at = process.argv.indexOf("--scenario-buildings");
if (at > 0) {
  const metres = (a: number[], b: number[]) =>
    Math.hypot((a[0] - b[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 111_320);
  const nearestStreet = (p: number[]) => {
    let best: string | null = null;
    let bestM = 60;
    for (const s of streets) for (const q of s.line) if (metres(p, q) < bestM) [best, bestM] = [s.name, metres(p, q)];
    return best;
  };
  const elements = polygons.flatMap((p, n) => {
    const lon = p.outer.reduce((s, q) => s + q[0], 0) / p.outer.length;
    const lat = p.outer.reduce((s, q) => s + q[1], 0) / p.outer.length;
    // Listed once, by the tile its centre falls in.
    if (Math.floor(lonToX(lon)) !== p.tile[0] || Math.floor(latToY(lat)) !== p.tile[1] || !inside([lon, lat], 0)) return [];
    const poi = pois.find((q) => within(q.lon, q.lat, p.outer));
    const number = numbers.find((q) => within(q.lon, q.lat, p.outer));
    const street = number ? nearestStreet([number.lon, number.lat]) : null;
    const tags: Record<string, string> = {
      building: poi?.cls === "lodging" ? "hotel" : p.height >= 9 && !poi ? "apartments" : "yes",
    };
    if (poi) tags.name = poi.name;
    if (number && street) Object.assign(tags, { "addr:housenumber": number.number, "addr:street": street });
    if (p.height > 0) tags["building:levels"] = String(Math.max(1, Math.round(p.height / STOREY_M)));
    return [{ type: "way", id: n, center: { lon, lat }, tags }];
  });
  writeFileSync(process.argv[at + 1], JSON.stringify({ elements }));
  console.log(`scenario buildings: ${elements.length} (${elements.filter((e) => e.tags.name).length} named)`);
}
