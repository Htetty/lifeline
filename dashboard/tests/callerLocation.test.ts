import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { readBack } from "../convex/callerLocation";
import schema from "../convex/schema";

// Convex side of caller location confirmation: every confirmation is re-checked against
// the saved transcript, and a confirmed location is never silently replaced. The backend's
// decisions are in backend/tests/test_location_confirmation.py.

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "isolated-fixture-only";
const HOME = "1234 Hotel Circle North, apartment 5, San Diego";
const OTHER = "456 Hotel Circle South, San Diego";

beforeEach(() => { process.env.BACKEND_SECRET = secret; delete process.env.DISPATCHER_TOKEN; });

const turn = (transcript: string[], extra: Record<string, unknown> = {}) => ({
  secret, callId: "c", source: "live_demo" as const, reportedAddress: HOME, peopleCount: null,
  reportedPosition: null, hazards: [], summary: null, transcript: transcript.join("\n"), ...extra,
});

async function incident(t: ReturnType<typeof convexTest>) {
  return (await t.run((ctx) => ctx.db.query("incidents").first()))!;
}

/** A call whose location HOME was read back and confirmed with "Yes". */
async function confirmedCall() {
  const t = convexTest(schema, modules);
  const lines = ["Caller: 1234 Hotel Circle North, apartment 5, San Diego"];
  await t.mutation(api.calls.upsertFromCall, turn(lines, { candidateLatitude: 32.76, candidateLongitude: -117.16, candidateLabel: "Map search: Home" }));
  lines.push(`Agent: ${readBack(HOME)}`, "Caller: Yes");
  await t.mutation(api.calls.upsertFromCall, turn(lines, { locationConfirmation: { location: HOME, evidence: "Yes" } }));
  return { t, lines };
}

