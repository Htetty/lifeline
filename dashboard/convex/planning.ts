import type { Doc } from "./_generated/dataModel";
import { EXERCISE_BOUNDS } from "./seedData";
import { moverFor, PROFILES, type Mover } from "./vehicles";

// Shared by the dashboard's assignment planner and the server's approval checks.
//
// The flood-aware router and the priority rules run in the dashboard (they need the
// elevation tiles), so the server cannot re-run them. Instead a plan is bound to a
// fingerprint of every server-known input to routing, priority, eligibility and what the
// dispatcher is shown, plus a fingerprint of every caller water report that shapes the
// flood. Approval recomputes both from the database and refuses a plan made from different
// inputs. Route evidence sent with an approval is checked for internal consistency (see
// checkRouteEvidence) and against what the dispatcher reviewed. It is still computed in
// the browser: the server does not re-route, so a well-formed route is trusted as given.

/** The parts of an incident that can change who should go there, how a route runs, or what the plan says. */
type IncidentInput = Pick<
  Doc<"incidents">,
  | "status"
  | "createdAt"
  | "reportedAddress"
  | "peopleCount"
  | "locationVerified"
  | "latitude"
  | "longitude"
  | "assignedTeamId"
  | "reportedPosition"
  | "riskFactors"
  | "priorityOverride"
  | "waterReport"
  | "linkedTo"
> & { id: string };

type TeamInput = Pick<Doc<"teams">, "name" | "available" | "currentAssignment" | "latitude" | "longitude" | "capabilities"> & {
  id: string;
  moving: boolean;
};

export interface PlanningInputs {
  waterSurfaceElevation: number;
  waterObservedAt: number | null;
  incidents: IncidentInput[];
  teams: TeamInput[];
}

const nul = <T>(x: T | undefined) => (x === undefined ? null : x);

/** Normalise a database incident or a dashboard incident (id instead of _id). */
export function incidentInput(i: Omit<IncidentInput, "id"> & ({ _id: string } | { id: string })): IncidentInput {
  return {
    id: "_id" in i ? i._id : i.id,
    status: i.status,
    createdAt: i.createdAt,
    reportedAddress: i.reportedAddress,
    peopleCount: nul(i.peopleCount),
    locationVerified: i.locationVerified,
    latitude: i.latitude,
    longitude: i.longitude,
    assignedTeamId: i.assignedTeamId,
    reportedPosition: i.reportedPosition,
    riskFactors: nul(i.riskFactors)?.map((r) => ({ factor: r.factor, evidence: null })) ?? [],
    priorityOverride: nul(i.priorityOverride),
    waterReport: nul(i.waterReport),
    linkedTo: nul(i.linkedTo),
  };
}

export function teamInput(
  t: Omit<TeamInput, "id" | "moving"> & { trip?: unknown } & ({ _id: string } | { id: string }),
): TeamInput {
  return {
    id: "_id" in t ? t._id : t.id,
    name: t.name,
    available: t.available,
    currentAssignment: t.currentAssignment,
    latitude: t.latitude,
    longitude: t.longitude,
    capabilities: [...t.capabilities].sort(),
    moving: Boolean(t.trip),
  };
}

/** JSON with sorted keys, so equal inputs always give the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Two independent 32-bit FNV-1a hashes: a short, deterministic identifier (not security). */
function fnv(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 + 0x2c) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** A short deterministic identifier of any JSON-like value (sorted keys). */
export function fingerprintOf(value: unknown): string {
  return fnv(canonical(value));
}

/**
 * Fingerprint of everything a plan depends on except caller water reports on resolved
 * incidents (see floodFingerprint). Resolved incidents are otherwise left out (they can't
 * be assigned or change a priority); transcript-only updates are not inputs, so ongoing
 * calls don't stale a plan.
 */
export function planningFingerprint(inputs: PlanningInputs): string {
  const incidents = inputs.incidents.filter((i) => i.status !== "resolved").sort((x, y) => (x.id < y.id ? -1 : 1));
  const teams = [...inputs.teams].sort((x, y) => (x.id < y.id ? -1 : 1));
  return fnv(
    canonical({
      water: [inputs.waterSurfaceElevation, inputs.waterObservedAt ?? null],
      incidents,
      teams,
    }),
  );
}

// ---- Per-assignment binding ------------------------------------------------------------
//
// During a busy exercise something changes every second (new calls, teams arriving, the river
// rising), so a plan bound to all of it could never be approved. Each proposal is instead
// bound to what it depends on directly: its incident, the reports linked to it, and its team.
// The river may move by up to WATER_TOLERANCE_M before the plan's routes count as out of date.

/** How far the river may move after a plan is made before its routes are out of date. */
export const WATER_TOLERANCE_M = 0.3;

const byId = <T extends { id: string }>(x: T, y: T) => (x.id < y.id ? -1 : 1);

