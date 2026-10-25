import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { clearExercise, getExercise, logActivity, requireDispatcher, seedExercise, setWater } from "./lib";
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
  args: { dispatcherToken: v.optional(v.string()), withSamples: v.optional(v.boolean()) },
  handler: async (ctx, { dispatcherToken, withSamples }) => {
    requireDispatcher(dispatcherToken);
    if (await getExercise(ctx)) return false;
    await seedExercise(ctx, { withSamples });
    return true;
  },
});

/** Clears all incidents for everyone. `withSamples` loads the fictional sample incidents. */
export const reset = mutation({
  args: { dispatcherToken: v.optional(v.string()), withSamples: v.optional(v.boolean()) },
  handler: async (ctx, { dispatcherToken, withSamples }) => {
    requireDispatcher(dispatcherToken);
    await clearExercise(ctx);
    await seedExercise(ctx, { withSamples });
  },
});

export const setWaterLevel = mutation({
  args: {
    dispatcherToken: v.optional(v.string()),
    meters: v.number(),
    observedAt: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, { dispatcherToken, meters, observedAt = null }) => {
    requireDispatcher(dispatcherToken);
    await setWater(ctx, meters, observedAt);
  },
});

export const logNote = mutation({
  args: { dispatcherToken: v.optional(v.string()), message: v.string() },
  handler: async (ctx, { dispatcherToken, message }) => {
    requireDispatcher(dispatcherToken);
    await logActivity(ctx, message);
  },
});
