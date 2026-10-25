import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { floodFingerprint, incidentInput, planningFingerprint, teamInput, type RouteEvidence } from "../convex/planning";
import schema from "../convex/schema";
import { moverFor, PROFILES } from "../convex/vehicles";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "isolated-fixture-only";
const dispatcherToken = "isolated-dispatcher-only";

beforeEach(() => {
  process.env.BACKEND_SECRET = secret;
  process.env.DISPATCHER_TOKEN = dispatcherToken;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => vi.unstubAllGlobals());

type T = ReturnType<typeof convexTest>;
let planCounter = 0;

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.exercise.ensureSeeded, { dispatcherToken });
  const teams = await t.run((ctx) => ctx.db.query("teams").collect());
  const byName = (prefix: string) => teams.find((x) => x.name.startsWith(prefix))!;
  return { t, boat: byName("Swift Water Boat 1"), boat2: byName("Swift Water Boat 2"), truck: byName("High-Water Truck"), heli: byName("Helicopter") };
}

/** A confirmed incident reported from the map (no caller). */
async function mapIncident(t: T, address: string, latitude = 32.762, longitude = -117.168) {
  return (await t.mutation(api.incidents.reportFromMap, { dispatcherToken, latitude, longitude, peopleCount: 2, reportedPosition: "roof", reportedAddress: address })) as Id<"incidents">;
}

/** A caller's incident, then the dispatcher confirms its location (so it awaits a team). */
async function callIncident(t: T, callId: string, address: string, extra: Record<string, unknown> = {}) {
  const r = await t.mutation(api.calls.upsertFromCall, {
    secret, callId, source: "live_demo", reportedAddress: address, peopleCount: 3, reportedPosition: "second floor",
    hazards: [], summary: "fictional", transcript: `Caller: ${address}`, ...extra,
  });
  const id = r.incidentId as Id<"incidents">;
  await t.mutation(api.incidents.verifyLocation, { dispatcherToken, incidentId: id, latitude: 32.762, longitude: -117.168 });
  return id;
}

async function fingerprint(t: T) {
  return await t.run(async (ctx) => {
    const ex = (await ctx.db.query("exercises").first())!;
    return planningFingerprint({
      waterSurfaceElevation: ex.waterSurfaceElevation,
      waterObservedAt: ex.waterObservedAt ?? null,
      incidents: (await ctx.db.query("incidents").collect()).map(incidentInput),
      teams: (await ctx.db.query("teams").collect()).map(teamInput),
    });
  });
}

/** A copy of `o` without the field `k`. */
function without<O extends object, K extends keyof O>(o: O, k: K): Omit<O, K> {
  const copy = { ...o };
  delete copy[k];
  return copy;
}

async function flood(t: T) {
  return await t.run(async (ctx) => floodFingerprint((await ctx.db.query("incidents").collect()).map((i) => ({ ...i, id: i._id }))));
}

/** Evidence shaped like the dashboard router's output for this team and incident. */
function evidence(team: Doc<"teams">, incident: Doc<"incidents">): RouteEvidence {
  const mover = moverFor(team.capabilities);
  const start = [team.longitude, team.latitude];
  const end = [incident.longitude!, incident.latitude!];
  const metres = Math.hypot((end[0] - start[0]) * 93_600, (end[1] - start[1]) * 111_320);
  if (mover === "air") return { mover, realSeconds: metres / 40, start, end, points: 2, modes: ["air"], maxDepth: 0, limit: null };
  return {
    mover, realSeconds: metres / 5, start, end, points: 6,
    modes: mover === "boat" ? ["road", "water", "foot"] : ["road", "foot"],
    maxDepth: 0.1, limit: PROFILES[mover].limit,
  };
}

/** Record a plan for these pairs from the current state, as the dashboard does. */
async function propose(t: T, pairs: [Id<"incidents">, Id<"teams">][], fp?: string) {
  const planId = `plan-${++planCounter}`;
  // The dashboard records the routes it shows, and keeps them for approval.
  const planned = await t.run(async (ctx) =>
    Promise.all(pairs.map(async ([incidentId, teamId]) => evidence((await ctx.db.get(teamId))!, (await ctx.db.get(incidentId))!))),
  );
  const matched = await t.mutation(api.planner.recordProposal, {
    dispatcherToken, planId, fingerprint: fp ?? (await fingerprint(t)), floodFingerprint: await flood(t),
    proposals: pairs.map(([incidentId, teamId], k) => ({
      incidentId, teamId, tier: "critical" as const, seconds: Math.round(planned[k].realSeconds), reason: "test", evidence: planned[k],
    })),
    unassigned: [],
  });
  return { planId, matched, pairs, planned };
}