/** Only the given incidents (with the reports linked to them) and teams. */
export function scopeInputs(inputs: PlanningInputs, incidentIds: Set<string>, teamIds: Set<string>): PlanningInputs {
  return {
    ...inputs,
    incidents: inputs.incidents.filter((i) => incidentIds.has(i.id) || (i.linkedTo != null && incidentIds.has(i.linkedTo))).sort(byId),
    teams: inputs.teams.filter((t) => teamIds.has(t.id)).sort(byId),
  };
}

/** Fingerprint of what one proposal depends on: its incident, the reports linked to it, and its team. */
export function pairBasis(inputs: PlanningInputs, incidentId: string, teamId: string): string {
  const { incidents, teams } = scopeInputs(inputs, new Set([incidentId]), new Set([teamId]));
  return fingerprintOf({ incidents, team: teams[0] ?? null });
}

/** Where a caller's water report sits: it shapes the simulated flood whatever the incident's status. */
interface WaterObservationInput {
  id: string;
  waterReport?: Doc<"incidents">["waterReport"];
  latitude?: number | null;
  longitude?: number | null;
  locationVerified: boolean;
}

/**
 * Fingerprint of every caller water report the flood model uses (Dashboard.tsx turns each
 * one, resolved incidents included, into an observation that raises or lowers the water).
 */
export function floodFingerprint(incidents: WaterObservationInput[]): string {
  return fingerprintOf(
    incidents
      .filter((i) => i.waterReport != null)
      .map((i) => ({ id: i.id, report: i.waterReport, at: [i.longitude ?? null, i.latitude ?? null], verified: i.locationVerified }))
      .sort((x, y) => (x.id < y.id ? -1 : 1)),
  );
}

// ---- Route evidence ----------------------------------------------------------------

/** What the dashboard's router (planRoute) returned for a team and incident, in brief. */
export interface RouteEvidence {
  mover: Mover;
  realSeconds: number;
  start: number[];
  end: number[];
  points: number;
  modes: ("road" | "water" | "foot" | "air")[];
  maxDepth: number;
  limit: number | null;
}

const ALLOWED_MODES: Record<Mover, RouteEvidence["modes"]> = {
  road_vehicle: ["road", "foot"],
  high_water_vehicle: ["road", "foot"],
  boat: ["road", "water", "foot"],
  air: ["air"],
};
/** Fastest anything in the simulation moves (helicopter 50 m/s; motorway 27 m/s). */
const MAX_SPEED: Record<Mover, number> = { road_vehicle: 27, high_water_vehicle: 27, boat: 27, air: 50 };
const SAME_POINT_M = 2;
/** More points than the road graph has nodes (about 11,500), so no real route exceeds it. */
export const MAX_ROUTE_POINTS = 50_000;

/**
 * Route ends may lie a little outside the road graph's area: an incident just past its edge
 * is reached on foot from the nearest road, or by air. About 1 km either way.
 */
const AREA_MARGIN_DEG = 0.01;
const PLAN_AREA = {
  west: EXERCISE_BOUNDS.west - AREA_MARGIN_DEG,
  east: EXERCISE_BOUNDS.east + AREA_MARGIN_DEG,
  south: EXERCISE_BOUNDS.south - AREA_MARGIN_DEG,
  north: EXERCISE_BOUNDS.north + AREA_MARGIN_DEG,
};
const inArea = (p: number[]) =>
  p.length === 2 &&
  p.every(Number.isFinite) &&
  p[0] >= PLAN_AREA.west &&
  p[0] <= PLAN_AREA.east &&
  p[1] >= PLAN_AREA.south &&
  p[1] <= PLAN_AREA.north;

/**
 * Planar distance with the east-west scale at the area's north edge. The router scales by
 * the cosine of its graph's middle latitude; within the area this cosine is never larger,
 * so the result is never longer than the router's own distance (a safe speed lower bound).
 */
const COS_NORTH = Math.cos((PLAN_AREA.north * Math.PI) / 180);
function metresAtMost(a: number[], b: number[]) {
  return Math.hypot((b[0] - a[0]) * 111_320 * COS_NORTH, (b[1] - a[1]) * 111_320);
}

/**
 * Whether route evidence is well formed and something the flood-aware router could have
 * produced for this team and incident: two finite coordinates inside the exercise area at
 * each end, a whole number of points, the right vehicle, from the team to the incident,
 * only the leg types the vehicle has, a finite non-negative depth within its limit, and a
 * positive travel time no faster than the vehicle can move. A road or boat "route" that is
 * a single straight line (the flood-ignoring fallback) never passes. Returns the problem,
 * or null when it is consistent. Consistency only: the server does not re-run the router.
 */
