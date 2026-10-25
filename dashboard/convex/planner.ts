import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { assignTeamTo } from "./incidents";
import { logActivity, requireDispatcher } from "./lib";
import {
  changesBetween,
  checkRouteEvidence,
  fingerprintOf,
  floodFingerprint,
  incidentInput,
  pairBasis,
  planningFingerprint,
  snapshotOf,
  teamInput,
  WATER_TOLERANCE_M,
  type PlanningInputs,
} from "./planning";
import { priorityTier, routeEvidence } from "./schema";
import { EXERCISE_ID } from "./seedData";

// Dispatcher-reviewed assignment plans (src/lib/planner.ts computes them in the dashboard).
// Suggesting a plan changes nothing. Approval re-checks the selected assignments against the
// database, refuses one whose incident, linked reports or team changed since it was planned
// (or if the river moved more than WATER_TOLERANCE_M), or with routes other than the ones the
// dispatcher reviewed, and applies the whole batch in one transaction through the normal
// assignment path, or nothing at all. Changes elsewhere don't stale a plan: in a busy
// exercise something changes every second.

async function currentState(ctx: QueryCtx) {
  const exercise = await ctx.db
    .query("exercises")
    .withIndex("by_exerciseId", (q) => q.eq("exerciseId", EXERCISE_ID))
    .unique();
  if (!exercise) throw new ConvexError("No exercise loaded");
  const [incidents, teams] = await Promise.all([
    ctx.db.query("incidents").withIndex("by_exercise", (q) => q.eq("exerciseId", EXERCISE_ID)).collect(),
    ctx.db.query("teams").withIndex("by_exercise", (q) => q.eq("exerciseId", EXERCISE_ID)).collect(),
  ]);
  const inputs: PlanningInputs = {
    waterSurfaceElevation: exercise.waterSurfaceElevation,
    waterObservedAt: exercise.waterObservedAt ?? null,
    incidents: incidents.map(incidentInput),
    teams: teams.map(teamInput),
  };
  const names = new Map<string, string>([
    ...incidents.map((i) => [i._id, `"${i.reportedAddress}"`] as [string, string]),
    ...teams.map((t) => [t._id, t.name] as [string, string]),
  ]);
  const flood = floodFingerprint(incidents.map((i) => ({ ...i, id: i._id })));
  return { inputs, fingerprint: planningFingerprint(inputs), flood, incidents, teams, names };
}

/** Record what the dispatcher was shown. Touches no incident, team or caller update. */
export const recordProposal = mutation({
  args: {
    dispatcherToken: v.optional(v.string()),
    planId: v.string(),
    fingerprint: v.string(),
    /** The dashboard's floodFingerprint: the caller water reports it planned with. */
    floodFingerprint: v.string(),
    /** River level the dashboard planned with. */
    water: v.number(),
    proposals: v.array(
      v.object({
        incidentId: v.id("incidents"),
        teamId: v.id("teams"),
        tier: priorityTier,
        seconds: v.number(),
        reason: v.string(),
        /** The route the dispatcher is shown; approval must send this same route. */
        evidence: routeEvidence,
        /** pairBasis of the incident and team as the dashboard saw them. */
        basis: v.string(),
      }),
    ),
    unassigned: v.array(v.object({ incidentId: v.id("incidents"), reason: v.string() })),
  },
  handler: async (ctx, { dispatcherToken, planId, fingerprint, floodFingerprint: flood, water, proposals, unassigned }) => {
    requireDispatcher(dispatcherToken);
    const existing = await ctx.db.query("assignmentPlans").withIndex("by_planId", (q) => q.eq("planId", planId)).unique();
    if (existing) return { matched: existing.matchedServer };
    const state = await currentState(ctx);
    // Whether the dashboard saw the latest data for everything this plan proposes.
    const matched =
      Math.abs(water - state.inputs.waterSurfaceElevation) <= WATER_TOLERANCE_M &&
      proposals.every((p) => p.basis === pairBasis(state.inputs, p.incidentId, p.teamId));
    await ctx.db.insert("assignmentPlans", {
      exerciseId: EXERCISE_ID,
      planId,
      fingerprint,
      matchedServer: matched,
      inputs: snapshotOf(state.inputs),
      flood, // the client's, never filled in from the server's current state
      water,
      proposals,
      unassigned,
      status: "proposed",
      createdAt: Date.now(),
    });
    return { matched };
  },
});