async function approve(
  t: T,
  plan: { planId: string; pairs: [Id<"incidents">, Id<"teams">][]; planned: RouteEvidence[] },
  approvalId = `approval-${++planCounter}`,
  tweak: (e: RouteEvidence, k: number) => RouteEvidence = (e) => e,
) {
  const selected = plan.pairs.map(([incidentId, teamId], k) => ({
    incidentId, teamId, evidence: tweak(plan.planned[k] ?? plan.planned[0], k),
  }));
  return await t.mutation(api.planner.approvePlan, { dispatcherToken, planId: plan.planId, approvalId, selected });
}

const snapshot = (t: T) =>
  t.run(async (ctx) => ({
    incidents: (await ctx.db.query("incidents").collect()).map((i) => [i._id, i.status, i.assignedTeamId]),
    teams: (await ctx.db.query("teams").collect()).map((x) => [x._id, x.available, x.currentAssignment]),
    events: (await ctx.db.query("events").collect()).map((e) => e.type),
  }));
const assignmentEvents = async (t: T) =>
  (await t.run((ctx) => ctx.db.query("events").collect())).filter((e) => e.type === "assignment_approved");
const decisions = (t: T) => t.run((ctx) => ctx.db.query("planDecisions").collect());

describe("suggesting changes nothing", () => {
  test("recording a proposal leaves incidents, teams and caller updates untouched", async () => {
    const { t, boat } = await setup();
    const a = await callIncident(t, "call-a", "1 Fictional Way");
    const before = await snapshot(t);
    const plan = await propose(t, [[a, boat._id]]);
    expect(plan.matched).toEqual({ matched: true });
    expect(await snapshot(t)).toEqual(before);
    expect(await assignmentEvents(t)).toEqual([]);
  });
});

describe("approval", () => {
  test("assigns the batch through the normal path; caller and linked report hear it only now", async () => {
    const { t, boat, truck } = await setup();
    const a = await callIncident(t, "call-a", "1 Fictional Way");
    const linked = await callIncident(t, "call-a2", "1 Fictional Way, upstairs");
    await t.mutation(api.incidents.linkReports, { dispatcherToken, mainId: a, reportIds: [linked] });
    const b = await mapIncident(t, "2 Fictional Way");
    const plan = await propose(t, [[a, boat._id], [b, truck._id]]);
    expect(await assignmentEvents(t)).toEqual([]);

    expect(await approve(t, plan)).toEqual({ ok: true, outcome: "approved", assigned: 2 });
    const after = await t.run(async (ctx) => ({ a: await ctx.db.get(a), linked: await ctx.db.get(linked), b: await ctx.db.get(b), boat: await ctx.db.get(boat._id) }));
    expect(after.a).toMatchObject({ status: "assigned", assignedTeamId: boat._id });
    expect(after.linked).toMatchObject({ status: "assigned", assignedTeamId: boat._id, linkedTo: a });
    expect(after.b).toMatchObject({ status: "assigned", assignedTeamId: truck._id });
    expect(after.boat).toMatchObject({ available: false, currentAssignment: a });
    expect(after.boat!.trip ?? null).toBeNull(); // assigned, not sent: no trip starts
    // Approved updates for both callers (the map report has no caller); nobody is "en route".
    expect((await assignmentEvents(t)).map((e) => e.callId).sort()).toEqual(["call-a", "call-a2"]);
    expect((await t.run((ctx) => ctx.db.query("events").collect())).some((e) => e.type === "team_en_route")).toBe(false);
    expect((await decisions(t)).map((d) => d.outcome)).toEqual(["approved"]);
  });

  test("a retried approval returns the first result without assigning or announcing twice", async () => {
    const { t, boat } = await setup();
    const a = await callIncident(t, "call-a", "1 Fictional Way");
    const plan = await propose(t, [[a, boat._id]]);
    const first = await approve(t, plan, "same-approval");
    const again = await approve(t, plan, "same-approval");
    expect(again).toEqual(first);
    expect((await assignmentEvents(t)).length).toBe(1);
    expect((await decisions(t)).length).toBe(1);
    const assignedLines = (await t.run((ctx) => ctx.db.query("activity").collect())).filter((x) => x.message.includes("assigned to"));
    expect(assignedLines.length).toBe(1);
  });

  test("a second approval of an already-approved plan is refused and recorded", async () => {
    const { t, boat } = await setup();
    const a = await mapIncident(t, "1 Fictional Way");
    const plan = await propose(t, [[a, boat._id]]);
    await approve(t, plan);
    const second = await approve(t, plan);
    expect(second).toMatchObject({ ok: false, outcome: "rejected_stale" });
    expect((await decisions(t)).map((d) => d.outcome)).toEqual(["approved", "rejected_stale"]);
  });

  test("one bad pair rejects the whole batch: nothing assigned, nothing announced", async () => {
    const { t, boat, truck } = await setup();
    const a = await callIncident(t, "call-a", "1 Fictional Way");
    const b = await callIncident(t, "call-b", "2 Fictional Way");
    const plan = await propose(t, [[a, boat._id], [b, truck._id]]);
    const before = await snapshot(t);
    // The truck's "route" is a straight line: the flood-ignoring fallback, never eligible.
    const r = await approve(t, plan, undefined, (e, k) => (k === 1 ? { ...e, points: 2 } : e));
    expect(r).toMatchObject({ ok: false, outcome: "rejected_invalid" });
    expect((r as { reason: string }).reason).toMatch(/straight-line route/);
    expect(await snapshot(t)).toEqual(before);
    expect(await assignmentEvents(t)).toEqual([]);
  });

  test("pairs that weren't proposed, or a team picked twice, are refused", async () => {
    const { t, boat, truck } = await setup();
    const a = await mapIncident(t, "1 Fictional Way");
    const b = await mapIncident(t, "2 Fictional Way");
    const plan = await propose(t, [[a, boat._id], [b, truck._id]]);
    const notProposed = await approve(t, { ...plan, pairs: [[a, truck._id]] });
    expect((notProposed as { reason: string }).reason).toMatch(/not part of this plan/);
    const twice = await approve(t, { ...plan, pairs: [[a, boat._id], [a, boat._id]] });
    expect((twice as { reason: string }).reason).toMatch(/selected twice/);
  });
});

