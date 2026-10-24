// Simulated responder movement. A trip stores its path and times once; every viewer
// works out where the team is from the clock, so nothing is written while it moves.
// Shared by the Convex functions and the dashboard.

export type LonLat = [number, number];

export interface Trip {
  incidentId: string;
  /** [longitude, latitude] points from the team's start to the incident. */
  path: number[][];
  departAt: number;
  arriveAt: number;
  /** "road" follows a driving route; "direct" is a straight line (boat, air, or no route found). */
  route: "road" | "direct";
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

/** Where the team is at `now`, and the part of the path still ahead of it. */
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
      return { position, remaining: [position, ...path.slice(i)] as number[][], fraction };
    }
    target -= leg;
  }
  const end = path[path.length - 1] as LonLat;
  return { position: end, remaining: [end], fraction };
}
