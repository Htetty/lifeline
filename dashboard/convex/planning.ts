import type { Doc } from "./_generated/dataModel";
import { moverFor, PROFILES, type Mover } from "./vehicles";

// Shared by the dashboard's assignment planner and the server's approval checks.
//
// The flood-aware router and the priority rules run in the dashboard (they need the
// elevation tiles), so the server cannot re-run them. Instead a plan is bound to a
// fingerprint of every server-known input to routing and priority. Approval recomputes
// it from the database and refuses a plan made from different inputs. Route evidence
// sent with an approval is also checked for internal consistency (see checkRouteEvidence).

/** The parts of an incident that can change who should go there, or how a route runs. */
type IncidentInput = Pick<
  Doc<"incidents">,
  | "status"
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

type TeamInput = Pick<Doc<"teams">, "available" | "currentAssignment" | "latitude" | "longitude" | "capabilities"> & {
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

/**
 * Fingerprint of everything a plan depends on. Resolved incidents are left out (they can't
 * change a plan); transcript-only updates are not inputs, so ongoing calls don't stale a plan.
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

function metresBetween(a: number[], b: number[]) {
  const kx = 111_320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 111_320);
}

/**
 * Whether a route is something the flood-aware router could have produced for this team
 * and incident: the right vehicle, from the team to the incident, only the leg types the
 * vehicle has, within its depth limit, and not faster than the vehicle can move. A road or
 * boat "route" that is a single straight line (the flood-ignoring fallback) never passes.
 * Returns the problem, or null when it is consistent.
 */
export function checkRouteEvidence(
  team: Pick<Doc<"teams">, "longitude" | "latitude" | "capabilities">,
  incident: Pick<Doc<"incidents">, "longitude" | "latitude">,
  r: RouteEvidence,
): string | null {
  const mover = moverFor(team.capabilities);
  if (r.mover !== mover) return `route is for a ${r.mover}, but this team moves as a ${mover}`;
  if (incident.longitude == null || incident.latitude == null) return "incident has no location";
  if (metresBetween(r.start, [team.longitude, team.latitude]) > SAME_POINT_M) return "route doesn't start at the team";
  if (metresBetween(r.end, [incident.longitude, incident.latitude]) > SAME_POINT_M) return "route doesn't end at the incident";
  if (!r.modes.length || r.modes.some((m) => !ALLOWED_MODES[mover].includes(m))) return "route uses travel this team can't do";
  if (mover !== "air" && r.points < 3) return "straight-line route; flood-aware route needed";
  const limit = mover === "air" ? null : PROFILES[mover].limit;
  if (r.limit !== limit) return "route used the wrong depth limit";
  if (limit != null && !(r.maxDepth <= limit)) return "route drives through water deeper than the team's limit";
  if (!Number.isFinite(r.realSeconds) || r.realSeconds <= 0) return "route has no usable travel time";
  if (r.realSeconds < metresBetween(r.start, r.end) / MAX_SPEED[mover]) return "travel time is faster than the team can move";
  return null;
}

// ---- Explanation checks ---------------------------------------------------------------

/**
 * Whether model-written text sticks to the supplied facts: every team it names is one of
 * `teamNames` that is in the facts, and every number it uses appears in the facts.
 */
export function explanationProblems(text: string, facts: string, allTeamNames: string[]): string[] {
  const problems: string[] = [];
  for (const name of allTeamNames) {
    if (text.includes(name) && !facts.includes(name)) problems.push(`names ${name}, which isn't in the plan`);
  }
  const known = new Set(facts.match(/\d+(?:\.\d+)?/g) ?? []);
  for (const n of text.match(/\d+(?:\.\d+)?/g) ?? []) if (!known.has(n)) problems.push(`uses the number ${n}, which isn't in the facts`);
  if (/\b(safe|guarantee[sd]?|certain|\d+\s*%)\b/i.test(text)) problems.push("claims safety or certainty");
  return problems;
}

// ---- What changed -----------------------------------------------------------------------

/** The canonical snapshot the server stores with a plan (see changesBetween). */
export function snapshotOf(inputs: PlanningInputs): string {
  return canonical({ ...inputs, incidents: [...inputs.incidents].sort((x, y) => (x.id < y.id ? -1 : 1)) });
}

const INCIDENT_FIELDS: [keyof IncidentInput, string][] = [
  ["status", "status"],
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
  ["available", "availability"],
  ["currentAssignment", "assignment"],
  ["latitude", "position"],
  ["longitude", "position"],
  ["capabilities", "capabilities"],
  ["moving", "travel"],
];

/** Human-readable differences between two snapshots, for refusing a stale approval. */
export function changesBetween(before: string, after: PlanningInputs, names: Map<string, string>): string[] {
  const old = JSON.parse(before) as PlanningInputs;
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
