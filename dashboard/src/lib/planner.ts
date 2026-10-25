import {
  fingerprintOf,
  floodFingerprint,
  incidentInput,
  planningFingerprint,
  teamInput,
  type PlanningInputs,
  type RouteEvidence,
} from "../../convex/planning";
import type { Priority } from "./priority";
import { TIER_RANK } from "./priority";
import type { NoRoute, RoutePlan } from "./router";
import type { ExerciseState, Incident, PriorityTier, RescueTeam } from "./types";

// Assignment suggestions for the dispatcher to review. Nothing here assigns anything.
//
// Who is considered: primary incidents (not linked reports) awaiting a team with a
// confirmed location, and teams that are available and not travelling. Existing
// assignments are left alone.
//
// Eligibility comes only from the flood-aware router (planRoute): a team is an option
// for an incident only if planRoute found a route. No route means not eligible; no route
// data (roads or flood still loading) means "cannot evaluate", never a guessed route.
//
// Objective, compared in this order across the whole queue at once:
//   1. most critical incidents covered, 2. then most high, 3. then most standard,
//   4. then the least simulated travel time for critical incidents, 5. then for high,
//      6. then for standard (whole seconds), so the fastest teams go to the most urgent,
//   7. then a fixed tie-break: incidents in queue order, each preferring the team that
//      sorts first by name (then id), so equal plans always come out the same.
// Covering more incidents of a tier always beats saving travel time, which is what keeps
// a scarce team (say the only boat) for the incident nobody else can reach.
//
// Exact: dynamic programming over subsets of teams. Only each incident's n fastest teams are
// considered (n = incidents waiting), which can't change the best plan: at most n − 1 of them
// are taken by other incidents, so swapping to a free one never covers less or travels more.
// When even that leaves too many subsets (many incidents and many free teams at once), the
// plan falls back to fastest-team-first in queue order, and says so.

export const MAX_PLAN_INCIDENTS = 40;
/** Most team subsets the exact search will hold at once. */
export const MAX_PLAN_STATES = 50_000;

export type RouteResult = RoutePlan | NoRoute | null;

export interface PlannerInput {
  incidents: Incident[];
  teams: RescueTeam[];
  priorities: Map<string, Priority>;
  /** planRoute for a team and incident; null when route data can't be evaluated. */
  route: (team: RescueTeam, incident: Incident) => RouteResult;
  /** Pairs the dispatcher excluded, as `${incidentId}|${teamId}`. */
  excluded?: Set<string>;
}

export type OptionState = "proposed" | "eligible" | "used_elsewhere" | "excluded" | "no_route" | "cannot_evaluate";

export interface TeamOption {
  team: RescueTeam;
  state: OptionState;
  seconds: number | null;
  /** Why not, for a team that isn't proposed here. */
  note: string;
}

export interface Proposal {
  incident: Incident;
  tier: PriorityTier;
  team: RescueTeam;
  route: RoutePlan;
  seconds: number;
  reason: string;
  unknowns: string[];
  alternatives: TeamOption[];
  evidence: RouteEvidence;
}

export interface Unassigned {
  incident: Incident;
  tier: PriorityTier | null;
  reason: string;
  alternatives: TeamOption[];
}

export interface Plan {
  status: "ok" | "cannot_evaluate" | "too_large" | "nothing_waiting";
  message: string | null;
  proposals: Proposal[];
  unassigned: Unassigned[];
  totalSeconds: number;
  /** Covered / waiting candidates, per tier. */
  coverage: Record<PriorityTier, { covered: number; waiting: number }>;
}

const TIERS: PriorityTier[] = ["critical", "high", "standard"];
const pairKey = (incidentId: string, teamId: string) => `${incidentId}|${teamId}`;
const minutes = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;
/** A travel-time difference, in seconds when under a minute so it is never overstated. */
const duration = (s: number) => (s < 60 ? `${s} s` : minutes(s));

export function evidenceFor(route: RoutePlan): RouteEvidence {
  return {
    mover: route.mover,
    realSeconds: route.realSeconds,
    start: route.path[0],
    end: route.path[route.path.length - 1],
    points: route.path.length,
    modes: [...new Set(route.legs.map((l) => l.mode))],
    maxDepth: route.maxDepth,
    limit: route.limit,
  };
}

