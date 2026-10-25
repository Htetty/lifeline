/** Independent PR #13 QA. Fictional fixtures only; no deployment or provider calls.
 * Deliberately ordinary (red) regression assertions document unfixed defects.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { checkRouteEvidence, incidentInput, planningFingerprint, teamInput, type RouteEvidence } from "../convex/planning";
import schema from "../convex/schema";
import { computeFlood, observationAt, type FloodGrid } from "../src/lib/flood";
import { evidenceFor, planAssignments, type RouteResult } from "../src/lib/planner";
import { buildGraph, planRoute } from "../src/lib/router";
import { moverFor, PROFILES } from "../convex/vehicles";
import type { Priority } from "../src/lib/priority";
import type { Incident, PriorityTier, RescueTeam } from "../src/lib/types";

const modules = import.meta.glob("../convex/**/*.ts");
const dispatcherToken = "qa-fictional-dispatcher";
const secret = "qa-fictional-backend";
beforeEach(() => {
  vi.stubEnv("DISPATCHER_TOKEN", dispatcherToken);
  vi.stubEnv("BACKEND_SECRET", secret);
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const incident = (id: string, k: number): Incident => ({
  id, exerciseId: "fictional", callId: null, source: "fixture", reportedAddress: `${id} Fictional Way`,
  latitude: 32.76, longitude: -117.17, locationVerified: true, peopleCount: null, reportedPosition: null,
  hazards: [], summary: "Simulated", transcript: null, status: "awaiting_assignment", assignedTeamId: null,
  callConnected: false, createdAt: k, updatedAt: k, version: 1,
});
const team = (id: string): RescueTeam => ({
  id, name: id, latitude: 32.75, longitude: -117.17, available: true, capabilities: ["road_vehicle"],
  currentAssignment: null, updatedAt: 0, simulated: true, trip: null,
});
const route = (s: number): RouteResult => ({
  ok: true, mover: "road_vehicle", path: [[-117.17, 32.75], [-117.17, 32.755], [-117.17, 32.76]],
  legs: [{ mode: "road", end: 2 }], realSeconds: s, maxDepth: 0, limit: 0.3,
  metres: { road: 1113, water: 0, foot: 0, air: 0 },
});
const tinyGrid = (): FloodGrid => ({ bounds: { west: -117.169, east: -117.167, north: 32.763, south: 32.761 },
  cols: 2, rows: 2, dLon: 0.001, dLat: 0.001, ground: new Float32Array(4).fill(10), seeds: [0, 1], channel: new Float32Array([9, 9]), gaugeCol: 0 });

test("QA: a real helicopter route south of the road graph midpoint must pass approval evidence", () => {
  // Road-file latitude bounds match the checked-in demo road graph. Aircraft ignore its roads.
  const graph = buildGraph({ bounds: { south: 32.752, north: 32.776 }, classes: [], nodes: [], edges: [] });
  const grid = tinyGrid();
  const helicopter = { ...team("air"), capabilities: ["air" as const], latitude: 32.756, longitude: -117.1625 };
  const target = { ...incident("waiting", 0), latitude: 32.762, longitude: -117.168 };
  const actual = planRoute(graph, grid, computeFlood(grid, 9), helicopter, target);
  expect(actual.ok).toBe(true);
  if (!actual.ok) throw new Error("Expected actual router output");
  expect(checkRouteEvidence(helicopter, target, evidenceFor(actual))).toBeNull();
});

test("QA: exact optimizer agrees with exhaustive enumeration on 400 seeded scarce-route matrices", () => {
  let seed = 202613;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 400; trial++) {
    const tiers: PriorityTier[] = ["critical", "high", "standard"];
    const incidents = Array.from({ length: 1 + random(6) }, (_, k) => incident(`i${k}`, k));
    const teams = Array.from({ length: 1 + random(5) }, (_, j) => team(`t${j}`));
    const rank = incidents.map(() => random(3));
    const priorities = new Map(incidents.map((i, k) => [i.id, { tier: tiers[rank[k]], reasons: [] } as Priority]));
    const times = incidents.map(() => teams.map(() => random(4) === 0 ? null : 60 + random(40)));
    const excluded = new Set<string>();
    if (trial % 3 === 0) excluded.add(`${incidents[0].id}|${teams[0].id}`);
    const order = incidents.map((_, k) => k).sort((a, b) => rank[a] - rank[b] || a - b);
    // Independent enumerator: score every complete feasible matching, no DP/pruning.
    let best: number[] | undefined;
    let bestPick: number[] = [];
    const walk = (k: number, used: Set<number>, pick: number[]) => {
      if (k === order.length) {
        const score = [0, 0, 0, 0, 0, 0];
        pick.forEach((j, n) => { if (j >= 0) { const i = order[n]; score[rank[i]]++; score[3 + rank[i]] -= times[i][j]!; } });
        const objective = [...score, ...pick.map((j) => j < 0 ? -teams.length : -j)];
        const diff = best ? objective.findIndex((x, n) => x !== best![n]) : -1;
        if (!best || (diff >= 0 && objective[diff] > best[diff])) { best = objective; bestPick = [...pick]; }
        return;
      }
      walk(k + 1, used, [...pick, -1]);
      const i = order[k];
      teams.forEach((t, j) => {
        if (used.has(j) || times[i][j] == null || excluded.has(`${incidents[i].id}|${t.id}`)) return;
        walk(k + 1, new Set([...used, j]), [...pick, j]);
      });
    };
    walk(0, new Set(), []);
    const expected = Object.fromEntries(bestPick.flatMap((j, k) => j < 0 ? [] : [[incidents[order[k]].id, teams[j].id]]));
    const plan = planAssignments({ incidents: [...incidents].reverse(), teams: [...teams].reverse(), priorities, excluded,
      route: (t, i) => { const s = times[incidents.indexOf(i)][teams.indexOf(t)]; return s == null ? { ok: false, mover: "road_vehicle", reason: "fictional blocked road" } : route(s); } });
    expect(Object.fromEntries(plan.proposals.map((p) => [p.incident.id, p.team.id])), `trial ${trial}`).toEqual(expected);
  }
});

test("QA: explanation must not claim a high incident ranks above a critical one", () => {
  const incidents = [incident("critical", 0), incident("high-1", 1), incident("high-2", 2)];
  const teams = [team("A"), team("B"), team("C")];
  const priorities = new Map(incidents.map((i, k) => [i.id, { tier: k === 0 ? "critical" : "high", reasons: [] } as Priority]));
  const times = [[10, 100, null], [20, null, 30], [21, null, 31]];
  const p = planAssignments({ incidents, teams, priorities, route: (t, i) => {
    const s = times[incidents.indexOf(i)][teams.indexOf(t)];
    return s == null ? { ok: false, mover: "road_vehicle", reason: "fictional blocked road" } : route(s);
  } });
  expect(p.proposals).toHaveLength(3); // correct: reserve A/C to cover BOTH high incidents
  const critical = p.proposals.find((x) => x.tier === "critical")!;
  expect(critical.team.id).toBe("B");
  expect(critical.reason).not.toContain("which ranks the same or higher");
});

test("QA: declared 12-team/40-incident bound is accepted; either excess refuses before routing", () => {
  const incidents = Array.from({ length: 40 }, (_, k) => incident(`i${k}`, k));
  const teams = Array.from({ length: 12 }, (_, j) => team(`t${String(j).padStart(2, "0")}`));
  const priorities = new Map(incidents.map((i) => [i.id, { tier: "standard", reasons: [] } as Priority]));
  const routeFor = vi.fn((t: RescueTeam, i: Incident): RouteResult => {
    if (incidents.indexOf(i) === teams.indexOf(t)) return route(60);
    return { ok: false, mover: "road_vehicle", reason: "fictional unavailable route" };
  });
  expect(planAssignments({ incidents, teams, priorities, route: routeFor }).proposals).toHaveLength(12);
  routeFor.mockClear();
  expect(planAssignments({ incidents: [...incidents, incident("extra", 41)], teams, priorities, route: routeFor }).status).toBe("too_large");
  expect(planAssignments({ incidents, teams: [...teams, team("extra")], priorities, route: routeFor }).status).toBe("too_large");
  expect(routeFor).not.toHaveBeenCalled();
});

const valid: RouteEvidence = {
  mover: "road_vehicle", realSeconds: 600, start: [-117.17, 32.75], end: [-117.17, 32.76],
  points: 3, modes: ["road"], maxDepth: 0.1, limit: 0.3,
};
const invalid: [string, Partial<RouteEvidence>][] = [
  ["empty start", { start: [] }], ["one-coordinate end", { end: [-117.17] }],
  ["NaN endpoint", { start: [NaN, 32.75] }], ["extra endpoint dimensions", { end: [-117.17, 32.76, 900] }],
  ["negative depth", { maxDepth: -1 }], ["negative infinite depth", { maxDepth: -Infinity }],
  ["NaN point count", { points: NaN }], ["infinite point count", { points: Infinity }],
  ["fractional point count", { points: 3.5 }],
  ["wrong vehicle", { mover: "boat" }], ["wrong mode", { modes: ["air"] }],
  ["negative time", { realSeconds: -1 }], ["NaN time", { realSeconds: NaN }],
  ["infinite time", { realSeconds: Infinity }], ["impossible speed", { realSeconds: 1 }],
  ["wrong start", { start: [0, 0] }], ["wrong end", { end: [0, 0] }],
  ["over-depth", { maxDepth: 1 }], ["NaN depth", { maxDepth: NaN }],
];
test.each(invalid)("QA: server rejects malformed route evidence: %s", (_label, patch) => {
  expect(checkRouteEvidence(team("t"), incident("i", 0), { ...valid, ...patch })).not.toBeNull();
});

type T = ReturnType<typeof convexTest>;
async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.exercise.ensureSeeded, { dispatcherToken });
  const teams = await t.run((ctx) => ctx.db.query("teams").collect());
  const boat = teams.find((x) => x.name === "Swift Water Boat 1")!;
  const truck = teams.find((x) => x.name.startsWith("High-Water Truck"))!;
  return { t, boat, truck };
}
async function call(t: T, callId: string, peopleCount: number | null = 2) {
  return await t.mutation(api.calls.upsertFromCall, {
    secret, callId, source: "fixture", reportedAddress: `${callId} Fictional Way`, peopleCount,
    reportedPosition: "roof", hazards: [], summary: "Simulated", transcript: "Caller: fictional test",
  });
}
async function confirmed(t: T, callId: string) {
  const incidentId = (await call(t, callId)).incidentId as Id<"incidents">;
  await t.mutation(api.incidents.verifyLocation, { dispatcherToken, incidentId, latitude: 32.762, longitude: -117.168 });
  return incidentId;
}
async function fingerprint(t: T) {
  return t.run(async (ctx) => {
    const ex = (await ctx.db.query("exercises").first())!;
    return planningFingerprint({ waterSurfaceElevation: ex.waterSurfaceElevation, waterObservedAt: ex.waterObservedAt ?? null,
      incidents: (await ctx.db.query("incidents").collect()).map(incidentInput), teams: (await ctx.db.query("teams").collect()).map(teamInput) });
  });
}
let serial = 0;
async function propose(t: T, incidentId: Id<"incidents">, team: Doc<"teams">) {
  const planId = `qa-plan-${++serial}`;
  await t.mutation(api.planner.recordProposal, { dispatcherToken, planId, fingerprint: await fingerprint(t),
    proposals: [{ incidentId, teamId: team._id, tier: "high", seconds: 600, reason: "Simulated QA proposal" }], unassigned: [] });
  const mover = moverFor(team.capabilities);
  return { dispatcherToken, planId, approvalId: `qa-approval-${++serial}`, selected: [{ incidentId, teamId: team._id,
    evidence: { mover, realSeconds: 600, start: [team.longitude, team.latitude], end: [-117.168, 32.762], points: 6, modes: ["road" as const], maxDepth: 0.1, limit: mover === "air" ? null : PROFILES[mover].limit } }] };
}

