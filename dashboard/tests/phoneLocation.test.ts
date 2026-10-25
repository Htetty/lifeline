import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "phone-location-fixture";
const dispatcherToken = "phone-location-dispatcher";
const callId = `CA${"a".repeat(32)}`;
const point = { secret, callId, requestId: "b".repeat(32), latitude: 32.7612, longitude: -117.1675,
  accuracyMeters: 9, capturedAt: "2026-10-25T10:00:00.000Z" };
const utterance = { secret, callId, source: "live_demo" as const, reportedAddress: null, peopleCount: 4,
  reportedPosition: "roof", hazards: [], summary: "Four people on the roof", transcript: "Caller: Four on the roof" };

beforeEach(() => { process.env.BACKEND_SECRET = secret; process.env.DISPATCHER_TOKEN = dispatcherToken; });

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.exercise.ensureSeeded, { dispatcherToken });
  await t.mutation(api.calls.startVoiceCall, { secret, callId });
  const incident = await t.mutation(api.calls.upsertFromCall, utterance);
  return { t, incidentId: incident.incidentId as Id<"incidents"> };
}

test("Photon supplies the existing incident pin; normal dispatcher confirmation and assignment still apply", async () => {
  const { t, incidentId } = await setup();
  expect(await t.mutation(api.calls.locationFromPhone, point)).toMatchObject({ saved: true });
  const state = (await t.query(api.exercise.get, { dispatcherToken }))!;
  const row = state.incidents.find(i => i._id === incidentId)!;
  expect(row).toMatchObject({ latitude: point.latitude, longitude: point.longitude,
    locationVerified: false, status: "needs_review", transcript: utterance.transcript,
    peopleCount: 4, summary: utterance.summary });
  expect(row.locationNote).toContain("accuracy ±9 m");
  expect(row.phoneLocation).toMatchObject({ requestId: point.requestId, active: true });
  const teamId = state.teams.find(team => team.available)!._id;
  await expect(t.mutation(api.incidents.assignTeam, { dispatcherToken, incidentId, teamId }))
    .rejects.toThrow("Confirm the location");
  await t.mutation(api.incidents.verifyLocation, { dispatcherToken, incidentId });
  await t.mutation(api.incidents.assignTeam, { dispatcherToken, incidentId, teamId });
  expect(await t.query(api.calls.statusForCall, { secret, callId })).toMatchObject({
    status: "assigned", locationVerified: true });
  expect((await t.query(api.calls.pendingEvents, { secret, callId })).map(e => e.type)).toContain("assignment_approved");
});

test("duplicate confirmations, concurrent delivery and lost-response retries update one incident once", async () => {
  const { t, incidentId } = await setup();
  const before = (await t.run(ctx => ctx.db.get(incidentId)))!;
  await Promise.all([t.mutation(api.calls.locationFromPhone, point), t.mutation(api.calls.locationFromPhone, point)]);
  await t.mutation(api.calls.locationFromPhone, point);
  const row = (await t.run(ctx => ctx.db.get(incidentId)))!;
  expect(row.version).toBe(before.version + 1);
  expect(await t.run(ctx => ctx.db.query("incidents").collect())).toHaveLength(1);
  expect((await t.query(api.calls.pendingEvents, { secret, callId })).map(e => e.type)).toEqual(["details_received"]);
  await expect(t.mutation(api.calls.locationFromPhone, { ...point, latitude: point.latitude + 0.01 }))
    .rejects.toThrow("identity conflict");
});

test("phone fixes stay authoritative until an explicit verbal correction, which uses the usual location flow", async () => {
  const { t, incidentId } = await setup();
  await t.mutation(api.calls.locationFromPhone, point);
  const geocode = { ...utterance, candidateLatitude: 32.77, candidateLongitude: -117.18, candidateLabel: "Map search: other place" };
  await t.mutation(api.calls.upsertFromCall, geocode);
  expect(await t.run(ctx => ctx.db.get(incidentId))).toMatchObject({ latitude: point.latitude, longitude: point.longitude });
  await t.mutation(api.calls.upsertFromCall, { ...utterance, reportedAddress: "First address" });
  await t.mutation(api.calls.upsertFromCall, { ...geocode, reportedAddress: "Corrected address", locationChanged: true });
  expect(await t.run(ctx => ctx.db.get(incidentId))).toMatchObject({ latitude: 32.77, longitude: -117.18,
    locationVerified: false, status: "needs_review", phoneLocation: { active: false } });
  expect(await t.mutation(api.calls.locationFromPhone, point)).toMatchObject({ saved: false, reason: "location_corrected" });
});

test("a later request replaces a prior fix, and an older request cannot restore stale coordinates", async () => {
  const { t, incidentId } = await setup();
  await t.mutation(api.calls.locationFromPhone, point);
  const fresh = { ...point, requestId: "c".repeat(32), latitude: 32.762, capturedAt: "2026-10-25T10:01:00.000Z" };
  await t.mutation(api.calls.locationFromPhone, fresh);
  expect(await t.mutation(api.calls.locationFromPhone, point)).toMatchObject({ saved: false, reason: "stale_location" });
  expect(await t.run(ctx => ctx.db.get(incidentId))).toMatchObject({ latitude: fresh.latitude });
});

test("closed, unknown, invalid or unauthorized calls cannot write a location", async () => {
  const { t, incidentId } = await setup();
  const before = await t.run(ctx => ctx.db.get(incidentId));
  await expect(t.mutation(api.calls.locationFromPhone, { ...point, secret: "wrong" })).rejects.toThrow();
  await expect(t.mutation(api.calls.locationFromPhone, { ...point, latitude: 91 })).rejects.toThrow("Invalid phone location");
  await expect(t.mutation(api.calls.locationFromPhone, { ...point, capturedAt: "invalid" })).rejects.toThrow("Invalid phone location");
  expect(await t.mutation(api.calls.locationFromPhone, { ...point, callId: `CA${"f".repeat(32)}` }))
    .toMatchObject({ saved: false, reason: "incident_not_found" });
  expect(await t.run(ctx => ctx.db.get(incidentId))).toEqual(before);
  await t.mutation(api.calls.callEnded, { secret, callId });
  expect(await t.mutation(api.calls.locationFromPhone, point)).toMatchObject({ saved: false, reason: "call_ended" });
  expect((await t.run(ctx => ctx.db.get(incidentId)))!.latitude).toBeNull();
});

test("a dispatcher-confirmed destination is kept, including after assignment", async () => {
  const { t, incidentId } = await setup();
  await t.mutation(api.incidents.verifyLocation, { dispatcherToken, incidentId, latitude: 32.76, longitude: -117.16 });
  expect(await t.mutation(api.calls.locationFromPhone, point)).toMatchObject({ saved: false, reason: "location_already_reviewed" });
  const teamId = (await t.query(api.exercise.get, { dispatcherToken }))!.teams.find(team => team.available)!._id;
  await t.mutation(api.incidents.assignTeam, { dispatcherToken, incidentId, teamId });
  expect(await t.mutation(api.calls.locationFromPhone, point)).toMatchObject({ saved: false });
  expect(await t.run(ctx => ctx.db.get(incidentId))).toMatchObject({ latitude: 32.76, longitude: -117.16, status: "assigned" });
});
