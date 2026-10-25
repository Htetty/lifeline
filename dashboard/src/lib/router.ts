import { CELL_METERS, depthAt, type FloodGrid, type FloodResult } from "./flood";
import type { RegionId } from "../../convex/regions";
import type { RescueTeam } from "./types";
import { tripProgress, type LegMode, type Trip, type TripLeg } from "../../convex/tripMath";
import { moverFor, PROFILES, type Mover, type Profile } from "../../convex/vehicles";

// Flood-aware routing for the simulated rescue teams, on OpenStreetMap roads
// (public/data/<region>/roads.json, from scripts/fetch-roads.ts) and the flood grid.
//
// Deterministic: the same roads, water level and start point always give the same
// route. It is a shortest-time search (Dijkstra) and ties go to the lower node number.
// Depth limits and speeds are rough planning figures, not vehicle specifications.

const DRY_DEPTH = 0.05;
/** Water a boat needs to run under power. */
const BOAT_MIN_DEPTH = 0.5;
const BOAT_SPEED = 6;
/** Backing the trailer in and launching. */
const LAUNCH_SECONDS = 120;
const AIR_SPEED = 50;
/** Crews walk or wade the last stretch from the vehicle to the building. */
const FOOT_RADIUS_M = 150;
const FOOT_SPEED = 1.2;
const WADE_SPEED = 0.5;
const WADE_DEPTH = 0.3;
const FOOT_LIMIT = 1.2;
/** A boat can pull up to a building this close to deep water. */
const BOAT_REACH_M = 45;
/** Largest building (in grid cells) searched for a place to pull up alongside it. */
const MAX_BUILDING_CELLS = 2000;
/** A towed boat can be launched into deep water this close to the road it is on. */
const LAUNCH_REACH_M = 30;
/** Leaving the station to the nearest roads. */
const START_RADIUS_M = 250;
const START_LINKS = 4;
const START_SPEED = 4;
/** Depth samples along each road segment. */
const SAMPLE_STEP_M = 10;
/** Building checks along a straight (off-road) leg: a third of a grid cell. */
const STRAIGHT_STEP_M = 5;

/** Free-flow speeds in m/s by OSM road class. */
const CLASS_SPEED: Record<string, number> = {
  motorway: 27,
  motorway_link: 15,
  trunk: 22,
  trunk_link: 13,
  primary: 16,
  primary_link: 12,
  secondary: 14,
  secondary_link: 11,
  tertiary: 12,
  tertiary_link: 10,
  unclassified: 10,
  residential: 9,
  living_street: 5,
  service: 5,
};

export { moverFor, PROFILES, type Mover } from "../../convex/vehicles";

const ONEWAY = 1;
const BRIDGE = 2;

export interface RoadGraph {
  count: number;
  lon: Float64Array;
  lat: Float64Array;
  adjStart: Int32Array;
  adjTo: Int32Array;
  adjEdge: Int32Array;
  edgeA: Int32Array;
  edgeB: Int32Array;
  edgeLen: Float32Array;
  edgeSpeed: Float32Array;
  edgeBridge: Uint8Array;
  /** Nodes on a bridge, as "lon,lat", so stored paths can skip them when checking depth. */
  bridgeNodes: Set<string>;
  cosLat: number;
}

export interface RoadFile {
  bounds: { south: number; north: number };
  classes: string[];
  nodes: number[];
  edges: [number, number, number, number][];
}

export async function loadRoads(region: RegionId): Promise<RoadGraph> {
  const res = await fetch(`/data/${region}/roads.json`);
  if (!res.ok) throw new Error(`Road data failed: ${res.status}`);
  return buildGraph((await res.json()) as RoadFile);
}

