import { ConvexHttpClient } from "convex/browser";
import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { floodFingerprint, incidentInput, planningFingerprint, teamInput, type RouteEvidence, pairBasis } from "../convex/planning";
import { moverFor, PROFILES } from "../convex/vehicles";

// Real concurrent approvals against a disposable local Convex (true transaction conflicts,
// unlike convex-test). Runs only under scripts/integration/local_convex.sh:
//   LIFELINE_LOCAL_CONVEX_PORT=3480 scripts/integration/local_convex.sh \
//     bash -c 'cd dashboard && npx vitest run tests/plannerLive.test.ts'
const url = process.env.LIFELINE_LOCAL_CONVEX_URL;
const local = url && /^http:\/\/(127\.0\.0\.1|localhost):/.test(url);
const dispatcherToken = process.env.LIFELINE_LOCAL_DISPATCHER_TOKEN;

describe.skipIf(!local)("approvals on a real local Convex", () => {
  // Created lazily: describe bodies run during collection even when skipped.
  let client: ConvexHttpClient;
  const state = async () => (await client.query(api.exercise.get, { dispatcherToken }))!;
  const fingerprint = async () => {
    const s = await state();
    return planningFingerprint({
      waterSurfaceElevation: s.exercise.waterSurfaceElevation,
      waterObservedAt: s.exercise.waterObservedAt ?? null,
      incidents: s.incidents.map(incidentInput),
      teams: s.teams.map(teamInput),
    });
  };
  const evidence = (team: Doc<"teams">, incident: Doc<"incidents">): RouteEvidence => {
    const mover = moverFor(team.capabilities);
    const start = [team.longitude, team.latitude];
    const end = [incident.longitude!, incident.latitude!];
    const metres = Math.hypot((end[0] - start[0]) * 93_600, (end[1] - start[1]) * 111_320);
    return mover === "air"
      ? { mover, realSeconds: metres / 40, start, end, points: 2, modes: ["air"], maxDepth: 0, limit: null }
      : { mover, realSeconds: metres / 5, start, end, points: 6, modes: mover === "boat" ? ["road", "water", "foot"] : ["road", "foot"],
          maxDepth: 0.1, limit: PROFILES[mover].limit };
  };

  test("two dispatchers approve plans that both use the same team: exactly one wins", async () => {
    client = new ConvexHttpClient(url!);
    if (!(await client.query(api.exercise.get, { dispatcherToken }))) await client.mutation(api.exercise.ensureSeeded, { dispatcherToken });
    const tag = Math.random().toString(36).slice(2, 8);
    const report = (n: number) =>
      client.mutation(api.incidents.reportFromMap, {
        dispatcherToken, latitude: 32.762, longitude: -117.168, peopleCount: 2, reportedPosition: "roof",
        reportedAddress: `${n} Race Rd ${tag} (fictional)`,
      }) as Promise<Id<"incidents">>;
    const [a, b] = [await report(1), await report(2)];
    const s = await state();
    const team = s.teams.find((t) => t.available && !t.trip)!;
    const fp = await fingerprint();
    const plan = async (incidentId: Id<"incidents">) => {
      const planId = `live-${tag}-${incidentId}`;
      const route = evidence(team, s.incidents.find((i) => i._id === incidentId)!);
      const seen = {
        waterSurfaceElevation: s.exercise.waterSurfaceElevation, waterObservedAt: s.exercise.waterObservedAt ?? null,
        incidents: s.incidents.map(incidentInput), teams: s.teams.map(teamInput),
      };
      await client.mutation(api.planner.recordProposal, {
        dispatcherToken, planId, fingerprint: fp, floodFingerprint: floodFingerprint(s.incidents.map((i) => ({ ...i, id: i._id }))),
        water: seen.waterSurfaceElevation,
        proposals: [{
          incidentId, teamId: team._id, tier: "high", seconds: Math.round(route.realSeconds), reason: "race", evidence: route,
          basis: pairBasis(seen, incidentId, team._id),
        }],
        unassigned: [],
      });
      return { planId, selected: [{ incidentId, teamId: team._id, evidence: route }] };
    };
    const [pa, pb] = [await plan(a), await plan(b)];
    // Separate clients so the two mutations really run at the same time.
    const other = new ConvexHttpClient(url!);
    const results = await Promise.all([
      client.mutation(api.planner.approvePlan, { dispatcherToken, ...pa, approvalId: `${pa.planId}-ok` }),
      other.mutation(api.planner.approvePlan, { dispatcherToken, ...pb, approvalId: `${pb.planId}-ok` }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ outcome: "rejected_stale" });
    const after = await state();
    const assignedToTeam = after.incidents.filter((i) => i.assignedTeamId === team._id && [a, b].includes(i._id));
    expect(assignedToTeam).toHaveLength(1);
    expect(after.teams.find((t) => t._id === team._id)!.currentAssignment).toBe(assignedToTeam[0]._id);
    // A retry of the winning approval changes nothing.
    const winner = results[0].ok ? pa : pb;
    expect(await client.mutation(api.planner.approvePlan, { dispatcherToken, ...winner, approvalId: `${winner.planId}-ok` })).toMatchObject({ ok: true });
    expect((await state()).incidents.filter((i) => i.assignedTeamId === team._id && [a, b].includes(i._id))).toHaveLength(1);
    // Leave the disposable deployment as found: resolving frees the team for other suites.
    for (const incidentId of [a, b]) await client.mutation(api.incidents.setStatus, { dispatcherToken, incidentId, status: "resolved" });
  });
});