describe("caller location confirmation", () => {
  test("extracted and geocoded is not confirmed; an explicit yes to the read-back is", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.calls.upsertFromCall, turn(["Caller: 1234 Hotel Circle North"], {
      candidateLatitude: 32.76, candidateLongitude: -117.16, candidateLabel: "Map search: Home" }));
    expect((await incident(t)).callerLocation).toMatchObject({ status: "unconfirmed" });
    expect(await t.query(api.calls.callerLocationForCall, { secret, callId: "c" }))
      .toEqual({ address: HOME, status: "unconfirmed", pending: null });

    const { t: t2 } = await confirmedCall();
    const row = await incident(t2);
    expect(row.callerLocation).toMatchObject({ status: "confirmed", evidence: "Yes", pending: null });
    // Caller confirmation is not the dispatcher's check of the pin.
    expect(row.locationVerified).toBe(false);
    const state = await t2.query(api.calls.callState, { secret, callId: "c" });
    expect(state.status).toMatchObject({ callerConfirmedLocation: true, locationConfirmed: false });
  });

  test("a confirmation the transcript doesn't show is refused", async () => {
    const claims: [string[], { location: string; evidence: string }, string | null][] = [
      // Yes to another question.
      [[`Agent: ${readBack(HOME)}`, "Caller: water's coming in", "Agent: Is anyone hurt?", "Caller: Yes"], { location: HOME, evidence: "Yes" }, null],
      // Read-back never answered (silence), then the caller spoke after an update.
      [[`Agent: ${readBack(HOME)}`, "Agent: I've passed your details to the dispatcher.", "Caller: Yes"], { location: HOME, evidence: "Yes" }, null],
      // Words that weren't the reply, or a location that wasn't the one read back.
      [[`Agent: ${readBack(HOME)}`, "Caller: Um, I think so?"], { location: HOME, evidence: "Yes" }, null],
      [[`Agent: ${readBack(OTHER)}`, "Caller: Yes"], { location: OTHER, evidence: "Yes" }, null],
      // A yes in the same turn as a different location.
      [[`Agent: ${readBack(HOME)}`, "Caller: Yes"], { location: HOME, evidence: "Yes" }, OTHER],
    ];
    for (const [lines, claim, address] of claims) {
      const t = convexTest(schema, modules);
      await t.mutation(api.calls.upsertFromCall, turn(["Caller: 1234 Hotel Circle North"]));
      await t.mutation(api.calls.upsertFromCall, turn(["Caller: 1234 Hotel Circle North", ...lines], {
        locationConfirmation: claim, ...(address ? { reportedAddress: address } : {}) }));
      expect((await incident(t)).callerLocation?.status).toBe("unconfirmed");
    }
  });

  test("a correction after confirmation replaces the location and needs confirming again", async () => {
    const { t, lines } = await confirmedCall();
    lines.push("Agent: How many people?", "Caller: Sorry, actually it's 456 Hotel Circle South");
    await t.mutation(api.calls.upsertFromCall, turn(lines, { reportedAddress: OTHER, locationChanged: true }));
    const row = await incident(t);
    expect(row.reportedAddress).toBe(OTHER);
    expect(row.callerLocation).toMatchObject({ status: "unconfirmed", evidence: null, pending: null });
    expect(row.factHistory).toContainEqual(expect.objectContaining({ field: "reportedAddress", previous: HOME }));

    lines.push(`Agent: ${readBack(OTHER)}`, "Caller: Yes that's right");
    await t.mutation(api.calls.upsertFromCall, turn(lines, { reportedAddress: OTHER,
      locationConfirmation: { location: OTHER, evidence: "Yes that's right" } }));
    expect((await incident(t)).callerLocation).toMatchObject({ status: "confirmed", evidence: "Yes that's right" });
  });

  test("a background extraction can't overwrite a confirmed location or its pin", async () => {
    const { t, lines } = await confirmedCall();
    lines.push("Agent: How many people?", "Caller: three of us");
    // Same place reworded: the confirmed words stay.
    await t.mutation(api.calls.upsertFromCall, turn(lines, { reportedAddress: "1234 hotel circle north apartment 5 san diego" }));
    expect((await incident(t)).reportedAddress).toBe(HOME);
    // A different place the caller never corrected to: held, not applied, pin unchanged.
    await t.mutation(api.calls.upsertFromCall, turn(lines, { reportedAddress: OTHER,
      candidateLatitude: 32.75, candidateLongitude: -117.18, candidateLabel: "Map search: Elsewhere" }));
    let row = await incident(t);
    expect(row).toMatchObject({ reportedAddress: HOME, latitude: 32.76, locationNote: "Map search: Home" });
    expect(row.callerLocation).toMatchObject({ status: "confirmed", pending: OTHER });
    const log = await t.run((ctx) => ctx.db.query("activity").collect());
    expect(log.map((a) => a.message)).toContainEqual(expect.stringContaining(`"${OTHER}" held`));

    // Only the caller's yes to it applies the held location.
    lines.push(`Agent: ${readBack(OTHER)}`, "Caller: Yes");
    await t.mutation(api.calls.upsertFromCall, turn(lines, { reportedAddress: OTHER,
      locationConfirmation: { location: OTHER, evidence: "Yes" } }));
    row = await incident(t);
    expect(row.reportedAddress).toBe(OTHER);
    expect(row.callerLocation).toMatchObject({ status: "confirmed", pending: null });
  });

  test("a map problem is kept for the dispatcher without touching caller confirmation", async () => {
    const { t, lines } = await confirmedCall();
    lines.push("Agent: How many people?", "Caller: two");
    await t.mutation(api.calls.upsertFromCall, turn(lines, { mapIssue: "2 map matches far apart: Home, Home" }));
    expect((await incident(t)).callerLocation).toMatchObject({ status: "confirmed", mapIssue: "2 map matches far apart: Home, Home" });
    await t.mutation(api.calls.upsertFromCall, turn(lines, { mapIssue: null }));
    expect((await incident(t)).callerLocation?.mapIssue).toBeNull();
  });
});