export function buildGraph(file: RoadFile): RoadGraph {
  const count = file.nodes.length / 2;
  const lon = new Float64Array(count);
  const lat = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    lon[i] = file.nodes[2 * i];
    lat[i] = file.nodes[2 * i + 1];
  }
  const cosLat = Math.cos((((file.bounds.south + file.bounds.north) / 2) * Math.PI) / 180);
  const m = file.edges.length;
  const edgeA = new Int32Array(m);
  const edgeB = new Int32Array(m);
  const edgeLen = new Float32Array(m);
  const edgeSpeed = new Float32Array(m);
  const edgeBridge = new Uint8Array(m);
  const bridgeNodes = new Set<string>();
  const degree = new Int32Array(count + 1);
  file.edges.forEach(([a, b, cls, flags], e) => {
    edgeA[e] = a;
    edgeB[e] = b;
    edgeLen[e] = planar(lon[a], lat[a], lon[b], lat[b], cosLat);
    edgeSpeed[e] = CLASS_SPEED[file.classes[cls]] ?? 8;
    if (flags & BRIDGE) {
      edgeBridge[e] = 1;
      bridgeNodes.add(`${lon[a]},${lat[a]}`);
      bridgeNodes.add(`${lon[b]},${lat[b]}`);
    }
    degree[a]++;
    if (!(flags & ONEWAY)) degree[b]++;
  });
  const adjStart = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) adjStart[i + 1] = adjStart[i] + degree[i];
  const fill = adjStart.slice(0, count);
  const adjTo = new Int32Array(adjStart[count]);
  const adjEdge = new Int32Array(adjStart[count]);
  file.edges.forEach(([a, b, , flags], e) => {
    adjTo[fill[a]] = b;
    adjEdge[fill[a]++] = e;
    if (!(flags & ONEWAY)) {
      adjTo[fill[b]] = a;
      adjEdge[fill[b]++] = e;
    }
  });
  return { count, lon, lat, adjStart, adjTo, adjEdge, edgeA, edgeB, edgeLen, edgeSpeed, edgeBridge, bridgeNodes, cosLat };
}

function planar(lon1: number, lat1: number, lon2: number, lat2: number, cosLat: number) {
  const dx = (lon2 - lon1) * 111_320 * cosLat;
  const dy = (lat2 - lat1) * 111_320;
  return Math.hypot(dx, dy);
}

