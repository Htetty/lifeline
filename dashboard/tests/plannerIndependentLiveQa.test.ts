/** Real Convex argument validation and transactions, disposable localhost ONLY.
 * All reports are explicitly fictional. No reset or shared deployment access.
 */
import { ConvexHttpClient } from "convex/browser";
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { floodFingerprint, incidentInput, planningFingerprint, teamInput, type RouteEvidence } from "../convex/planning";
import { moverFor, PROFILES } from "../convex/vehicles";
import { MIN_TRIP_MS, TRIP_SPEEDUP } from "../convex/tripMath";
import { computeFlood, type FloodGrid } from "../src/lib/flood";
import { evidenceFor } from "../src/lib/planner";
import { buildGraph, planRoute } from "../src/lib/router";

const url = process.env.LIFELINE_LOCAL_CONVEX_URL;
const enabled = url && /^http:\/\/(127\.0\.0\.1|localhost):/.test(url);
const dispatcherToken = process.env.LIFELINE_LOCAL_DISPATCHER_TOKEN;
const secret = process.env.LIFELINE_LOCAL_BACKEND_SECRET!;
const tag = `qa-fictional-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let serial = 0;

describe.skipIf(!enabled)("Independent planner QA: real disposable local Convex", () => {
  const client = () => new ConvexHttpClient(url!);
  const state = async () => (await client().query(api.exercise.get, { dispatcherToken }))!;
  const fp = async () => {
    const s = await state();
    return planningFingerprint({ waterSurfaceElevation: s.exercise.waterSurfaceElevation, waterObservedAt: s.exercise.waterObservedAt ?? null,
      incidents: s.incidents.map(incidentInput), teams: s.teams.map(teamInput) });
  };
  // Recorded proposals now require the reviewed route and the client's flood fingerprint.
  const flood = async () => floodFingerprint((await state()).incidents.map((i) => ({ ...i, id: i._id })));
  async function report(callId: string, peopleCount: number, water = false) {
    return client().mutation(api.calls.upsertFromCall, { secret, callId, source: "fixture",
      reportedAddress: `${callId} (fictional)`, peopleCount, reportedPosition: "roof", hazards: [], summary: "Simulated QA",
      transcript: "Caller: fictional QA report", ...(water ? { waterReport: { level: "chest" as const, floor: 0, measuredMeters: null, evidence: "fictional chest deep" } } : {}) });
  }
  async function create() {
    const callId = `${tag}-${++serial}`;
    const { incidentId } = await report(callId, 2);
    await client().mutation(api.incidents.verifyLocation, { dispatcherToken, incidentId, latitude: 32.762, longitude: -117.168 });
    return { callId, incidentId };
  }
  async function propose(incidentId: Id<"incidents">, chosenTeam?: Doc<"teams">, suppliedEvidence?: RouteEvidence) {
    const s = await state();
    const team = chosenTeam ?? s.teams.find((t) => t.available && !t.trip && !t.currentAssignment && t.capabilities.includes("boat"))!;
    const mover = moverFor(team.capabilities);
    const evidence: RouteEvidence = suppliedEvidence ?? { mover, realSeconds: 600, start: [team.longitude, team.latitude], end: [-117.168, 32.762], points: mover === "air" ? 2 : 6,
      modes: [mover === "air" ? "air" : "road"], maxDepth: 0.1, limit: mover === "air" ? null : PROFILES[mover].limit };
    const planId = `${tag}-plan-${++serial}`;
    await client().mutation(api.planner.recordProposal, { dispatcherToken, planId, fingerprint: await fp(), floodFingerprint: await flood(),
      proposals: [{ incidentId, teamId: team._id, tier: "high", seconds: evidence.realSeconds, reason: "Simulated QA", evidence: { ...evidence } }], unassigned: [] });
    return { dispatcherToken, planId, approvalId: `${tag}-approval-${++serial}`, selected: [{ incidentId, teamId: team._id, evidence }] };
  }
  async function finish(...ids: Id<"incidents">[]) {
    for (const incidentId of ids) await client().mutation(api.incidents.setStatus, { dispatcherToken, incidentId, status: "resolved" });
  }

  test("QA real: recommendation has no effects; batch is atomic, linked updates use the normal path, hangup retains assignment", async () => {
    const a = await create(), b = await create(), linked = await create();
    try {
      await client().mutation(api.incidents.linkReports, { dispatcherToken, mainId: a.incidentId, reportIds: [linked.incidentId] });
      const before = await state();
      const pa = await propose(a.incidentId);
      const truck = before.teams.find((t) => t.available && !t.trip && t.capabilities.includes("high_water_vehicle"))!;
      const pb = await propose(b.incidentId, truck);
      const planId = `${tag}-batch-${++serial}`;
      const selected = [...pa.selected, ...pb.selected];
      await client().mutation(api.planner.recordProposal, { dispatcherToken, planId, fingerprint: await fp(), floodFingerprint: await flood(),
        proposals: selected.map(({ incidentId, teamId, evidence }) => ({ incidentId, teamId, tier: "high" as const, seconds: evidence.realSeconds, reason: "Simulated batch QA", evidence: { ...evidence } })), unassigned: [] });
      const assignments = (s: Awaited<ReturnType<typeof state>>) => ({
        incidents: s.incidents.map((i) => [i._id, i.status, i.assignedTeamId]),
        teams: s.teams.map((t) => [t._id, t.available, t.currentAssignment, t.trip]),
      });
      expect(assignments(await state())).toEqual(assignments(before));
      const bad = selected.map((x, k) => k ? { ...x, evidence: { ...x.evidence, modes: ["water" as const] } } : x);
      expect(await client().mutation(api.planner.approvePlan, { dispatcherToken, planId, approvalId: `${planId}-bad`, selected: bad })).toMatchObject({ ok: false, outcome: "rejected_invalid" });
      expect(assignments(await state())).toEqual(assignments(before));
      for (const callId of [a.callId, b.callId, linked.callId]) {
        expect((await client().query(api.calls.pendingEvents, { secret, callId })).filter((e) => e.type === "assignment_approved")).toHaveLength(0);
      }
      const args = { dispatcherToken, planId, approvalId: `${planId}-ok`, selected };
      expect(await client().mutation(api.planner.approvePlan, args)).toMatchObject({ ok: true, assigned: 2 });
      expect(await client().mutation(api.planner.approvePlan, args)).toMatchObject({ ok: true, assigned: 2 });
      const after = await state();
      for (const [id, teamId] of [[a.incidentId, pa.selected[0].teamId], [linked.incidentId, pa.selected[0].teamId], [b.incidentId, truck._id]]) {
        expect(after.incidents.find((i) => i._id === id)).toMatchObject({ status: "assigned", assignedTeamId: teamId });
      }
      expect(after.teams.find((t) => t._id === truck._id)!.trip ?? null).toBeNull();
      for (const callId of [a.callId, b.callId, linked.callId]) {
        const updates = await client().query(api.calls.pendingEvents, { secret, callId });
        expect(updates.filter((e) => e.type === "assignment_approved")).toHaveLength(1);
        expect(updates.some((e) => e.type === "team_en_route" || e.type === "rescue_resolved")).toBe(false);
        expect(updates.find((e) => e.type === "assignment_approved")!.teamName).toBe(callId === b.callId ? truck.name : before.teams.find((t) => t._id === pa.selected[0].teamId)!.name);
      }
      await client().mutation(api.calls.callEnded, { secret, callId: a.callId });
      expect((await state()).incidents.find((i) => i._id === a.incidentId)).toMatchObject({ status: "assigned", callConnected: false });
      expect(await client().query(api.calls.pendingEvents, { secret, callId: a.callId })).toEqual([]);
    } finally { await finish(a.incidentId, b.incidentId); }
  });

  test("QA real: empty endpoint arrays must not reach assignment", async () => {
    const { incidentId } = await create();
    try {
      const p = await propose(incidentId);
      p.selected[0].evidence.start = []; p.selected[0].evidence.end = [];
      const result = await client().mutation(api.planner.approvePlan, p);
      expect(result).toMatchObject({ ok: false, outcome: "rejected_invalid" });
    } finally { await finish(incidentId); }
  });

  test("QA real: non-finite point count and negative depth must not reach assignment", async () => {
    const { incidentId } = await create();
    try {
      const p = await propose(incidentId);
      p.selected[0].evidence.points = NaN; p.selected[0].evidence.maxDepth = -Infinity;
      expect(await client().mutation(api.planner.approvePlan, p)).toMatchObject({ ok: false, outcome: "rejected_invalid" });
    } finally { await finish(incidentId); }
  });

  test("QA real: changed headcount must stale the reviewed plan", async () => {
    const { incidentId, callId } = await create();
    try {
      const p = await propose(incidentId);
      await report(callId, 40);
      expect(await client().mutation(api.planner.approvePlan, p)).toMatchObject({ ok: false, outcome: "rejected_stale" });
    } finally { await finish(incidentId); }
  });

  test("QA real: water from a resolved report must not bypass stale protection", async () => {
    const a = await create(), b = await create();
    try {
      await finish(b.incidentId);
      const p = await propose(a.incidentId);
      const before = await fp();
      await report(b.callId, 2, true);
      expect(await fp()).toBe(before);
      expect(await client().mutation(api.planner.approvePlan, p)).toMatchObject({ ok: false, outcome: "rejected_stale" });
    } finally { await finish(a.incidentId); }
  });

  test("QA real: approval ID conflict must not claim a different plan was approved", async () => {
    const a = await create(), b = await create();
    try {
      const pa = await propose(a.incidentId);
      const otherTeam = (await state()).teams.find((t) => t.available && !t.trip && !t.currentAssignment && t._id !== pa.selected[0].teamId)!;
      const pb = await propose(b.incidentId, otherTeam);
      expect(await client().mutation(api.planner.approvePlan, pa)).toMatchObject({ ok: true });
      const result = await client().mutation(api.planner.approvePlan, { ...pb, approvalId: pa.approvalId });
      expect((await state()).incidents.find((i) => i._id === b.incidentId)!.assignedTeamId).toBeNull();
      expect(result).toMatchObject({ ok: false, outcome: "rejected_invalid" });
    } finally { await finish(a.incidentId, b.incidentId); }
  });

  test("QA real: supplied route time must match the recorded proposal", async () => {
    const { incidentId } = await create();
    try {
      const p = await propose(incidentId);
      p.selected[0].evidence.realSeconds = 3600;
      expect(await client().mutation(api.planner.approvePlan, p)).toMatchObject({ ok: false, outcome: "rejected_invalid" });
    } finally { await finish(incidentId); }
  });

  test("QA real: production router aircraft evidence survives the speed sanity check", async () => {
    const { incidentId } = await create();
    const s = await state();
    let helicopter = s.teams.find((t) => t.available && !t.trip && t.capabilities.includes("air"))!;
    const previous = await create();
    const graph = buildGraph({ bounds: { south: 32.752, north: 32.776 }, classes: [], nodes: [], edges: [] });
    const grid = { cols: 0, rows: 0, ground: new Float32Array(), seeds: [], channel: new Float32Array(), gaugeCol: 0,
      dLon: 0.001, dLat: 0.001, bounds: { west: -117.18, east: -117.13, south: 32.75, north: 32.78 } } satisfies FloodGrid;
    try {
      // Complete a normal manually assigned southern trip on disposable data. Uses the
      // actual route calculation, normal status API and real local scheduled arrival.
      await client().mutation(api.incidents.verifyLocation, { dispatcherToken, incidentId: previous.incidentId, latitude: 32.756, longitude: -117.1625 });
      await client().mutation(api.incidents.assignTeam, { dispatcherToken, incidentId: previous.incidentId, teamId: helicopter._id });
      const first = planRoute(graph, grid, computeFlood(grid, 9), helicopter, { longitude: -117.1625, latitude: 32.756 });
      if (!first.ok) throw new Error("Expected first aircraft route");
      await client().mutation(api.incidents.setStatus, { dispatcherToken, incidentId: previous.incidentId, status: "en_route",
        plan: { path: first.path, legs: first.legs, realSeconds: first.realSeconds } });
      const deadline = Date.now() + Math.max(MIN_TRIP_MS, first.realSeconds * 1000 / TRIP_SPEEDUP) + 5_000;
      do {
        helicopter = (await state()).teams.find((t) => t._id === helicopter._id)!;
        if (!helicopter.trip) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      expect(helicopter.trip ?? null).toBeNull();
      expect(helicopter.latitude).toBe(32.756);
      await finish(previous.incidentId);
      helicopter = (await state()).teams.find((t) => t._id === helicopter._id)!;
      const actual = planRoute(graph, grid, computeFlood(grid, 9), helicopter, { longitude: -117.168, latitude: 32.762 });
      if (!actual.ok) throw new Error("Expected actual aircraft route");
      const p = await propose(incidentId, helicopter, evidenceFor(actual));
      expect(await client().mutation(api.planner.approvePlan, p)).toMatchObject({ ok: true });
    } finally { await finish(incidentId, previous.incidentId); }
  }, 25_000);
});