/** Facts the model doesn't have, worth checking before approval. */
export function materialUnknowns(incident: Incident): string[] {
  const out: string[] = [];
  if (incident.peopleCount == null) out.push("Number of people unknown");
  else out.push(`Team capacity isn't modeled: check it can carry ${incident.peopleCount}`);
  const factors = new Set((incident.riskFactors ?? []).map((r) => r.factor));
  if (factors.has("serious_injury") || factors.has("medical_need")) {
    out.push("Medical need reported; team medical capability isn't modeled");
  }
  if (factors.has("limited_mobility") || factors.has("elderly")) out.push("Mobility needs reported; equipment isn't modeled");
  if (!incident.reportedPosition) out.push("Where they are in the building is unknown");
  return out;
}

type Score = number[]; // [covered critical, high, standard, -seconds critical, high, standard]

function better(a: Score, aPick: number[], b: Score, bPick: number[]) {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k];
  for (let k = 0; k < aPick.length; k++) {
    const x = aPick[k] < 0 ? Infinity : aPick[k];
    const y = bPick[k] < 0 ? Infinity : bPick[k];
    if (x !== y) return x < y;
  }
  return false;
}

export function planAssignments({ incidents, teams, priorities, route, excluded = new Set() }: PlannerInput): Plan {
  const tierOf = (i: Incident): PriorityTier => priorities.get(i.id)?.tier ?? "standard";
  const empty = () => Object.fromEntries(TIERS.map((t) => [t, { covered: 0, waiting: 0 }])) as Plan["coverage"];
  const primary = incidents.filter((i) => !i.linkedTo && i.status !== "resolved");
  const candidates = primary
    .filter((i) => i.status === "awaiting_assignment" && i.locationVerified && i.latitude != null && i.longitude != null)
    .sort((a, b) => TIER_RANK[tierOf(a)] - TIER_RANK[tierOf(b)] || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const unconfirmed = primary.filter((i) => i.status === "needs_review" || (i.status === "awaiting_assignment" && !candidates.includes(i)));
  const free = teams
    .filter((t) => t.available && t.currentAssignment == null && !t.trip)
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));

  const coverage = empty();
  for (const i of candidates) coverage[tierOf(i)].waiting++;
  const notConfirmed: Unassigned[] = unconfirmed.map((incident) => ({
    incident,
    tier: priorities.get(incident.id)?.tier ?? null,
    reason: "Location not confirmed yet. Confirm it on the map to include it in a plan.",
    alternatives: [],
  }));
  const base = { proposals: [], totalSeconds: 0, coverage };
  if (!candidates.length) {
    return { ...base, status: "nothing_waiting", message: "No confirmed incident is waiting for a team.", unassigned: notConfirmed };
  }
  if (candidates.length > MAX_PLAN_INCIDENTS) {
    return {
      ...base,
      status: "too_large",
      message: `The planner handles up to ${MAX_PLAN_INCIDENTS} waiting incidents; assign manually.`,
      unassigned: notConfirmed,
    };
  }

  // Route matrix from the flood-aware router.
  const routes = candidates.map((i) => free.map((t) => route(t, i)));
  const eligible = (k: number, j: number) => {
    const r = routes[k][j];
    return r?.ok === true && !excluded.has(pairKey(candidates[k].id, free[j].id));
  };
  const secs = (k: number, j: number) => Math.round((routes[k][j] as RoutePlan).realSeconds);
  if (routes.every((row) => row.every((r) => r == null))) {
    return {
      ...base,
      status: "cannot_evaluate",
      message: "Cannot evaluate routes: road or flood data isn't loaded. No plan was made.",
      unassigned: [
        ...candidates.map((incident) => ({ incident, tier: tierOf(incident), reason: "Cannot evaluate: route data unavailable.", alternatives: [] })),
        ...notConfirmed,
      ],
    };
  }

  // Each incident's n fastest eligible teams (see the note at the top), as bits of a subset.
  const T = free.length;
  const shortlist = candidates.map((_, k) =>
    free
      .map((_, j) => j)
      .filter((j) => eligible(k, j))
      .sort((a, b) => secs(k, a) - secs(k, b) || a - b)
      .slice(0, candidates.length),
  );
  const used = [...new Set(shortlist.flat())].sort((a, b) => a - b);
  const bit = new Map(used.map((j, b) => [j, b]));
  let subsets = 0;
  for (let i = 0, c = 1; i <= Math.min(candidates.length, used.length); i++) {
    subsets += c;
    c = (c * (used.length - i)) / (i + 1);
  }
  const exact = used.length <= 30 && subsets <= MAX_PLAN_STATES;

  // Exact DP over which teams are used. `forced` pins one incident to one team, to see
  // what the best plan would be if that choice were made (used to explain the plan).
  const solve = (forced?: { k: number; j: number }) => {
    let layer = new Map<number, { score: Score; pick: number[] }>([[0, { score: [0, 0, 0, 0, 0, 0], pick: [] }]]);
    candidates.forEach((incident, k) => {
      const next = new Map<number, { score: Score; pick: number[] }>();
      const offer = (mask: number, score: Score, pick: number[]) => {
        const cur = next.get(mask);
        if (!cur || better(score, pick, cur.score, cur.pick)) next.set(mask, { score, pick });
      };
      const tier = TIER_RANK[tierOf(incident)];
      const options = forced?.k === k ? [forced.j].filter((j) => eligible(k, j)) : shortlist[k];
      for (const [mask, s] of layer) {
        if (forced?.k !== k) offer(mask, s.score, [...s.pick, -1]);
        for (const j of options) {
          const b = 1 << (bit.get(j) ?? 31);
          if (!bit.has(j) || mask & b) continue;
          const score = [...s.score];
          score[tier] += 1;
          score[3 + tier] -= secs(k, j);
          offer(mask | b, score, [...s.pick, j]);
        }
      }
      layer = next;
    });
    let best: { score: Score; pick: number[] } | null = null;
    for (const s of layer.values()) if (!best || better(s.score, s.pick, best.score, best.pick)) best = s;
    return best;
  };
  /** Too many subsets: each incident in queue order (most urgent first) takes its fastest free team. */
  const quick = () => {
    const taken = new Set<number>();
    const score: Score = [0, 0, 0, 0, 0, 0];
    const pick = candidates.map((incident, k) => {
      const j = shortlist[k].find((x) => !taken.has(x)) ?? -1;
      if (j >= 0) {
        taken.add(j);
        score[TIER_RANK[tierOf(incident)]] += 1;
        score[3 + TIER_RANK[tierOf(incident)]] -= secs(k, j);
      }
      return j;
    });
    return { score, pick };
  };
  const best = exact ? solve()! : quick();
  const pick = best.pick;
  /** Team index → the candidate it is proposed for. */
  const servedBy = new Map<number, number>();
  pick.forEach((j, k) => j >= 0 && servedBy.set(j, k));

  const optionsFor = (k: number): TeamOption[] =>
    free
      .map((team, j): TeamOption => {
        const r = routes[k][j];
        if (r == null) return { team, state: "cannot_evaluate", seconds: null, note: "Cannot evaluate: route data unavailable" };
        if (!r.ok) return { team, state: "no_route", seconds: null, note: `No route under the simulated flood: ${r.reason}` };
        const s = secs(k, j);
        if (excluded.has(pairKey(candidates[k].id, team.id))) return { team, state: "excluded", seconds: s, note: "Excluded by dispatcher" };
        if (pick[k] === j) return { team, state: "proposed", seconds: s, note: "Proposed" };
        const other = servedBy.get(j);
        if (other != null) {
          const o = candidates[other];
          return { team, state: "used_elsewhere", seconds: s, note: `Proposed for ${o.reportedAddress} (${tierOf(o)})` };
        }
        return { team, state: "eligible", seconds: s, note: "Available; not needed for the best plan" };
      })
      .sort((a, b) => (a.seconds ?? Infinity) - (b.seconds ?? Infinity) || a.team.name.localeCompare(b.team.name));

  /**
   * Why a faster team isn't proposed here: the best plan that does send it here, compared
   * with the chosen plan on the objective, in order. The first difference is the reason.
   */
  const tradeoff = (k: number, faster: TeamOption, seconds: number): string => {
    const lead =
      faster.seconds! < seconds
        ? `${faster.team.name} would be faster (${duration(faster.seconds!)} vs ${duration(seconds)})`
        : `${faster.team.name} is just as fast (${duration(seconds)})`;
    if (!exact) return `${lead}, but it is proposed for a more urgent or earlier incident.`;
    const alt = solve({ k, j: free.indexOf(faster.team) });
    if (!alt) return `${lead}, but no complete plan can send it here.`;
    for (let t = 0; t < 3; t++) {
      if (alt.score[t] === best.score[t]) continue;
      const lost = candidates.filter((_, x) => TIER_RANK[tierOf(candidates[x])] === t && pick[x] >= 0 && alt.pick[x] < 0);
      const tier = TIERS[t];
      const names = lost.map((i) => i.reportedAddress).join(", ");
      return `${lead}, but sending it here would leave ${alt.score[t] - best.score[t] === -1 ? `a ${tier} incident` : `${best.score[t] - alt.score[t]} ${tier} incidents`} without a team${names ? ` (${names})` : ""}. Covering more incidents of each priority, most urgent first, comes before travel time.`;
    }
    for (let t = 3; t < 6; t++) {
      if (alt.score[t] === best.score[t]) continue;
      const tier = TIERS[t - 3];
      return `${lead}, but sending it here would add ${duration(best.score[t] - alt.score[t])} of simulated travel for ${tier} incidents overall (${duration(-alt.score[t])} instead of ${duration(-best.score[t])}). Travel time is kept lowest for the most urgent incidents first.`;
    }
    return `${lead}, and the plan that sends it here is otherwise equal; equal plans are settled by queue order, each incident taking the team first by name.`;
  };

  const proposals: Proposal[] = [];
  const unassigned: Unassigned[] = [];
  candidates.forEach((incident, k) => {
    const tier = tierOf(incident);
    const alternatives = optionsFor(k);
    const j = pick[k];
    if (j < 0) {
      const usable = alternatives.filter((o) => o.state === "used_elsewhere" || o.state === "eligible");
      // One short line; the per-team detail is in `alternatives`.
      const reason = !free.length
        ? "All teams are assigned."
        : usable.length
          ? "All teams that can reach it are proposed for other incidents."
          : alternatives.some((o) => o.state === "excluded")
            ? "The teams that can reach it were excluded by the dispatcher."
            : alternatives.some((o) => o.state === "cannot_evaluate")
              ? "Cannot evaluate some routes (route data unavailable), and no evaluated team can reach it."
              : "No available team can reach it under the simulated flood.";
      unassigned.push({ incident, tier, reason, alternatives });
      return;
    }
    const team = free[j];
    const route = routes[k][j] as RoutePlan;
    const seconds = secs(k, j);
    const fastest = alternatives.find((o) => o.seconds != null && o.state !== "excluded" && o.state !== "no_route");
    const onlyOption = alternatives.filter((o) => ["proposed", "eligible", "used_elsewhere"].includes(o.state)).length === 1;
    let reason: string;
    if (onlyOption) reason = `${team.name} is the only available team that can reach it under the simulated flood.`;
    else if (fastest?.team.id === team.id) reason = `Fastest eligible team (${minutes(seconds)}, simulated).`;
    else if (fastest) reason = tradeoff(k, fastest, seconds);
    else reason = `Best option in the overall plan (${minutes(seconds)}, simulated).`;
    coverage[tier].covered++;
    proposals.push({ incident, tier, team, route, seconds, reason, unknowns: materialUnknowns(incident), alternatives, evidence: evidenceFor(route) });
  });

  return {
    status: "ok",
    message: exact ? null : `${candidates.length} incidents and ${T} free teams: too many to compare every plan, so each incident takes the fastest team still free, most urgent first.`,
    proposals,
    unassigned: [...unassigned, ...notConfirmed],
    totalSeconds: proposals.reduce((n, p) => n + p.seconds, 0),
    coverage,
  };
}

/** The same fingerprint the server computes, from what the dashboard sees. */
export function stateFingerprint(state: ExerciseState): string {
  return planningFingerprint(stateInputs(state));
}

/** The planning inputs the server computes, from what the dashboard sees. */
export function stateInputs(state: ExerciseState): PlanningInputs {
  // Dashboard ids are plain strings; the fingerprint only reads them as text.
  type In = Parameters<typeof incidentInput>[0];
  type TIn = Parameters<typeof teamInput>[0];
  return {
    waterSurfaceElevation: state.waterSurfaceElevation,
    waterObservedAt: state.waterObservedAt,
    incidents: state.incidents.map((i) => incidentInput(i as unknown as In)),
    teams: state.teams.map((t) => teamInput(t as unknown as TIn)),
  };
}

/** The server's floodFingerprint, from what the dashboard sees (resolved reports included). */
export function stateFloodFingerprint(state: ExerciseState): string {
  return floodFingerprint(state.incidents);
}

/** Fingerprint of the priorities the dashboard computed (they also depend on the local flood model). */
export function priorityFingerprint(priorities: Map<string, Priority>): string {
  return fingerprintOf([...priorities].map(([id, p]) => [id, p.tier, p.reasons]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}
