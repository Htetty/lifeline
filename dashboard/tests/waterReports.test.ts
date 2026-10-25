import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import type { WaterLevel } from "../convex/waterReports";

interface Report {
  level: WaterLevel;
  measuredMeters: number | null;
  floor: number | null;
  evidence: string | null;
}

const modules = import.meta.glob("../convex/**/*.ts");
const secret = "isolated-fixture-only";
const dispatcherToken = "isolated-dispatcher-only";

beforeEach(() => {
  process.env.BACKEND_SECRET = secret;
  process.env.DISPATCHER_TOKEN = dispatcherToken;
});

const turn = (sequence: number, waterReport?: Report) => ({
  secret, callId: "w", turnId: `turn-${sequence}`, sequence, fingerprint: `fp-${sequence}`,
  source: "live_demo" as const, reportedAddress: "Fictional Mission Valley house",
  peopleCount: 2, reportedPosition: "ground floor", hazards: [], summary: "Two people, water inside",
  transcript: `Caller: turn ${sequence}`, response: { next_question: null, extraction: null },
  ...(waterReport ? { waterReport } : {}),
});

describe("caller water reports", () => {
  test("are stored in metres with the gauge level at the time, replaced by later ones, kept when omitted", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.exercise.ensureSeeded, { dispatcherToken });
    await t.mutation(api.exercise.setWaterLevel, { dispatcherToken, meters: 7.5, observedAt: null });
    await t.mutation(api.calls.startVoiceCall, { secret, callId: "w" });

    await t.mutation(api.calls.upsertFromCall, turn(1, { level: "knee", measuredMeters: null, floor: 0, evidence: "up to my knees" }));
    const incident = () => t.run((ctx) => ctx.db.query("incidents").withIndex("by_callId", (q) => q.eq("callId", "w")).unique());
    expect((await incident())!.waterReport).toMatchObject({ level: "knee", meters: 0.5, floor: 0, gaugeSurface: 7.5 });

    await t.mutation(api.exercise.setWaterLevel, { dispatcherToken, meters: 8.2, observedAt: null });
    await t.mutation(api.calls.upsertFromCall, turn(2, { level: "chest", measuredMeters: null, floor: 0, evidence: "it's at my chest now" }));
    const later = (await incident())!;
    expect(later.waterReport).toMatchObject({ level: "chest", meters: 1.3, gaugeSurface: 8.2 });
    expect(later.factHistory).toContainEqual(expect.objectContaining({ field: "waterReport", previous: "knee-deep" }));

    await t.mutation(api.calls.upsertFromCall, turn(3));
    expect((await incident())!.waterReport).toMatchObject({ level: "chest" });
  });

  test("a measurement is used as given, and an implausible one is ignored", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.exercise.ensureSeeded, { dispatcherToken });
    await t.mutation(api.calls.startVoiceCall, { secret, callId: "w" });
    await t.mutation(api.calls.upsertFromCall, turn(1, { level: "measured", measuredMeters: 40, floor: null, evidence: "forty metres" }));
    const incident = () => t.run((ctx) => ctx.db.query("incidents").withIndex("by_callId", (q) => q.eq("callId", "w")).unique());
    expect((await incident())!.waterReport).toBeNull();
    await t.mutation(api.calls.upsertFromCall, turn(2, { level: "measured", measuredMeters: 0.9, floor: 1, evidence: "about three feet upstairs" }));
    expect((await incident())!.waterReport).toMatchObject({ meters: 0.9, floor: 1 });
  });
});