test("QA: reused approval ID with different selected pairs must not report success", async () => {
  const { t, boat, truck } = await setup();
  const a = await confirmed(t, "a"), b = await confirmed(t, "b");
  const pa = await propose(t, a, boat), pb = await propose(t, b, truck);
  expect(await t.mutation(api.planner.approvePlan, pa)).toMatchObject({ ok: true });
  const changed = await t.mutation(api.planner.approvePlan, { ...pb, approvalId: pa.approvalId });
  expect((await t.run((ctx) => ctx.db.get(b)))!.assignedTeamId).toBeNull();
  expect(changed).toMatchObject({ ok: false, outcome: "rejected_invalid" });
});

test("QA: corrected headcount invalidates the capacity warning the dispatcher reviewed", async () => {
  const { t, boat } = await setup();
  const a = await confirmed(t, "count");
  const p = await propose(t, a, boat);
  await call(t, "count", 40);
  expect((await t.run((ctx) => ctx.db.get(a)))!.peopleCount).toBe(40);
  expect(await t.mutation(api.planner.approvePlan, p)).toMatchObject({ ok: false, outcome: "rejected_stale" });
});

test("QA: resolved water observation changes the flood but must also invalidate approval", async () => {
  const { t, boat } = await setup();
  const a = await confirmed(t, "waiting");
  const r = await confirmed(t, "resolved-water");
  await t.mutation(api.incidents.setStatus, { dispatcherToken, incidentId: r, status: "resolved" });
  const p = await propose(t, a, boat);
  const before = await fingerprint(t);
  await t.mutation(api.calls.upsertFromCall, {
    secret, callId: "resolved-water", source: "fixture", reportedAddress: "resolved-water Fictional Way", peopleCount: 2,
    reportedPosition: "roof", hazards: [], summary: "Simulated", transcript: "Caller: fictional water is chest deep",
    waterReport: { level: "chest", floor: 0, evidence: "fictional chest deep", measuredMeters: null },
  });
  const resolved = (await t.run((ctx) => ctx.db.get(r)))!;
  expect(resolved.status).toBe("resolved");
  // Same observation construction as Dashboard.tsx: it includes resolved reports.
  const grid = tinyGrid();
  const at = observationAt(grid, resolved.waterReport!, resolved.longitude!, resolved.latitude!, 3, 10)!;
  const dry = computeFlood(grid, 9);
  const wet = computeFlood(grid, 9, [{ lon: resolved.longitude!, lat: resolved.latitude!, ...at, weight: 1 }]);
  expect(wet.depth).not.toEqual(dry.depth);
  expect(await fingerprint(t)).toBe(before); // demonstrate the missing fingerprint input
  expect(await t.mutation(api.planner.approvePlan, p)).toMatchObject({ ok: false, outcome: "rejected_stale" });
});