const proposedPair = (plan: Doc<"assignmentPlans">, incidentId: Id<"incidents">, teamId: Id<"teams">) =>
  plan.proposals.find((p) => p.incidentId === incidentId && p.teamId === teamId);

export type ApprovalResult =
  | { ok: true; outcome: "approved"; assigned: number }
  | { ok: false; outcome: "rejected_stale" | "rejected_invalid"; reason: string };

/**
 * Approve the selected proposals of a plan. Idempotent per approvalId: a retry of the same
 * request returns the first attempt's result without assigning anything again or queueing
 * more caller updates. Reusing an approvalId for a different plan, selection or route is
 * refused and applies nothing.
 */
export const approvePlan = mutation({
  args: {
    dispatcherToken: v.optional(v.string()),
    planId: v.string(),
    approvalId: v.string(),
    selected: v.array(v.object({ incidentId: v.id("incidents"), teamId: v.id("teams"), evidence: routeEvidence })),
  },
  handler: async (ctx, { dispatcherToken, planId, approvalId, selected }): Promise<ApprovalResult> => {
    requireDispatcher(dispatcherToken);
    const request = fingerprintOf({ planId, selected });
    const prior = await ctx.db.query("planDecisions").withIndex("by_approvalId", (q) => q.eq("approvalId", approvalId)).unique();
    if (prior) {
      if (prior.request !== request) {
        const reason = "this approval ID was already used for a different request. Nothing was applied for this one; approve again.";
        await logActivity(ctx, `Planned assignments not applied: ${reason}`);
        return { ok: false, outcome: "rejected_invalid", reason };
      }
      return prior.outcome === "approved"
        ? { ok: true, outcome: "approved", assigned: prior.selected.length }
        : { ok: false, outcome: prior.outcome, reason: prior.reason ?? "" };
    }
    const plan = await ctx.db.query("assignmentPlans").withIndex("by_planId", (q) => q.eq("planId", planId)).unique();
    if (!plan) throw new ConvexError("Unknown plan; suggest assignments again");
    const pairs = selected.map(({ incidentId, teamId }) => ({ incidentId, teamId }));

    // Writes only the decision record; nothing about incidents or teams changes.
    const refuse = async (outcome: "rejected_stale" | "rejected_invalid", reason: string): Promise<ApprovalResult> => {
      await ctx.db.insert("planDecisions", { exerciseId: EXERCISE_ID, approvalId, planId, outcome, reason, selected: pairs, request, at: Date.now() });
      await logActivity(ctx, `Planned assignments not applied: ${reason}`);
      return { ok: false, outcome, reason };
    };

    if (plan.status === "approved") return refuse("rejected_stale", "this plan was already approved. Suggest assignments again for the rest.");
    if (!selected.length) return refuse("rejected_invalid", "no assignments were selected.");
    const state = await currentState(ctx);
    // Plans recorded before route, flood and per-proposal bindings were required can't be approved.
    if (plan.flood === undefined || plan.water === undefined) {
      return refuse("rejected_stale", "this plan was recorded without the flood data it used. Suggest assignments again.");
    }
    const rose = state.inputs.waterSurfaceElevation - plan.water;
    if (Math.abs(rose) > WATER_TOLERANCE_M) {
      return refuse(
        "rejected_stale",
        `the river level changed (${rose > 0 ? "up" : "down"} ${Math.abs(rose).toFixed(2)} m since the plan was made), so its routes are out of date. Suggest assignments again.`,
      );
    }

    // Each selected proposal must have been planned from what is in the database now.
    const outdated = selected.filter(({ incidentId, teamId }) => {
      const reviewed = proposedPair(plan, incidentId, teamId);
      return reviewed?.basis !== undefined && reviewed.basis !== pairBasis(state.inputs, incidentId, teamId);
    });
    if (outdated.length) {
      const scope = { incidents: new Set<string>(outdated.map((s) => s.incidentId)), teams: new Set<string>(outdated.map((s) => s.teamId)) };
      const what = changesBetween(plan.inputs, state.inputs, state.names, scope);
      if (!what.length) {
        return refuse("rejected_stale", "the dashboard was behind the latest data when this plan was made. Suggest assignments again.");
      }
      return refuse("rejected_stale", `things changed since the plan was made (${what.slice(0, 4).join("; ")}). Suggest assignments again.`);
    }

    // Same inputs as when planned: still check every pair against the database itself.
    const proposed = new Map(plan.proposals.map((p) => [`${p.incidentId}|${p.teamId}`, p]));
    const problems: string[] = [];
    const seenIncidents = new Set<Id<"incidents">>();
    const seenTeams = new Set<Id<"teams">>();
    const ready: [Doc<"incidents">, Doc<"teams">][] = [];
    for (const { incidentId, teamId, evidence } of selected) {
      const incident = state.incidents.find((i) => i._id === incidentId);
      const team = state.teams.find((t) => t._id === teamId);
      const label = `${incident ? `"${incident.reportedAddress}"` : "an incident"} → ${team?.name ?? "a team"}`;
      const fail = (why: string) => problems.push(`${label}: ${why}`);
      const reviewed = proposed.get(`${incidentId}|${teamId}`);
      if (!reviewed) fail("not part of this plan");
      else if (seenIncidents.has(incidentId) || seenTeams.has(teamId)) fail("selected twice");
      else if (!incident || !team) fail("no longer exists");
      else if (incident.linkedTo) fail("is a linked report; it follows its main incident");
      else if (incident.status !== "awaiting_assignment" || incident.assignedTeamId) fail("isn't waiting for a team");
      else if (!incident.locationVerified) fail("location isn't confirmed");
      else if (!team.available || team.currentAssignment || team.trip) fail(`${team.name} isn't available`);
      else {
        const routeProblem = checkRouteEvidence(team, incident, evidence);
        if (routeProblem) fail(routeProblem);
        else if (!reviewed.evidence || reviewed.basis === undefined) fail("no reviewed route was recorded for it; suggest assignments again");
        else if (Math.round(evidence.realSeconds) !== Math.round(reviewed.seconds)) {
          fail("route time differs from the proposal that was reviewed; suggest assignments again");
        } else if (fingerprintOf(reviewed.evidence) !== fingerprintOf(evidence)) {
          fail("route differs from the one that was reviewed; suggest assignments again");
        } else ready.push([incident, team]);
      }
      seenIncidents.add(incidentId);
      seenTeams.add(teamId);
    }
    if (problems.length) return refuse("rejected_invalid", problems.join("; "));

    // All checks passed before any write: apply the whole batch in this one transaction.
    for (const [incident, team] of ready) await assignTeamTo(ctx, incident, team);
    await ctx.db.patch(plan._id, { status: "approved" });
    await ctx.db.insert("planDecisions", { exerciseId: EXERCISE_ID, approvalId, planId, outcome: "approved", reason: null, selected: pairs, request, at: Date.now() });
    await logActivity(ctx, `Dispatcher approved ${ready.length} planned assignment${ready.length === 1 ? "" : "s"} (simulated plan).`);
    return { ok: true, outcome: "approved", assigned: ready.length };
  },
});

/** Recent plans and approval attempts, newest first (audit trail). */
export const recentDecisions = query({
  args: { dispatcherToken: v.optional(v.string()) },
  handler: async (ctx, { dispatcherToken }) => {
    requireDispatcher(dispatcherToken);
    return await ctx.db.query("planDecisions").withIndex("by_exercise", (q) => q.eq("exerciseId", EXERCISE_ID)).order("desc").take(20);
  },
});
