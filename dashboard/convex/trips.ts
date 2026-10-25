import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, type MutationCtx } from "./_generated/server";
import { getExercise, logActivity, requireDispatcher } from "./lib";
import { linkedReports } from "./linking";
import { onSceneMinutes, onSceneMs } from "./rescueTime";
import { metres, MIN_TRIP_MS, TRIP_SPEEDUP, vehiclePosition, type Trip, type TripLeg } from "./tripMath";

// Simulated travel when a team goes en route. The dashboard normally supplies a
// flood-aware route (src/lib/router.ts). Without one, road vehicles take a driving
// route that ignores the flood, and boats and helicopters go straight.
const SPEED_MPS = { air: 50, boat: 6, road: 9 };
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
// Convex arrays hold at most 8192 values.
const MAX_PATH_POINTS = 4000;

export const tripLeg = v.object({
  mode: v.union(v.literal("road"), v.literal("water"), v.literal("foot"), v.literal("air")),
  end: v.number(),
});

/** A route planned by the dashboard. */
export const routePlan = v.object({
  path: v.array(v.array(v.number())),
  legs: v.array(tripLeg),
  realSeconds: v.number(),
});

interface Plan {
  path: number[][];
  legs: TripLeg[];
  realSeconds: number;
  route: Trip["route"];
}

/** The team and incident for a trip, or null when the team is no longer heading there. */
export const tripContext = internalQuery({
  args: { teamId: v.id("teams"), incidentId: v.id("incidents") },
  handler: async (ctx, { teamId, incidentId }) => {
    const [team, incident] = await Promise.all([ctx.db.get(teamId), ctx.db.get(incidentId)]);
    if (!team || !incident || team.currentAssignment !== incidentId || incident.status !== "en_route") return null;
    if (incident.latitude == null || incident.longitude == null) return null;
    return { team, incident };
  },
});

async function roadRoute(from: number[], to: number[]) {
  try {
    const res = await fetch(`${OSRM_URL}/${from.join(",")};${to.join(",")}?overview=full&geometries=geojson`);
    if (!res.ok) return null;
    const body = await res.json();
    const route = body.routes?.[0];
    if (!route) return null;
    return { coords: route.geometry.coordinates as number[][], seconds: route.duration as number };
  } catch {
    return null;
  }
}

/** Fallback when no dashboard route was supplied. */
export const planTrip = internalAction({
  args: { teamId: v.id("teams"), incidentId: v.id("incidents") },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.trips.tripContext, args);
    if (!found) return;
    const { team, incident } = found;
    const from = [team.longitude, team.latitude];
    const to = [incident.longitude!, incident.latitude!];
    const straight = metres(from, to);
    const direct = (mode: TripLeg["mode"], realSeconds: number): Plan => ({
      path: [from, to],
      legs: [{ mode, end: 1 }],
      realSeconds,
      route: "direct",
    });

    let plan: Plan;
    if (team.capabilities.includes("air")) plan = direct("air", straight / SPEED_MPS.air);
    else if (team.capabilities.includes("boat")) plan = direct("water", straight / SPEED_MPS.boat);
    else {
      const road = await roadRoute(from, to);
      const path = road ? [from, ...road.coords, to] : null;
      plan =
        path && path.length <= MAX_PATH_POINTS
          ? { path, legs: [{ mode: "road", end: path.length - 1 }], realSeconds: road!.seconds, route: "road" }
          : direct("road", (straight * 1.4) / SPEED_MPS.road);
    }
    await ctx.runMutation(internal.trips.startTrip, { ...args, ...plan });
  },
});

export const startTrip = internalMutation({
  args: {
    teamId: v.id("teams"),
    incidentId: v.id("incidents"),
    path: v.array(v.array(v.number())),
    legs: v.array(tripLeg),
    route: v.union(v.literal("planned"), v.literal("road"), v.literal("direct")),
    realSeconds: v.number(),
  },
  handler: async (ctx, { teamId, incidentId, ...plan }) => {
    const team = await ctx.db.get(teamId);
    // A route that arrives after a dispatcher already started one is dropped.
    if (team?.trip?.incidentId === incidentId) return;
    await beginTrip(ctx, teamId, incidentId, plan);
  },
});

