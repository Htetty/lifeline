import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  DEFAULT_WATER_OBSERVED_AT,
  DEFAULT_WATER_SURFACE_ELEVATION,
  EXERCISE_ID,
  EXERCISE_NAME,
  SEED_INCIDENTS,
  SEED_TEAMS,
} from "./seedData";
import { LEVEL_METERS } from "./waterReports";

export async function logActivity(
  ctx: MutationCtx,
  message: string,
  incidentId: Id<"incidents"> | null = null,
  exerciseId = EXERCISE_ID,
) {
  await ctx.db.insert("activity", { exerciseId, at: Date.now(), message, incidentId });
}

/**
 * Functions only the FastAPI backend may call. The shared secret is set with
 * `npx convex env set BACKEND_SECRET <value>` and in backend/.env.
 */
export function requireBackend(secret: string) {
  const expected = process.env.BACKEND_SECRET;
  if (!expected || secret !== expected) throw new ConvexError("Unauthorized backend call");
}

/**
 * Optional dispatcher passcode. Off by default (open demo). To require one, run
 * `npx convex env set DISPATCHER_TOKEN <value>`; the dashboard then asks for it.
 */
export function requireDispatcher(token: string | undefined) {
  const expected = process.env.DISPATCHER_TOKEN;
  if (expected && token !== expected) throw new ConvexError("Dispatcher passcode required");
}

/**
 * Whether a queued announcement still describes the incident's current, confirmed state.
 * Any later dispatcher decision (decisionRevision) makes it stale, and so does a state
 * that no longer matches what it would tell the caller.
 */
export function isCurrentEvent(incident: Doc<"incidents">, event: Doc<"events">) {
  if (event.supersededAt) return false;
  // A dispatcher's own typed message isn't a claim about status, so later decisions don't
  // withdraw it (it still isn't delivered after the rescue is resolved or the call ends).
  if (event.type !== "dispatcher_message" && (event.decisionRevision ?? 0) !== (incident.decisionRevision ?? 0)) {
    return false;
  }
  // A linked report follows the main incident, whose location the dispatcher confirmed.
  const locationVerified = incident.locationVerified || incident.linkedTo != null;
  switch (event.type) {
    case "details_received":
      return incident.status !== "resolved";
    case "location_confirmed":
      return locationVerified && incident.status !== "resolved";
    case "location_unclear":
      return !incident.locationVerified;
    case "assignment_approved":
      return incident.status === "assigned" && locationVerified && incident.assignedTeamId != null;
    case "assignment_changed":
      return incident.status === "awaiting_assignment" && incident.assignedTeamId == null;
    case "team_en_route":
      return incident.status === "en_route" && locationVerified;
    case "rescue_resolved":
      return incident.status === "resolved";
    case "dispatcher_message":
      return incident.status !== "resolved";
    case "report_linked":
      return incident.linkedTo != null;
  }
}

export async function getExercise(ctx: QueryCtx, exerciseId = EXERCISE_ID) {
  return await ctx.db
    .query("exercises")
    .withIndex("by_exerciseId", (q) => q.eq("exerciseId", exerciseId))
    .unique();
}

export async function clearExercise(ctx: MutationCtx, exerciseId = EXERCISE_ID) {
  for (const table of ["incidents", "teams"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_exercise", (q) => q.eq("exerciseId", exerciseId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
  const activity = await ctx.db
    .query("activity")
    .withIndex("by_exercise_at", (q) => q.eq("exerciseId", exerciseId))
    .collect();
  for (const row of activity) await ctx.db.delete(row._id);
  const events = await ctx.db.query("events").collect();
  for (const row of events) if (row.exerciseId === exerciseId) await ctx.db.delete(row._id);
  const exercise = await getExercise(ctx, exerciseId);
  if (exercise) await ctx.db.delete(exercise._id);
}

export async function seedExercise(ctx: MutationCtx) {
  const now = Date.now();
  await ctx.db.insert("exercises", {
    exerciseId: EXERCISE_ID,
    name: EXERCISE_NAME,
    waterSurfaceElevation: DEFAULT_WATER_SURFACE_ELEVATION,
    waterObservedAt: DEFAULT_WATER_OBSERVED_AT,
  });

  const teamIds = new Map<string, Id<"teams">>();
  for (const t of SEED_TEAMS) {
    const id = await ctx.db.insert("teams", {
      exerciseId: EXERCISE_ID,
      name: t.name,
      latitude: t.latitude,
      longitude: t.longitude,
      capabilities: t.capabilities,
      available: true,
      currentAssignment: null,
      simulated: true,
      updatedAt: now,
    });
    teamIds.set(t.key, id);
  }

  for (const s of SEED_INCIDENTS) {
    const assignedTeamId = s.assignedTeam ? (teamIds.get(s.assignedTeam) ?? null) : null;
    const at = now - s.minutesAgo * 60_000;
    const incidentId = await ctx.db.insert("incidents", {
      exerciseId: EXERCISE_ID,
      callId: null,
      source: "fixture",
      reportedAddress: s.reportedAddress,
      latitude: s.latitude,
      longitude: s.longitude,
      locationVerified: s.locationVerified,
      peopleCount: s.peopleCount,
      reportedPosition: s.reportedPosition,
      hazards: s.hazards.map((hazard) => ({ hazard, evidence: null })),
      riskFactors: s.riskFactors ?? [],
      waterReport: s.waterReport
        ? { ...s.waterReport, meters: LEVEL_METERS[s.waterReport.level], at, gaugeSurface: DEFAULT_WATER_SURFACE_ELEVATION }
        : null,
      summary: s.summary,
      transcript: null,
      status: s.status,
      assignedTeamId,
      callConnected: false,
      createdAt: at,
      updatedAt: at,
      version: 1,
    });
    if (assignedTeamId) {
      await ctx.db.patch(assignedTeamId, { available: false, currentAssignment: incidentId });
    }
  }
  await logActivity(ctx, `Exercise loaded with ${SEED_INCIDENTS.length} fictional incidents.`);
}
