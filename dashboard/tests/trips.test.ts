import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { MIN_TRIP_MS, TRIP_SPEEDUP, vehiclePosition } from "../convex/tripMath";

const modules = import.meta.glob("../convex/**/*.ts");
const dispatcherToken = "isolated-dispatcher-only";

beforeEach(() => {
  process.env.DISPATCHER_TOKEN = dispatcherToken;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** A seeded exercise with one verified incident assigned to a team of the given kind. */
async function assigned(kind: Doc<"teams">["capabilities"][number]) {
  const t = convexTest(schema, modules);
  await t.mutation(api.exercise.ensureSeeded, { dispatcherToken, withSamples: true });
  const { incident, team } = await t.run(async (ctx) => {
    const incidents = await ctx.db.query("incidents").collect();
    const teams = await ctx.db.query("teams").collect();
    return {
      incident: incidents.find((i) => i.status === "awaiting_assignment" && i.locationVerified && !i.linkedTo)!,
      team: teams.find((x) => x.available && x.capabilities.includes(kind))!,
    };
  });
  await t.mutation(api.incidents.assignTeam, { dispatcherToken, incidentId: incident._id, teamId: team._id });
  const from = [team.longitude, team.latitude];
  const to = [incident.longitude!, incident.latitude!];
  const plan = (realSeconds: number, via = [(from[0] + to[0]) / 2, from[1]]) => ({
    path: [from, via, to],
    legs: [
      { mode: "road" as const, end: 1 },
      { mode: "foot" as const, end: 2 },
    ],
    realSeconds,
  });
  const getTeam = () => t.run((ctx) => ctx.db.get(team._id));
  return { t, incident, team, from, to, plan, getTeam };
}

describe("simulated team trips", () => {
  test("a planned route is stored, played faster than real time, and parks where the crew walks in", async () => {
    const { t, incident, from, to, plan, getTeam } = await assigned("high_water_vehicle");
    await t.mutation(api.incidents.setStatus, {
      dispatcherToken, incidentId: incident._id, status: "en_route", plan: plan(240),
    });
    const moving = await getTeam();
    expect(moving!.trip).toMatchObject({ route: "planned", realSeconds: 240, incidentId: incident._id });
    expect(moving!.trip!.arriveAt - moving!.trip!.departAt).toBe(Math.max(MIN_TRIP_MS, (240 * 1000) / TRIP_SPEEDUP));

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const arrived = await getTeam();
    // The vehicle stays at the end of the road leg; only the crew walks on to the building.
    expect(arrived).toMatchObject({ trip: null, longitude: (from[0] + to[0]) / 2, latitude: from[1], available: false });
    const log = await t.run((ctx) => ctx.db.query("activity").collect());
    expect(log.map((a) => a.message).join("\n")).toMatch(/arrived at/);
  });

  test("unassigning mid-trip leaves the team part way along its path", async () => {
    const { t, incident, from, to, plan, getTeam } = await assigned("high_water_vehicle");
    await t.mutation(api.incidents.setStatus, {
      dispatcherToken, incidentId: incident._id, status: "en_route", plan: plan(600),
    });
    vi.advanceTimersByTime((600 * 1000) / TRIP_SPEEDUP / 2);
    await t.mutation(api.incidents.setStatus, { dispatcherToken, incidentId: incident._id, status: "awaiting_assignment" });
    const stopped = await getTeam();
    expect(stopped).toMatchObject({ trip: null, available: true });
    expect(stopped!.longitude).not.toBe(from[0]);
    expect(stopped!.longitude).not.toBe(to[0]);

    // The arrival scheduled for the cancelled trip does nothing.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await getTeam())!.longitude).toBe(stopped!.longitude);
  });

  test("re-routing replaces the trip and only the new arrival counts", async () => {
    const { t, incident, team, from, to, plan, getTeam } = await assigned("high_water_vehicle");
    await t.mutation(api.incidents.setStatus, {
      dispatcherToken, incidentId: incident._id, status: "en_route", plan: plan(600),
    });
    vi.advanceTimersByTime(5_000);
    const first = (await getTeam())!.trip!;
    await t.mutation(api.trips.reroute, { dispatcherToken, teamId: team._id, plan: plan(900, [from[0], to[1]]) });
    const second = (await getTeam())!.trip!;
    expect(second.departAt).toBeGreaterThan(first.departAt);
    expect(second.realSeconds).toBe(900);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Parked at the end of the new route's road leg.
    expect(await getTeam()).toMatchObject({ trip: null, longitude: from[0], latitude: to[1] });
  });

  test("without a dashboard route, a boat falls back to a direct water trip", async () => {
    const { t, incident, getTeam } = await assigned("boat");
    await t.mutation(api.incidents.setStatus, { dispatcherToken, incidentId: incident._id, status: "en_route" });
    vi.runOnlyPendingTimers(); // starts the fallback planner, not the arrival it schedules
    await t.finishInProgressScheduledFunctions();
    const trip = (await getTeam())!.trip!;
    expect(trip).toMatchObject({ route: "direct", legs: [{ mode: "water", end: 1 }] });
    expect(trip.path).toHaveLength(2);
  });
});

describe("reset", () => {
  test("starts with teams and no incidents unless samples are asked for", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.exercise.reset, { dispatcherToken });
    const empty = await t.query(api.exercise.get, { dispatcherToken });
    expect(empty!.incidents).toHaveLength(0);
    expect(empty!.teams.every((team) => team.available)).toBe(true);
    await t.mutation(api.exercise.reset, { dispatcherToken, withSamples: true });
    expect((await t.query(api.exercise.get, { dispatcherToken }))!.incidents.length).toBeGreaterThan(0);
  });
});

describe("vehiclePosition", () => {
  // Road for two segments, then the crew walks the last one into the building.
  const trip = {
    path: [[0, 0], [0.001, 0], [0.002, 0], [0.002, 0.001]],
    legs: [{ mode: "road" as const, end: 2 }, { mode: "foot" as const, end: 3 }],
    departAt: 0,
    arriveAt: 3000,
  };
  test("follows the road, then stays parked while the crew walks in", () => {
    expect(vehiclePosition(trip, 500)[0]).toBeGreaterThan(0);
    expect(vehiclePosition(trip, 500)[1]).toBe(0);
    expect(vehiclePosition(trip, 2900)).toEqual([0.002, 0]);
    expect(vehiclePosition(trip, 3000)).toEqual([0.002, 0]);
  });
});