test("QA: approval rejects unauthenticated requests even after a successful retry receipt", async () => {
  const { t, boat } = await setup();
  const p = await propose(t, await confirmed(t, "auth"), boat);
  await expect(t.mutation(api.planner.approvePlan, { ...p, dispatcherToken: "wrong" })).rejects.toThrow(/passcode/);
  expect(await t.mutation(api.planner.approvePlan, p)).toMatchObject({ ok: true });
  await expect(t.mutation(api.planner.approvePlan, { ...p, dispatcherToken: "wrong" })).rejects.toThrow(/passcode/);
});

const staleCases: [string, Partial<Doc<"incidents">>, Partial<Doc<"teams">>][] = [
  ["latitude", { latitude: 32.763 }, {}], ["longitude", { longitude: -117.169 }, {}],
  ["location confirmation", { locationVerified: false }, {}],
  ["position", { reportedPosition: "ground floor" }, {}],
  ["priority override", { priorityOverride: { tier: "critical", reason: "fictional dispatcher review" } }, {}],
  ["risk", { riskFactors: [{ factor: "serious_injury", evidence: "fictional" }] }, {}],
  ["caller water", { waterReport: { level: "chest", meters: 1.3, floor: 0, evidence: "fictional", at: 1, gaugeSurface: 9 } }, {}],
  ["team latitude", {}, { latitude: 32.764 }], ["team longitude", {}, { longitude: -117.16 }],
  ["team availability", {}, { available: false }], ["team capabilities", {}, { capabilities: ["air"] }],
];
test.each(staleCases)("QA: changed %s rejects the old plan before assignment", async (_name, incidentPatch, teamPatch) => {
  const { t, boat } = await setup();
  const a = await confirmed(t, "stale");
  const p = await propose(t, a, boat);
  await t.run(async (ctx) => { await ctx.db.patch(a, incidentPatch); await ctx.db.patch(boat._id, teamPatch); });
  expect(await t.mutation(api.planner.approvePlan, p)).toMatchObject({ ok: false, outcome: "rejected_stale" });
  expect((await t.run((ctx) => ctx.db.get(a)))!.assignedTeamId).toBeNull();
  expect((await t.run((ctx) => ctx.db.query("events").collect())).filter((e) => e.type === "assignment_approved")).toHaveLength(0);
});

