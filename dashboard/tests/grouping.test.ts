import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { nearbyReports } from "../src/lib/grouping";
import type { Incident } from "../src/lib/types";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "isolated-fixture-only";
const dispatcherToken = "isolated-dispatcher-only";
const HOTEL = { candidateLatitude: 32.7612, candidateLongitude: -117.1725, candidateLabel: "Map search: Fictional Harbor Hotel" };

beforeEach(() => {
  process.env.BACKEND_SECRET = secret;
  process.env.DISPATCHER_TOKEN = dispatcherToken;
});

type Report = {
  address: string;
  position: string;
  people?: number;
  role?: "trapped" | "witness";
  pin?: { candidateLatitude: number; candidateLongitude: number; candidateLabel: string };
};

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.exercise.ensureSeeded, { dispatcherToken });
  const say = async (callId: string, r: Report) =>
    (
      await t.mutation(api.calls.upsertFromCall, {
        secret, callId, source: "live_demo", reportedAddress: r.address, peopleCount: r.people ?? 2,
        reportedPosition: r.position, hazards: [], summary: "fictional", transcript: `Caller: ${r.position}`,
        callerRole: r.role ?? "trapped", ...(r.pin ?? {}),
      })
    ).incidentId as Id<"incidents">;
  const get = (id: Id<"incidents">) => t.run((ctx) => ctx.db.get(id));
  const place = (incidentId: Id<"incidents">, latitude: number, longitude: number) =>
    t.mutation(api.incidents.verifyLocation, { dispatcherToken, incidentId, latitude, longitude });
  const activity = async () => (await t.run((ctx) => ctx.db.query("activity").collect())).map((a) => a.message);
  return { t, say, get, place, activity };
}

describe("automatic grouping needs building identity, not proximity", () => {
  test("different addresses ~22 m apart, both two people on the second floor, stay separate rescues", async () => {
    const { t, say, get, place } = await setup();
    const a = await say("a", { address: "12 Lantern Lane (fictional)", position: "second floor" });
    const b = await say("b", { address: "14 Lantern Lane (fictional)", position: "second floor" });
    await place(a, 32.76, -117.17);
    await place(b, 32.7602, -117.17); // ~22 m north
    expect((await get(a))!.linkedTo ?? null).toBeNull();
    expect((await get(b))!.linkedTo ?? null).toBeNull();
    // Still offered to the dispatcher to confirm, rather than decided for them.
    const all = (await t.query(api.exercise.get, { dispatcherToken }))!.incidents.map(
      (i) => ({ ...i, id: i._id }) as unknown as Incident,
    );
    const suggestion = nearbyReports(all.find((i) => i.id === a)!, all).find((n) => n.incident.id === b);
    expect(suggestion?.relation).toBe("possibly_same");
  });

  test("same floor and headcount at the same address is ambiguous: no automatic link", async () => {
    const { say, get } = await setup();
    const a = await say("a", { address: "Fictional Harbor Hotel", position: "third floor", pin: HOTEL });
    const b = await say("b", { address: "Fictional Harbor Hotel", position: "3rd floor", pin: HOTEL });
    const c = await say("c", { address: "Fictional Harbor Hotel", position: "third floor", pin: HOTEL });
    for (const id of [a, b, c]) expect((await get(id))!.linkedTo ?? null).toBeNull();
  });

  test("same room at the same hotel is still linked automatically", async () => {
    const { say, get } = await setup();
    const a = await say("a", { address: "Fictional Harbor Hotel", position: "room 312", pin: HOTEL });
    const b = await say("b", { address: "the Fictional Harbor Hotel", position: "Room 312, third floor", pin: HOTEL });
    expect((await get(b))!.linkedTo).toBe(a);
    expect((await get(b))!.linkNote).toBe("Auto-linked: same room 312");
  });

  test("a witness links to the only rescue at the same building, not to a neighbour's", async () => {
    const { say, get, place } = await setup();
    const rescue = await say("r", { address: "12 Lantern Lane (fictional)", position: "roof" });
    await place(rescue, 32.76, -117.17);
    const neighbour = await say("n", { address: "14 Lantern Lane (fictional)", position: "street", role: "witness" });
    await place(neighbour, 32.7602, -117.17);
    expect((await get(neighbour))!.linkedTo ?? null).toBeNull();
    const sameHouse = await say("s", { address: "12 Lantern Lane, fictional", position: "street", role: "witness" });
    await place(sameHouse, 32.76001, -117.17);
    expect((await get(sameHouse))!.linkedTo).toBe(rescue);
  });
});