export function checkRouteEvidence(
  team: Pick<Doc<"teams">, "longitude" | "latitude" | "capabilities">,
  incident: Pick<Doc<"incidents">, "longitude" | "latitude">,
  r: RouteEvidence,
): string | null {
  if (!Array.isArray(r.start) || !inArea(r.start)) return "route start isn't a point in the exercise area";
  if (!Array.isArray(r.end) || !inArea(r.end)) return "route end isn't a point in the exercise area";
  if (!Number.isInteger(r.points) || r.points < 2 || r.points > MAX_ROUTE_POINTS) return "route has an invalid number of points";
  if (!Number.isFinite(r.maxDepth) || r.maxDepth < 0) return "route has an invalid water depth";
  if (!Number.isFinite(r.realSeconds) || r.realSeconds <= 0) return "route has no usable travel time";
  const mover = moverFor(team.capabilities);
  if (r.mover !== mover) return `route is for a ${r.mover}, but this team moves as a ${mover}`;
  if (incident.longitude == null || incident.latitude == null) return "incident has no location";
  if (metresAtMost(r.start, [team.longitude, team.latitude]) > SAME_POINT_M) return "route doesn't start at the team";
  if (metresAtMost(r.end, [incident.longitude, incident.latitude]) > SAME_POINT_M) return "route doesn't end at the incident";
  if (!r.modes.length || new Set(r.modes).size !== r.modes.length || r.modes.some((m) => !ALLOWED_MODES[mover].includes(m))) {
    return "route uses travel this team can't do";
  }
  if (mover === "air" ? r.points !== 2 || r.maxDepth !== 0 : r.points < 3) {
    return mover === "air" ? "aircraft route isn't a single direct flight" : "straight-line route; flood-aware route needed";
  }
  const limit = mover === "air" ? null : PROFILES[mover].limit;
  if (r.limit !== limit) return "route used the wrong depth limit";
  if (limit != null && !(r.maxDepth <= limit)) return "route drives through water deeper than the team's limit";
  // A relative epsilon only absorbs floating-point rounding between the two calculations.
  if (r.realSeconds * (1 + 1e-9) < metresAtMost(r.start, r.end) / MAX_SPEED[mover]) return "travel time is faster than the team can move";
  return null;
}

// ---- What changed -----------------------------------------------------------------------

/** The canonical snapshot the server stores with a plan (see changesBetween). */
export function snapshotOf(inputs: PlanningInputs): string {
  return canonical({ ...inputs, incidents: [...inputs.incidents].sort((x, y) => (x.id < y.id ? -1 : 1)) });
}

const INCIDENT_FIELDS: [keyof IncidentInput, string][] = [
  ["status", "status"],
  ["reportedAddress", "address"],
  ["peopleCount", "number of people"],
  ["createdAt", "report time"],
  ["locationVerified", "location confirmation"],
  ["latitude", "location"],
  ["longitude", "location"],
  ["linkedTo", "linking"],
  ["assignedTeamId", "assigned team"],
  ["riskFactors", "reported risks"],
  ["reportedPosition", "position in the building"],
  ["priorityOverride", "priority override"],
  ["waterReport", "reported water depth"],
];
const TEAM_FIELDS: [keyof TeamInput, string][] = [
  ["name", "name"],
  ["available", "availability"],
  ["currentAssignment", "assignment"],
  ["latitude", "position"],
  ["longitude", "position"],
  ["capabilities", "capabilities"],
  ["moving", "travel"],
];

/**
 * Human-readable differences between two snapshots, for refusing a stale approval. With a
 * scope, only those incidents and teams are compared, and the river level is left out.
 */
export function changesBetween(
  before: string,
  current: PlanningInputs,
  names: Map<string, string>,
  scope?: { incidents: Set<string>; teams: Set<string> },
): string[] {
  const parsed = JSON.parse(before) as PlanningInputs;
  const old = scope ? { ...scopeInputs(parsed, scope.incidents, scope.teams), waterSurfaceElevation: 0, waterObservedAt: null } : parsed;
  const after = scope ? { ...scopeInputs(current, scope.incidents, scope.teams), waterSurfaceElevation: 0, waterObservedAt: null } : current;
  const out = new Set<string>();
  if (old.waterSurfaceElevation !== after.waterSurfaceElevation || (old.waterObservedAt ?? null) !== (after.waterObservedAt ?? null)) {
    out.add("the river level changed");
  }
  const name = (id: string) => names.get(id) ?? "a report";
  const compare = <T extends { id: string }>(was: T[], now: T[], fields: [keyof T, string][], kind: string) => {
    const byId = new Map(was.map((x) => [x.id, x]));
    for (const cur of now) {
      const prev = byId.get(cur.id);
      if (!prev) {
        out.add(`${kind} ${name(cur.id)} is new`);
        continue;
      }
      for (const [field, label] of fields) {
        if (canonical(prev[field]) !== canonical(cur[field])) out.add(`${name(cur.id)}: ${label} changed`);
      }
      byId.delete(cur.id);
    }
    for (const gone of byId.keys()) out.add(`${kind} ${name(gone)} was removed or resolved`);
  };
  compare(old.incidents.filter((i) => i.status !== "resolved"), after.incidents.filter((i) => i.status !== "resolved"), INCIDENT_FIELDS, "incident");
  compare(old.teams, after.teams, TEAM_FIELDS, "team");
  return [...out];
}