describe("stale plans are refused, with what changed", () => {
  const cases: [string, (t: T, ids: { a: Id<"incidents">; boat: Doc<"teams">; truck: Doc<"teams"> }) => Promise<void>, RegExp][] = [
    ["the team was assigned manually elsewhere", async (t, { boat }) => {
      const other = await mapIncident(t, "9 Elsewhere Rd");
      await t.mutation(api.incidents.assignTeam, { dispatcherToken, incidentId: other, teamId: boat._id });
    }, /Swift Water Boat 1: availability changed/],
    ["the river rose", async (t) => {
      await t.mutation(api.exercise.setWaterLevel, { dispatcherToken, meters: 11.5, observedAt: null });
    }, /river level changed/],
    ["the caller corrected their location", async (t) => {
      await t.mutation(api.calls.upsertFromCall, {
        secret, callId: "call-a", source: "live_demo", reportedAddress: "81 Other Rd (fictional)", peopleCount: 3,
        reportedPosition: "second floor", hazards: [], summary: "moved", transcript: "Caller: sorry, 81 Other Rd", locationChanged: true,
      });
    }, /"81 Other Rd \(fictional\)": (status|location confirmation) changed/],
    ["the caller withdrew a reported risk", async (t) => {
      await t.mutation(api.calls.upsertFromCall, {
        secret, callId: "call-a", source: "live_demo", reportedAddress: "1 Fictional Way", peopleCount: 3,
        reportedPosition: "second floor", hazards: [], summary: "fine", transcript: "Caller: nobody is hurt",
        withdrawn: [{ fact: "risk_factor", name: "serious_injury", evidence: "nobody is hurt" }],
      });
    }, /reported risks changed/],
    ["a new incident started waiting", async (t) => {
      await mapIncident(t, "5 New Rd");
    }, /incident "5 New Rd" is new/],
    ["the caller corrected the number of people", async (t) => {
      await t.mutation(api.calls.upsertFromCall, {
        secret, callId: "call-a", source: "live_demo", reportedAddress: "1 Fictional Way", peopleCount: 7,
        reportedPosition: "second floor", hazards: [], summary: "more people", transcript: "Caller: actually seven of us",
      });
    }, /"1 Fictional Way": number of people changed/],
    ["the number of people became unknown", async (t) => {
      await t.mutation(api.calls.upsertFromCall, {
        secret, callId: "call-a", source: "live_demo", reportedAddress: "1 Fictional Way", peopleCount: null,
        reportedPosition: "second floor", hazards: [], summary: "unsure", transcript: "Caller: I don't know how many",
        withdrawn: [{ fact: "people_count", name: null, evidence: "I don't know how many" }],
      });
    }, /"1 Fictional Way": number of people changed/],
    ["a resolved caller's water report changed the flood", async (t) => {
      const r = await callIncident(t, "call-r", "3 Resolved Way");
      await t.mutation(api.incidents.setStatus, { dispatcherToken, incidentId: r, status: "resolved" });
      await t.mutation(api.calls.upsertFromCall, {
        secret, callId: "call-r", source: "live_demo", reportedAddress: "3 Resolved Way", peopleCount: 3,
        reportedPosition: "second floor", hazards: [], summary: "water", transcript: "Caller: water is at my chest",
        waterReport: { level: "chest", floor: 0, evidence: "water is at my chest", measuredMeters: null },
      });
    }, /water report changed the simulated flood/],
  ];
  for (const [what, change, reason] of cases) {
    test(`${what}`, async () => {
      const { t, boat, truck } = await setup();
      const a = await callIncident(t, "call-a", "1 Fictional Way", {
        riskFactors: [{ factor: "serious_injury", evidence: "she's bleeding" }],
      });
      const plan = await propose(t, [[a, boat._id]]);
      await change(t, { a, boat, truck });
      const eventsBefore = (await assignmentEvents(t)).length;
      const r = await approve(t, plan);
      expect(r).toMatchObject({ ok: false, outcome: "rejected_stale" });
      expect((r as { reason: string }).reason).toMatch(reason);
      expect((await t.run((ctx) => ctx.db.get(a)))!.assignedTeamId).toBeNull();
      expect((await assignmentEvents(t)).length).toBe(eventsBefore);
      expect((await decisions(t)).at(-1)!.outcome).toBe("rejected_stale");
    });
  }

  test("a resolved report is set up before the plan: only its later water change stales it", async () => {
    // Guards the case above: resolving an incident before planning is not itself a change.
    const { t, boat } = await setup();
    const a = await callIncident(t, "call-a", "1 Fictional Way");
    const r = await callIncident(t, "call-r", "3 Resolved Way", {
      waterReport: { level: "knee", floor: 0, evidence: "knee deep", measuredMeters: null },
    });
    await t.mutation(api.incidents.setStatus, { dispatcherToken, incidentId: r, status: "resolved" });
    expect(await approve(t, await propose(t, [[a, boat._id]]))).toMatchObject({ ok: true });
  });

  test("a dashboard whose caller water reports differ from the server's is told it's behind", async () => {
    const { t, boat } = await setup();
    const a = await mapIncident(t, "1 Fictional Way");
    const planId = `plan-${++planCounter}`;
    const route = evidence(boat, (await t.run((ctx) => ctx.db.get(a)))!);
    const r = await t.mutation(api.planner.recordProposal, {
      dispatcherToken, planId, fingerprint: await fingerprint(t), floodFingerprint: "0000000000000000",
      proposals: [{ incidentId: a, teamId: boat._id, tier: "high", seconds: Math.round(route.realSeconds), reason: "test", evidence: route }],
      unassigned: [],
    });
    expect(r).toEqual({ matched: false });
    // The client's token is what's stored, not the server's current one.
    expect((await t.run((ctx) => ctx.db.query("assignmentPlans").first()))!.flood).toBe("0000000000000000");
  });

  test("a new proposal must carry its reviewed routes and the client's flood fingerprint", async () => {
    const { t, boat } = await setup();
    const a = await mapIncident(t, "1 Fictional Way");
    const route = evidence(boat, (await t.run((ctx) => ctx.db.get(a)))!);
    const complete = {
      dispatcherToken, planId: `plan-${++planCounter}`, fingerprint: await fingerprint(t), floodFingerprint: await flood(t),
      proposals: [{ incidentId: a, teamId: boat._id, tier: "high" as const, seconds: Math.round(route.realSeconds), reason: "test", evidence: route }],
      unassigned: [],
    };
    const noFlood = without(complete, "floodFingerprint");
    const noEvidence = { ...complete, proposals: complete.proposals.map((p) => without(p, "evidence")) };
    await expect(t.mutation(api.planner.recordProposal, noFlood as never)).rejects.toThrow(/floodFingerprint/);
    await expect(t.mutation(api.planner.recordProposal, noEvidence as never)).rejects.toThrow(/evidence/);
    expect(await t.run((ctx) => ctx.db.query("assignmentPlans").collect())).toEqual([]);
    expect(await t.mutation(api.planner.recordProposal, complete)).toEqual({ matched: true });
  });

  for (const missing of ["evidence", "flood"] as const) {
    test(`an older record without its ${missing === "evidence" ? "reviewed route" : "flood fingerprint"} can't be approved`, async () => {
      const { t, boat } = await setup();
      const a = await mapIncident(t, "1 Fictional Way");
      const plan = await propose(t, [[a, boat._id]]);
      // Strip the binding from the stored row, as rows recorded before it was required lack it.
      await t.run(async (ctx) => {
        const row = (await ctx.db.query("assignmentPlans").withIndex("by_planId", (q) => q.eq("planId", plan.planId)).unique())!;
        if (missing === "flood") await ctx.db.replace(row._id, { ...row, flood: undefined });
        else await ctx.db.patch(row._id, { proposals: row.proposals.map((p) => without(p, "evidence")) });
      });
      const before = await snapshot(t);
      const r = await approve(t, plan);
      expect(r).toMatchObject(
        missing === "flood"
          ? { ok: false, outcome: "rejected_stale", reason: expect.stringMatching(/recorded without the flood data/) }
          : { ok: false, outcome: "rejected_invalid", reason: expect.stringMatching(/no reviewed route was recorded/) },
      );
      expect(await snapshot(t)).toEqual(before);
    });
  }

  test("a plan made from out-of-date dashboard data can't be approved", async () => {
    const { t, boat } = await setup();
    const a = await mapIncident(t, "1 Fictional Way");
    const plan = await propose(t, [[a, boat._id]], "0000000000000000");
    expect(plan.matched).toEqual({ matched: false });
    expect(await approve(t, plan)).toMatchObject({ ok: false, outcome: "rejected_stale" });
  });

  test("two approvals racing for the same team: one wins, the other is refused as stale", async () => {
    const { t, boat } = await setup();
    const a = await mapIncident(t, "1 Fictional Way");
    const b = await mapIncident(t, "2 Fictional Way");
    const planA = await propose(t, [[a, boat._id]]);
    const planB = await propose(t, [[b, boat._id]]);
    const results = await Promise.all([approve(t, planA), approve(t, planB)]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ outcome: "rejected_stale" });
    const boatNow = (await t.run((ctx) => ctx.db.get(boat._id)))!;
    expect([a, b]).toContain(boatNow.currentAssignment);
  });
});