/** Deepest water along a straight segment, sampled every SAMPLE_STEP_M. */
function segmentDepth(grid: FloodGrid, flood: FloodResult, a: number[], b: number[], length: number) {
  const steps = Math.max(1, Math.ceil(length / SAMPLE_STEP_M));
  let deepest = 0;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    deepest = Math.max(deepest, depthAt(grid, flood, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
  }
  return deepest;
}

interface Depths {
  edge: Float32Array;
  node: Float32Array;
}
const depthCache = new WeakMap<FloodResult, WeakMap<RoadGraph, Depths>>();

/** Water depth on every road segment and junction for one flood state (cached). */
function roadDepths(graph: RoadGraph, grid: FloodGrid, flood: FloodResult): Depths {
  let byGraph = depthCache.get(flood);
  if (!byGraph) depthCache.set(flood, (byGraph = new WeakMap()));
  const cached = byGraph.get(graph);
  if (cached) return cached;
  const node = new Float32Array(graph.count);
  for (let i = 0; i < graph.count; i++) node[i] = depthAt(grid, flood, graph.lon[i], graph.lat[i]);
  const edge = new Float32Array(graph.edgeA.length);
  for (let e = 0; e < edge.length; e++) {
    if (graph.edgeBridge[e]) continue; // Bridge decks sit above the bare-earth ground.
    const a = graph.edgeA[e];
    const b = graph.edgeB[e];
    edge[e] = segmentDepth(grid, flood, [graph.lon[a], graph.lat[a]], [graph.lon[b], graph.lat[b]], graph.edgeLen[e]);
  }
  const result = { edge, node };
  byGraph.set(graph, result);
  return result;
}

function roadSpeed(base: number, depth: number, p: Profile): number | null {
  if (depth > p.limit) return null;
  if (depth <= DRY_DEPTH) return base;
  return Math.min(base, p.wadingSpeed) * (1 - 0.6 * (depth / p.limit));
}

/** Min-heap of (cost, node); equal costs pop the lower node first. */
class Heap {
  private cost: number[] = [];
  private node: number[] = [];
  get size() {
    return this.cost.length;
  }
  private less(i: number, j: number) {
    return this.cost[i] < this.cost[j] || (this.cost[i] === this.cost[j] && this.node[i] < this.node[j]);
  }
  private swap(i: number, j: number) {
    [this.cost[i], this.cost[j]] = [this.cost[j], this.cost[i]];
    [this.node[i], this.node[j]] = [this.node[j], this.node[i]];
  }
  push(cost: number, node: number) {
    this.cost.push(cost);
    this.node.push(node);
    for (let i = this.cost.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.cost[0], this.node[0]];
    const last = this.cost.length - 1;
    this.swap(0, last);
    this.cost.pop();
    this.node.pop();
    for (let i = 0; ; ) {
      const l = 2 * i + 1;
      const r = l + 1;
      let best = i;
      if (l < this.cost.length && this.less(l, best)) best = l;
      if (r < this.cost.length && this.less(r, best)) best = r;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
    return top;
  }
}

export interface RoutePlan {
  ok: true;
  mover: Mover;
  path: number[][];
  legs: TripLeg[];
  realSeconds: number;
  /** Deepest water the vehicle drives through, metres (0 for air and water legs). */
  maxDepth: number;
  /** The vehicle's depth limit, or null for air. */
  limit: number | null;
  metres: Record<LegMode, number>;
}

export interface NoRoute {
  ok: false;
  mover: Mover;
  reason: string;
}

/** Route colours by how each stretch is travelled, chosen to stand out from orange roads and blue water. */
export const ROUTE_COLOR: Record<LegMode, string> = {
  road: "#7c3aed",
  water: "#facc15",
  foot: "#0f172a",
  air: "#7c3aed",
};

const MODES: LegMode[] = ["road", "water", "foot", "air"];

/**
 * Fastest route for a team to a point, given the current flood. Road vehicles stay on
 * roads below their depth limit; boats are towed on roads until they reach water deep
 * enough to launch, then cross flooded ground. The crew covers the last stretch on foot.
 */
export function planRoute(
  graph: RoadGraph,
  grid: FloodGrid,
  flood: FloodResult,
  team: Pick<RescueTeam, "longitude" | "latitude" | "capabilities">,
  to: { longitude: number; latitude: number },
): RoutePlan | NoRoute {
  const mover = moverFor(team.capabilities);
  const from = [team.longitude, team.latitude];
  const target = [to.longitude, to.latitude];
  const zero = () => Object.fromEntries(MODES.map((m) => [m, 0])) as Record<LegMode, number>;

  if (mover === "air") {
    const d = planar(from[0], from[1], target[0], target[1], graph.cosLat);
    return {
      ok: true,
      mover,
      path: [from, target],
      legs: [{ mode: "air", end: 1 }],
      realSeconds: d / AIR_SPEED,
      maxDepth: 0,
      limit: null,
      metres: { ...zero(), air: d },
    };
  }

  const profile = PROFILES[mover];
  const isBoat = mover === "boat";
  const depths = roadDepths(graph, grid, flood);
  const N = graph.count;
  const cells = isBoat ? grid.cols * grid.rows : 0;
  const START = N + cells;
  const TARGET = START + 1;
  const total = TARGET + 1;

  const cellDepth = (c: number) => flood.depth[c];
  /** A building the water doesn't top: boats go around it. */
  const blocked = (c: number) => (grid.buildings?.[c] ?? 0) > cellDepth(c);
  const cellCenter = (c: number) => [
    grid.bounds.west + ((c % grid.cols) + 0.5) * grid.dLon,
    grid.bounds.north - (Math.floor(c / grid.cols) + 0.5) * grid.dLat,
  ];
  const cellOf = (lon: number, lat: number) => {
    const c = Math.floor((lon - grid.bounds.west) / grid.dLon);
    const r = Math.floor((grid.bounds.north - lat) / grid.dLat);
    return r < 0 || r >= grid.rows || c < 0 || c >= grid.cols ? -1 : r * grid.cols + c;
  };
  const deepCellsNear = (p: number[], radius: number) => {
    const out: [number, number][] = [];
    const center = cellOf(p[0], p[1]);
    if (center < 0) return out;
    const reach = Math.ceil(radius / CELL_METERS);
    const r0 = Math.floor(center / grid.cols);
    const c0 = center % grid.cols;
    for (let r = Math.max(0, r0 - reach); r <= Math.min(grid.rows - 1, r0 + reach); r++) {
      for (let c = Math.max(0, c0 - reach); c <= Math.min(grid.cols - 1, c0 + reach); c++) {
        const cell = r * grid.cols + c;
        if (cellDepth(cell) < BOAT_MIN_DEPTH || blocked(cell)) continue;
        const [x, y] = cellCenter(cell);
        const d = planar(p[0], p[1], x, y, graph.cosLat);
        if (d <= radius) out.push([cell, d]);
      }
    }
    return out;
  };
  /**
   * The building that covers `start` (searched up to a size cap): its cells, and the deep,
   * open-water cells touching it.
   */
  const buildingAt = (start: number) => {
    const seen = new Set([start]);
    const queue = [start];
    const edge = new Set<number>();
    while (queue.length && seen.size < MAX_BUILDING_CELLS) {
      const cell = queue.pop()!;
      const r = Math.floor(cell / grid.cols);
      const c = cell % grid.cols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if ((!dr && !dc) || rr < 0 || rr >= grid.rows || cc < 0 || cc >= grid.cols) continue;
          const next = rr * grid.cols + cc;
          if (blocked(next)) {
            if (!dr || !dc) {
              if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
              }
            }
          } else if (cellDepth(next) >= BOAT_MIN_DEPTH) edge.add(next);
        }
      }
    }
    return { cells: seen, edge };
  };
  const roadsNear = (p: number[], radius: number) => {
    const out: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const d = planar(p[0], p[1], graph.lon[i], graph.lat[i], graph.cosLat);
      if (d <= radius) out.push([i, d]);
    }
    return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  };

  // The last stretch: on foot from nearby roads, or by boat from nearby deep water.
  const targetDepth = depthAt(grid, flood, target[0], target[1]);
  const targetCell = cellOf(target[0], target[1]);
  const inBuilding = targetCell >= 0 && blocked(targetCell);
  const targetBuilding = inBuilding ? buildingAt(targetCell) : null;
  /** Whether a straight leg stays clear of buildings the water doesn't top (other than the one it ends in). */
  const clear = (a: number[], b: number[], length: number) => {
    const from = cellOf(a[0], a[1]);
    const steps = Math.max(1, Math.ceil(length / STRAIGHT_STEP_M));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const cell = cellOf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      if (cell >= 0 && cell !== from && blocked(cell) && !targetBuilding?.cells.has(cell)) return false;
    }
    return true;
  };
  // Time to walk or wade straight to the building, or null if the water on the way is too deep
  // or a building is in the way.
  const walk = (p: number[], d: number) => {
    if (!clear(p, target, d)) return null;
    const deepest = segmentDepth(grid, flood, p, target, d);
    return deepest > FOOT_LIMIT ? null : d / (deepest > WADE_DEPTH ? WADE_SPEED : FOOT_SPEED);
  };
  const footLinks = new Map<number, number>();
  for (const [n, d] of roadsNear(target, FOOT_RADIUS_M)) {
    const t = walk([graph.lon[n], graph.lat[n]], d);
    if (t != null) footLinks.set(n, t);
  }
  // A boat pulls up to the building, or lands nearby and the crew wades the rest.
  const boatLinks = new Map<number, [number, LegMode]>();
  if (isBoat) {
    for (const [cell, d] of deepCellsNear(target, FOOT_RADIUS_M)) {
      const t = walk(cellCenter(cell), d);
      if (t != null) boatLinks.set(N + cell, [t, "foot"]);
    }
  }
  if (isBoat && !inBuilding) {
    for (const [cell, d] of deepCellsNear(target, BOAT_REACH_M)) {
      if (clear(cellCenter(cell), target, d)) boatLinks.set(N + cell, [d / BOAT_SPEED, "water"]);
    }
  }
  // In a building the water doesn't top, a boat pulls up anywhere along its walls, however big
  // it is, and the crew goes in on foot from there.
  if (targetBuilding && isBoat) {
    for (const cell of targetBuilding.edge) {
      const [x, y] = cellCenter(cell);
      const t = planar(x, y, target[0], target[1], graph.cosLat) / FOOT_SPEED;
      const known = boatLinks.get(N + cell);
      if (!known || t < known[0]) boatLinks.set(N + cell, [t, "foot"]);
    }
  }

  const wetEdgeAt = (u: number) => {
    for (let k = graph.adjStart[u]; k < graph.adjStart[u + 1]; k++) if (depths.edge[graph.adjEdge[k]] > DRY_DEPTH) return true;
    return false;
  };

  const dist = new Float64Array(total).fill(Infinity);
  const prev = new Int32Array(total).fill(-1);
  const prevMode = new Uint8Array(total); // index into MODES
  const prevEdge = new Int32Array(total).fill(-1);
  const heap = new Heap();
  const relax = (from: number, to: number, cost: number, mode: LegMode, edge = -1) => {
    const next = dist[from] + cost;
    if (next < dist[to]) {
      dist[to] = next;
      prev[to] = from;
      prevMode[to] = MODES.indexOf(mode);
      prevEdge[to] = edge;
      heap.push(next, to);
    }
  };

  dist[START] = 0;
  heap.push(0, START);
  while (heap.size) {
    const [cost, u] = heap.pop();
    if (cost > dist[u]) continue;
    if (u === TARGET) break;

    if (u === START) {
      for (const [n, d] of roadsNear(from, START_RADIUS_M).slice(0, START_LINKS)) relax(u, n, d / START_SPEED, "road");
      if (isBoat) for (const [cell, d] of deepCellsNear(from, BOAT_REACH_M)) relax(u, N + cell, LAUNCH_SECONDS + d / BOAT_SPEED, "water");
    } else if (u < N) {
      for (let k = graph.adjStart[u]; k < graph.adjStart[u + 1]; k++) {
        const e = graph.adjEdge[k];
        const speed = roadSpeed(graph.edgeSpeed[e], depths.edge[e], profile);
        if (speed != null) relax(u, graph.adjTo[k], graph.edgeLen[e] / speed, "road", e);
      }
      // Launch where the road runs into water. Only checked near wet roads, to keep it cheap.
      if (isBoat && (depths.node[u] > DRY_DEPTH || wetEdgeAt(u))) {
        const at = [graph.lon[u], graph.lat[u]];
        for (const [cell, d] of deepCellsNear(at, LAUNCH_REACH_M)) {
          if (clear(at, cellCenter(cell), d)) relax(u, N + cell, LAUNCH_SECONDS + d / BOAT_SPEED, "water");
        }
      }
      const foot = footLinks.get(u);
      if (foot != null) relax(u, TARGET, foot, "foot");
    } else {
      const cell = u - N;
      const r = Math.floor(cell / grid.cols);
      const c = cell % grid.cols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= grid.rows || cc < 0 || cc >= grid.cols) continue;
          const next = rr * grid.cols + cc;
          if (cellDepth(next) < BOAT_MIN_DEPTH || blocked(next)) continue;
          // No cutting a building's corner on a diagonal.
          if (dr && dc && (blocked(r * grid.cols + cc) || blocked(rr * grid.cols + c))) continue;
          relax(u, N + next, (dr && dc ? Math.SQRT2 : 1) * (CELL_METERS / BOAT_SPEED), "water");
        }
      }
      const pull = boatLinks.get(u);
      if (pull) relax(u, TARGET, pull[0], pull[1]);
    }
  }

  if (!Number.isFinite(dist[TARGET])) {
    const why =
      targetDepth > FOOT_LIMIT && !isBoat
        ? `${targetDepth.toFixed(1)} m of water at the building, too deep to wade in from a ${profile.label}`
        : isBoat
          ? "no road in is shallow enough to tow to, and no deep water connects to the building"
          : `every way in crosses water deeper than a ${profile.label} can handle (${profile.limit} m)`;
    return { ok: false, mover, reason: why };
  }

  const nodes: number[] = [];
  for (let n = TARGET; n !== -1; n = prev[n]) nodes.push(n);
  nodes.reverse();
  const point = (n: number) =>
    n === START ? from : n === TARGET ? target : n < N ? [graph.lon[n], graph.lat[n]] : cellCenter(n - N);
  const path = nodes.map(point);
  const legs: TripLeg[] = [];
  const metres = zero();
  let maxDepth = 0;
  for (let i = 1; i < nodes.length; i++) {
    const mode = MODES[prevMode[nodes[i]]];
    metres[mode] += planar(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1], graph.cosLat);
    if (prevEdge[nodes[i]] >= 0) maxDepth = Math.max(maxDepth, depths.edge[prevEdge[nodes[i]]]);
    if (legs.length && legs[legs.length - 1].mode === mode) legs[legs.length - 1].end = i;
    else legs.push({ mode, end: i });
  }
  return { ok: true, mover, path, legs, realSeconds: dist[TARGET], maxDepth, limit: profile.limit, metres };
}