test("QA: selected route time must match the recorded proposal the dispatcher reviewed", async () => {
  const { t, boat } = await setup();
  const p = await propose(t, await confirmed(t, "time"), boat);
  p.selected[0].evidence.realSeconds = 3600; // recorded proposal said 600 seconds
  expect(await t.mutation(api.planner.approvePlan, p)).toMatchObject({ ok: false, outcome: "rejected_invalid" });
});

test("QA trust boundary: a fabricated but well-shaped route passes; this is not independent routing", async () => {
  const { t, boat } = await setup();
  const p = await propose(t, await confirmed(t, "forged"), boat);
  // No road graph or elevation/router was consulted anywhere in this fixture.
  expect(await t.mutation(api.planner.approvePlan, p)).toMatchObject({ ok: true });
});

test("QA: SDK timeout falls back and does not prevent approval", async () => {
  const { t, boat } = await setup();
  const p = await propose(t, await confirmed(t, "timeout"), boat);
  vi.stubEnv("ANTHROPIC_API_KEY", "qa-not-a-provider-key");
  vi.stubGlobal("fetch", vi.fn((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(new DOMException("QA simulated transport timeout", "AbortError")), { once: true });
  })));
  const result = await t.action(api.planner.explainPlan, { dispatcherToken, facts: "Fictional QA plan" });
  expect(result).toMatchObject({ text: null, note: expect.stringContaining("unavailable") });
  vi.unstubAllGlobals();
  expect(await t.mutation(api.planner.approvePlan, p)).toMatchObject({ ok: true });
}, 15_000);