describe("approval IDs and reviewed routes", () => {
  test("reusing an approval ID for a different selection, plan or route is refused and applies nothing", async () => {
    const { t, boat, truck } = await setup();
    const a = await mapIncident(t, "1 Fictional Way");
    const b = await mapIncident(t, "2 Fictional Way");
    const plan = await propose(t, [[a, boat._id], [b, truck._id]]);
    const other = await propose(t, [[b, truck._id]]);
    const only = { ...plan, pairs: plan.pairs.slice(0, 1) };
    expect(await approve(t, only, "id-1")).toMatchObject({ ok: true, assigned: 1 });
    const before = await snapshot(t);
    for (const attempt of [
      () => approve(t, plan, "id-1"), // same plan, bigger selection
      () => approve(t, other, "id-1"), // another plan
      () => approve(t, only, "id-1", (e) => ({ ...e, points: e.points + 1 })), // another route
    ]) {
      const r = await attempt();
      expect(r).toMatchObject({ ok: false, outcome: "rejected_invalid" });
      expect((r as { reason: string }).reason).toMatch(/already used for a different request/);
    }
    expect(await snapshot(t)).toEqual(before);
    expect((await decisions(t)).filter((d) => d.approvalId === "id-1")).toHaveLength(1);
    // The identical retry still gets its original receipt.
    expect(await approve(t, only, "id-1")).toEqual({ ok: true, outcome: "approved", assigned: 1 });
  });

  test("a route other than the reviewed one is refused, even if well formed", async () => {
    const { t, boat } = await setup();
    const a = await mapIncident(t, "1 Fictional Way");
    const plan = await propose(t, [[a, boat._id]]);
    for (const tweak of [
      (e: RouteEvidence) => ({ ...e, points: e.points + 3 }),
      (e: RouteEvidence) => ({ ...e, maxDepth: 0.2 }),
      (e: RouteEvidence) => ({ ...e, modes: ["road", "foot"] as RouteEvidence["modes"] }),
    ]) {
      const r = await approve(t, plan, undefined, tweak);
      expect(r).toMatchObject({ ok: false, outcome: "rejected_invalid" });
      expect((r as { reason: string }).reason).toMatch(/differs from the one that was reviewed/);
    }
    const slower = await approve(t, plan, undefined, (e) => ({ ...e, realSeconds: e.realSeconds + 120 }));
    expect((slower as { reason: string }).reason).toMatch(/route time differs from the proposal that was reviewed/);
    expect((await t.run((ctx) => ctx.db.get(a)))!.assignedTeamId).toBeNull();
    expect(await approve(t, plan)).toMatchObject({ ok: true });
  });
});