/**
 * Deepest water on the road legs still ahead of a moving team, with bridges skipped.
 * Compare with the vehicle's limit to see whether rising water has cut the route.
 */
export function deepestAhead(graph: RoadGraph, grid: FloodGrid, flood: FloodResult, trip: Trip, now: number) {
  const { remaining, next } = tripProgress(trip, now);
  const legs = trip.legs ?? [{ mode: trip.route === "direct" ? "air" : "road", end: trip.path.length - 1 }];
  let deepest = 0;
  for (let k = 1; k < remaining.length; k++) {
    const index = next + k - 1; // path index of remaining[k]
    const leg = legs.find((l) => index <= l.end);
    if (leg?.mode !== "road") continue;
    const a = remaining[k - 1];
    const b = remaining[k];
    if (graph.bridgeNodes.has(`${a[0]},${a[1]}`) && graph.bridgeNodes.has(`${b[0]},${b[1]}`)) continue;
    deepest = Math.max(deepest, segmentDepth(grid, flood, a, b, planar(a[0], a[1], b[0], b[1], graph.cosLat)));
  }
  return deepest;
}

const routeCache = new WeakMap<FloodResult, Map<string, RoutePlan | NoRoute>>();

/**
 * planRoute, remembered per flood state: the same flood, team type, start and end always give
 * the same route, and the assignment planner asks for every pair again every few seconds.
 */
export function cachedRoute(
  graph: RoadGraph,
  grid: FloodGrid,
  flood: FloodResult,
  team: Pick<RescueTeam, "longitude" | "latitude" | "capabilities">,
  to: { longitude: number; latitude: number },
): RoutePlan | NoRoute {
  let routes = routeCache.get(flood);
  if (!routes) routeCache.set(flood, (routes = new Map()));
  const key = `${moverFor(team.capabilities)}|${team.longitude},${team.latitude}|${to.longitude},${to.latitude}`;
  let route = routes.get(key);
  if (!route) routes.set(key, (route = planRoute(graph, grid, flood, team, to)));
  return route;
}
