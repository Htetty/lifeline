import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { clearExercise, getExercise, logActivity, seedExercise } from "./lib";
import { EXERCISE_ID } from "./seedData";

/** Everything the dashboard renders, in one reactive query. Null until seeded. */
export const get = query({
  args: {},
  handler: async (ctx) => {
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
  args: {},
  handler: async (ctx) => {
    if (await getExercise(ctx)) return false;
    await seedExercise(ctx);
    return true;
  },
});

export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    await clearExercise(ctx);
    await seedExercise(ctx);
  },
});

export const setWaterLevel = mutation({
  args: { meters: v.number() },
  handler: async (ctx, { meters }) => {
    const exercise = await getExercise(ctx);
    if (!exercise) return;
    const clamped = Math.min(40, Math.max(0, Math.round(meters * 10) / 10));
    if (clamped === exercise.waterSurfaceElevation) return;
    await ctx.db.patch(exercise._id, { waterSurfaceElevation: clamped });
  },
});

export const logNote = mutation({
  args: { message: v.string() },
  handler: async (ctx, { message }) => {
    await logActivity(ctx, message);
  },
});
