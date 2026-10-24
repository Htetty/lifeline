import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { clearExercise, getExercise, logActivity, requireDispatcher, seedExercise } from "./lib";
import { EXERCISE_ID } from "./seedData";

/** Everything the dashboard renders, in one reactive query. Null until seeded. */
export const get = query({
  args: { dispatcherToken: v.optional(v.string()) },
  handler: async (ctx, { dispatcherToken }) => {
    requireDispatcher(dispatcherToken);
    const exercise = await getExercise(ctx);
    if (!exercise) return null;
    const [incidents, teams, activity] = await Promise.all([
      ctx.db
        .query("incidents")
        .withIndex("by_exercise", (q) => q.eq("exerciseId", EXERCISE_ID))
        .collect(),
      ctx.db
        .query("teams")
        .withIndex("by_exercise", (q) => q.eq("exerciseId", EXERCISE_ID))
        .collect(),
      ctx.db
        .query("activity")
        .withIndex("by_exercise_at", (q) => q.eq("exerciseId", EXERCISE_ID))
        .order("desc")
        .take(50),
    ]);
    return { exercise, incidents, teams, activity };
  },
});

/** Seeds the exercise the first time anyone opens the dashboard. */
export const ensureSeeded = mutation({
  args: { dispatcherToken: v.optional(v.string()) },
  handler: async (ctx, { dispatcherToken }) => {
    requireDispatcher(dispatcherToken);
    if (await getExercise(ctx)) return false;
    await seedExercise(ctx);
    return true;
  },
});

export const reset = mutation({
  args: { dispatcherToken: v.optional(v.string()) },
  handler: async (ctx, { dispatcherToken }) => {
    requireDispatcher(dispatcherToken);
    await clearExercise(ctx);
    await seedExercise(ctx);
  },
});

export const setWaterLevel = mutation({
  args: { dispatcherToken: v.optional(v.string()), meters: v.number() },
  handler: async (ctx, { dispatcherToken, meters }) => {
    requireDispatcher(dispatcherToken);
    const exercise = await getExercise(ctx);
    if (!exercise) return;
    const clamped = Math.min(40, Math.max(0, Math.round(meters * 10) / 10));
    if (clamped === exercise.waterSurfaceElevation) return;
    await ctx.db.patch(exercise._id, { waterSurfaceElevation: clamped });
  },
});

export const logNote = mutation({
  args: { dispatcherToken: v.optional(v.string()), message: v.string() },
  handler: async (ctx, { dispatcherToken, message }) => {
    requireDispatcher(dispatcherToken);
    await logActivity(ctx, message);
  },
});