/** Starts a trip if the team is still assigned and en route to the incident. */
export async function beginTrip(ctx: MutationCtx, teamId: Id<"teams">, incidentId: Id<"incidents">, plan: Plan) {
  const [team, incident] = await Promise.all([ctx.db.get(teamId), ctx.db.get(incidentId)]);
  // The dispatcher may have changed the plan while the route was being worked out.
  if (!team || !incident || team.currentAssignment !== incidentId || incident.status !== "en_route") return;
  if (plan.path.length < 2 || plan.path.length > MAX_PATH_POINTS) throw new ConvexError("Route is not usable");

  const departAt = Date.now();
  const arriveAt = departAt + Math.max(MIN_TRIP_MS, (plan.realSeconds * 1000) / TRIP_SPEEDUP);
  await ctx.db.patch(teamId, { trip: { incidentId, departAt, arriveAt, ...plan }, updatedAt: departAt });
  await ctx.scheduler.runAt(arriveAt, internal.trips.arrive, { teamId, departAt });
  await logActivity(
    ctx,
    `${team.name} departed for ${incident.reportedAddress}, about ${Math.max(1, Math.round(plan.realSeconds / 60))} min ${describe(plan)} (simulated).`,
    incidentId,
  );
}

function describe(plan: Plan) {
  const modes = [...new Set(plan.legs.map((l) => l.mode))].filter((m) => m !== "foot");
  const words = { road: "road", water: "water", air: "air", foot: "foot" };
  const how = `by ${modes.map((m) => words[m]).join(" and ")}`;
  return plan.route === "road" ? `${how}, route ignores flooding` : how;
}

/** The dispatcher sends a moving team a new route from where it is now. */
export const reroute = mutation({
  args: { dispatcherToken: v.optional(v.string()), teamId: v.id("teams"), plan: routePlan },
  handler: async (ctx, { dispatcherToken, teamId, plan }) => {
    requireDispatcher(dispatcherToken);
    const team = await ctx.db.get(teamId);
    if (!team?.trip) throw new ConvexError("This team isn't on its way anywhere");
    const incidentId = team.trip.incidentId;
    await stopTrip(ctx, team);
    await beginTrip(ctx, teamId, incidentId, { ...plan, route: "planned" });
  },
});

export const arrive = internalMutation({
  args: { teamId: v.id("teams"), departAt: v.number() },
  handler: async (ctx, { teamId, departAt }) => {
    const team = await ctx.db.get(teamId);
    // Stale when the trip was cancelled or replaced since this was scheduled.
    if (!team?.trip || team.trip.departAt !== departAt) return;
    // The vehicle stays where it parked; the crew walked the rest.
    const [longitude, latitude] = vehiclePosition(team.trip, team.trip.arriveAt);
    const incident = await ctx.db.get(team.trip.incidentId);
    await ctx.db.patch(teamId, { latitude, longitude, trip: null, updatedAt: Date.now() });
    await logActivity(ctx, `${team.name} arrived at ${incident?.reportedAddress ?? "the incident"}.`, team.trip.incidentId);
    // In the demo simulation the team finishes by itself after its time on scene.
    const exercise = await getExercise(ctx);
    if (exercise?.autoResolve && incident) {
      const { minutes, why } = onSceneMinutes(incident, await linkedReports(ctx, incident._id), team);
      await ctx.scheduler.runAfter(onSceneMs(minutes, exercise.onSceneSpeedup), internal.simulation.finishRescue, {
        teamId,
        incidentId: incident._id,
      });
      await logActivity(ctx, `${team.name} on scene: about ${minutes} min (${why}, simulated).`, incident._id);
    }
  },
});

/** Ends a trip early, leaving the team where it is now. */
export async function stopTrip(ctx: MutationCtx, team: Doc<"teams">) {
  if (!team.trip) return;
  const [longitude, latitude] = vehiclePosition(team.trip, Date.now());
  await ctx.db.patch(team._id, { latitude, longitude, trip: null, updatedAt: Date.now() });
}
