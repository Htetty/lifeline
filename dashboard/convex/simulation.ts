import { ConvexError, v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { applyStatus } from "./incidents";
import { clearExercise, logActivity, requireBackend, seedExercise, setWater } from "./lib";
import { autoGroup, bump, linkedReports } from "./linking";
import { queueCallerUpdate } from "./callerUpdates";
import { onSceneMinutes } from "./rescueTime";
import { DEFAULT_REGION } from "./regions";
import { capability, regionId } from "./schema";

// The demo simulation (backend/scripts/demo_sim.py) drives these with the backend secret:
// it resets the exercise with its own teams, raises the river along the 2017 gauge record,
// and places scripted callers' calls (which go through the normal call pipeline). Teams
// then finish rescues by themselves (finishRescue) so they come back for the next call.

/** Clears the exercise and loads the simulation's teams, with automatic rescue finishes on. */
export const start = mutation({
  args: {
    secret: v.string(),
    teams: v.array(
      v.object({ name: v.string(), latitude: v.number(), longitude: v.number(), capabilities: v.array(capability) }),
    ),
    onSceneSpeedup: v.number(),
    waterSurfaceElevation: v.number(),
    waterObservedAt: v.number(),
    region: v.optional(regionId),
  },
  handler: async (ctx, { secret, teams, onSceneSpeedup, waterSurfaceElevation, waterObservedAt, region = DEFAULT_REGION }) => {
    requireBackend(secret);
    if (!teams.length || teams.length > 40) throw new ConvexError("Give the simulation 1 to 40 teams");
    if (!(onSceneSpeedup >= 1 && onSceneSpeedup <= 600)) throw new ConvexError("onSceneSpeedup must be 1 to 600");
    await clearExercise(ctx);
    await seedExercise(ctx, { region, simulation: { teams, onSceneSpeedup } });
    await setWater(ctx, waterSurfaceElevation, waterObservedAt);
  },
});

/** The river at a replayed gauge reading. */
export const setWaterLevel = mutation({
  args: { secret: v.string(), meters: v.number(), observedAt: v.number() },
  handler: async (ctx, { secret, meters, observedAt }) => {
    requireBackend(secret);
    await setWater(ctx, meters, observedAt);
  },
});

/**
 * A simulated caller's location, as a phone's location would place them: the scenario
 * knows exactly where they are, so it is confirmed without a dispatcher placing it.
 */
export const pinCall = mutation({
  args: { secret: v.string(), callId: v.string(), latitude: v.number(), longitude: v.number(), label: v.string() },
  handler: async (ctx, { secret, callId, latitude, longitude, label }) => {
    requireBackend(secret);
    const incident = await ctx.db
      .query("incidents")
      .withIndex("by_callId", (q) => q.eq("callId", callId))
      .first();
    if (!incident) throw new ConvexError("No incident for this call yet");
    if (incident.source !== "simulation") throw new ConvexError("Only simulated calls can be pinned");
    if (incident.locationVerified) return;
    await bump(
      ctx,
      incident,
      {
        latitude,
        longitude,
        locationVerified: true,
        locationNote: `Caller's phone location (simulated): ${label}`,
        status: incident.status === "needs_review" ? "awaiting_assignment" : incident.status,
      },
      true,
    );
    await logActivity(ctx, `Location confirmed for ${incident.reportedAddress} from the caller's phone (simulated).`, incident._id);
    await queueCallerUpdate(ctx, (await ctx.db.get(incident._id))!, "location_confirmed");
    await autoGroup(ctx, incident._id);
  },
});

/** Scheduled when a team arrives in a simulation: the rescue is done after its time on scene. */
export const finishRescue = internalMutation({
  args: { teamId: v.id("teams"), incidentId: v.id("incidents") },
  handler: async (ctx, { teamId, incidentId }) => {
    const [team, incident] = await Promise.all([ctx.db.get(teamId), ctx.db.get(incidentId)]);
    // Stale when the dispatcher already resolved, unassigned or rerouted it.
    if (!team || !incident || team.currentAssignment !== incidentId || team.trip || incident.status !== "en_route") return;
    if (incident.linkedTo) return;
    const linked = await linkedReports(ctx, incidentId);
    const { why } = onSceneMinutes(incident, linked, team);
    await applyStatus(ctx, incident, "resolved");
    await logActivity(ctx, `${team.name} finished at ${incident.reportedAddress} (${why}) and is available again (simulated).`, incidentId);
  },
});