describe("automatic links are re-checked when the caller's facts change", () => {
  async function linkedRoom312() {
    const s = await setup();
    const main = await s.say("a", { address: "Fictional Harbor Hotel", position: "room 312", pin: HOTEL });
    const report = await s.say("b", { address: "Fictional Harbor Hotel", position: "room 312", pin: HOTEL });
    expect((await s.get(report))!.linkedTo).toBe(main);
    // The main rescue gets a team; the linked report mirrors it.
    const team = await s.t.run((ctx) => ctx.db.query("teams").first());
    await s.t.mutation(api.incidents.verifyLocation, { dispatcherToken, incidentId: main });
    await s.t.mutation(api.incidents.assignTeam, { dispatcherToken, incidentId: main, teamId: team!._id });
    expect((await s.get(report))!).toMatchObject({ status: "assigned", assignedTeamId: team!._id });
    return { ...s, main, report, team: team! };
  }

  test("a caller correcting room 312 to 410 becomes their own rescue without the other team", async () => {
    const { say, get, activity, main, report, team } = await linkedRoom312();
    await say("b", { address: "Fictional Harbor Hotel", position: "room 410", pin: HOTEL });
    const corrected = (await get(report))!;
    expect(corrected).toMatchObject({ linkedTo: null, linkNote: null, assignedTeamId: null, reportedPosition: "room 410" });
    expect(["needs_review", "awaiting_assignment"]).toContain(corrected.status);
    expect((await get(main))!).toMatchObject({ status: "assigned", assignedTeamId: team._id }); // untouched
    expect((await activity()).some((m) => m.startsWith("Automatic link removed after the caller's position"))).toBe(true);
  });

  test("a corrected report joins the rescue its new room actually matches", async () => {
    const { say, get, report } = await linkedRoom312();
    const room410 = await say("c", { address: "Fictional Harbor Hotel", position: "room 410", pin: HOTEL });
    await say("b", { address: "Fictional Harbor Hotel", position: "room 410", pin: HOTEL });
    // Grouped with the room 410 rescue (the older report stays main, per pickMain).
    const [r, c] = [(await get(report))!, (await get(room410))!];
    expect(r.linkedTo === room410 || c.linkedTo === report).toBe(true);
    expect(c.linkNote ?? r.linkNote).toBe("Auto-linked: same room 410");
  });

  test("the main incident changing room releases automatically linked reports", async () => {
    const { say, get, report } = await linkedRoom312();
    await say("a", { address: "Fictional Harbor Hotel", position: "room 518", pin: HOTEL });
    expect((await get(report))!).toMatchObject({ linkedTo: null, assignedTeamId: null });
  });

  test("a dispatcher's own link is kept and flagged, not silently undone", async () => {
    const { t, say, get, place, activity } = await setup();
    const a = await say("a", { address: "12 Lantern Lane (fictional)", position: "second floor" });
    const b = await say("b", { address: "14 Lantern Lane (fictional)", position: "second floor" });
    await place(a, 32.76, -117.17);
    await place(b, 32.7602, -117.17);
    await t.mutation(api.incidents.linkReports, { dispatcherToken, mainId: a, reportIds: [b] });
    await say("b", { address: "14 Lantern Lane (fictional)", position: "attic" });
    expect((await get(b))!.linkedTo).toBe(a);
    expect((await activity()).some((m) => m.includes("for a report you linked; check"))).toBe(true);
  });

  test("an unchanged turn doesn't re-check or flag a dispatcher's link", async () => {
    const { t, say, place, activity } = await setup();
    const a = await say("a", { address: "12 Lantern Lane (fictional)", position: "second floor" });
    const b = await say("b", { address: "14 Lantern Lane (fictional)", position: "second floor" });
    await place(a, 32.76, -117.17);
    await place(b, 32.7602, -117.17);
    await t.mutation(api.incidents.linkReports, { dispatcherToken, mainId: a, reportIds: [b] });
    await say("b", { address: "14 Lantern Lane (fictional)", position: "second floor" });
    expect((await activity()).some((m) => m.includes("for a report you linked"))).toBe(false);
  });
});
