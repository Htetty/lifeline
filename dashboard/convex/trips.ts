import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { logActivity } from "./lib";
import { metres, MIN_TRIP_MS, TRIP_SPEEDUP, tripProgress } from "./tripMath";

// Simulated travel when a team goes en route: road vehicles follow a driving route,
// boats and helicopters go straight. Speeds are rough planning figures.
const SPEED_MPS = { air: 50, boat: 6, road: 9 };
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";

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

export const planTrip = internalAction({
  args: { teamId: v.id("teams"), incidentId: v.id("incidents") },
  handler: async (ctx, args) => {
    const found = await ctx.runQuery(internal.trips.tripContext, args);
    if (!found) return;
    const { team, incident } = found;
    const from = [team.longitude, team.latitude];
    const to = [incident.longitude!, incident.latitude!];
    const straight = metres(from, to);

    let path = [from, to];
    let route: "road" | "direct" = "direct";
    let realSeconds: number;
    if (team.capabilities.includes("air")) realSeconds = straight / SPEED_MPS.air;
    else if (team.capabilities.includes("boat")) realSeconds = straight / SPEED_MPS.boat;
    else {
      const road = await roadRoute(from, to);
      if (road) {
        path = [from, ...road.coords, to];
        route = "road";
        realSeconds = road.seconds;
      } else {
        realSeconds = (straight * 1.4) / SPEED_MPS.road;
      }
    }
    await ctx.runMutation(internal.trips.startTrip, { ...args, path, route, realSeconds });
  },
});

export const startTrip = internalMutation({
  args: {
    teamId: v.id("teams"),
    incidentId: v.id("incidents"),
    path: v.array(v.array(v.number())),
    route: v.union(v.literal("road"), v.literal("direct")),
    realSeconds: v.number(),
  },
  handler: async (ctx, { teamId, incidentId, path, route, realSeconds }) => {
    const [team, incident] = await Promise.all([ctx.db.get(teamId), ctx.db.get(incidentId)]);
    // The dispatcher may have changed the plan while the route was being fetched.
    if (!team || !incident || team.currentAssignment !== incidentId || incident.status !== "en_route") return;
    if (team.trip?.incidentId === incidentId) return;

    const departAt = Date.now();
    const arriveAt = departAt + Math.max(MIN_TRIP_MS, (realSeconds * 1000) / TRIP_SPEEDUP);
    await ctx.db.patch(teamId, { trip: { incidentId, path, departAt, arriveAt, route, realSeconds }, updatedAt: departAt });
    await ctx.scheduler.runAt(arriveAt, internal.trips.arrive, { teamId, departAt });
    const how = route === "road" ? "by road" : team.capabilities.includes("air") ? "by air" : "direct";
    await logActivity(
      ctx,
      `${team.name} departed for ${incident.reportedAddress}, about ${Math.max(1, Math.round(realSeconds / 60))} min ${how} (simulated).`,
      incidentId,
    );
  },
});

export const arrive = internalMutation({
  args: { teamId: v.id("teams"), departAt: v.number() },
  handler: async (ctx, { teamId, departAt }) => {
    const team = await ctx.db.get(teamId);
    // Stale when the trip was cancelled or replaced since this was scheduled.
    if (!team?.trip || team.trip.departAt !== departAt) return;
    const [longitude, latitude] = team.trip.path[team.trip.path.length - 1];
    const incident = await ctx.db.get(team.trip.incidentId);
    await ctx.db.patch(teamId, { latitude, longitude, trip: null, updatedAt: Date.now() });
    await logActivity(ctx, `${team.name} arrived at ${incident?.reportedAddress ?? "the incident"}.`, team.trip.incidentId);
  },
});

/** Ends a trip early, leaving the team where it is now. */
export async function stopTrip(ctx: MutationCtx, team: Doc<"teams">) {
  if (!team.trip) return;
  const [longitude, latitude] = tripProgress(team.trip, Date.now()).position;
  await ctx.db.patch(team._id, { latitude, longitude, trip: null, updatedAt: Date.now() });
}
