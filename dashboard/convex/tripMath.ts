// Simulated responder movement. A trip stores its path and times once; every viewer
// works out where the team is from the clock, so nothing is written while it moves.
// Shared by the Convex functions and the dashboard.

export type LonLat = [number, number];

export type LegMode = "road" | "water" | "foot" | "air";

/** A stretch of the path travelled one way; `end` is the index of its last path point. */
export interface TripLeg {
  mode: LegMode;
  end: number;
}

export interface Trip {
  incidentId: string;
  /** [longitude, latitude] points from the team's start to the incident. */
  path: number[][];
  departAt: number;
  arriveAt: number;
  /**
   * "planned": flood-aware route from the dashboard (src/lib/router.ts).
   * "road": driving route that ignores the flood. "direct": straight line.
   */
  route: "planned" | "road" | "direct";
  legs?: TripLeg[];
  /** Estimated real-world travel time; the simulation plays it TRIP_SPEEDUP times faster. */
  realSeconds: number;
}

export const TRIP_SPEEDUP = 8;
/** Even short trips last long enough to see on the map. */
export const MIN_TRIP_MS = 12_000;

export function metres(a: number[], b: number[]) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function pathLength(path: number[][]) {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += metres(path[i - 1], path[i]);
  return total;
}

/**
 * Where the team is at `now`, and the part of the path still ahead of it.
 * `remaining[k]` for k ≥ 1 is `path[next + k - 1]`.
 */
export function tripProgress(trip: Pick<Trip, "path" | "departAt" | "arriveAt">, now: number) {
  const { path } = trip;
  const fraction = Math.min(1, Math.max(0, (now - trip.departAt) / Math.max(1, trip.arriveAt - trip.departAt)));
  let target = pathLength(path) * fraction;
  for (let i = 1; i < path.length; i++) {
    const leg = metres(path[i - 1], path[i]);
    if (target <= leg || i === path.length - 1) {
      const t = leg === 0 ? 1 : Math.min(1, target / leg);
      const position: LonLat = [
        path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
        path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t,
      ];
      return { position, remaining: [position, ...path.slice(i)] as number[][], next: i, fraction };
    }
    target -= leg;
  }
  const end = path[path.length - 1] as LonLat;
  return { position: end, remaining: [end] as number[][], next: path.length, fraction };
}

/**
 * Where the vehicle itself is at `now`. On a foot leg (the crew walking from the road or the
 * water's edge into the building) the vehicle stays parked where the walk began.
 */
export function vehiclePosition(trip: Pick<Trip, "path" | "departAt" | "arriveAt" | "legs">, now: number): LonLat {
  const { position, next } = tripProgress(trip, now);
  let start = 0;
  for (const leg of trip.legs ?? []) {
    // Segment `next` runs from path[next - 1] to path[next]; it belongs to the leg ending at or after it.
    if (next <= leg.end) return leg.mode === "foot" ? (trip.path[start] as LonLat) : position;
    start = leg.end;
  }
  return position;
}

/**
 * Real-world minutes left, from the trip's travel estimate. Short trips are stretched
 * to MIN_TRIP_MS on screen, so this is not simply the time left on the clock × speed-up.
 */
export function etaMinutes(trip: Pick<Trip, "departAt" | "arriveAt" | "realSeconds">, now: number) {
  const left = 1 - Math.min(1, Math.max(0, (now - trip.departAt) / Math.max(1, trip.arriveAt - trip.departAt)));
  return Math.max(1, Math.ceil((trip.realSeconds * left) / 60));
}

/** The path still ahead, split into legs by how each stretch is travelled. */
export function remainingLegs(trip: Trip, now: number) {
  const { remaining, next } = tripProgress(trip, now);
  const legs = trip.legs ?? [{ mode: "road" as LegMode, end: trip.path.length - 1 }];
  const out: { mode: LegMode; coords: number[][] }[] = [];
  for (let k = 1; k < remaining.length; k++) {
    const index = next + k - 1;
    const mode = (legs.find((l) => index <= l.end) ?? legs[legs.length - 1]).mode;
    const last = out[out.length - 1];
    if (last?.mode === mode) last.coords.push(remaining[k]);
    else out.push({ mode, coords: [remaining[k - 1], remaining[k]] });
  }
  return out;
}
