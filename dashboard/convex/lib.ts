import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  DEFAULT_WATER_SURFACE_ELEVATION,
  EXERCISE_ID,
  EXERCISE_NAME,
  SEED_INCIDENTS,
  SEED_TEAMS,
} from "./seedData";

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
