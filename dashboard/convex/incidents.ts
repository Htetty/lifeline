import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx } from "./_generated/server";
import { logActivity } from "./lib";
import { incidentStatus } from "./schema";
import { EXERCISE_ID } from "./seedData";

const STATUS_LABEL: Record<Doc<"incidents">["status"], string> = {
  needs_review: "Needs review",
  awaiting_assignment: "Awaiting team",
  assigned: "Team assigned",
  en_route: "Team en route",
  resolved: "Resolved",
};

async function load(ctx: MutationCtx, id: Id<"incidents">) {
  const incident = await ctx.db.get(id);
  if (!incident) throw new ConvexError("Incident not found");
  return incident;
}

async function bump(ctx: MutationCtx, incident: Doc<"incidents">, patch: Partial<Doc<"incidents">>) {
  await ctx.db.patch(incident._id, { ...patch, updatedAt: Date.now(), version: incident.version + 1 });
}

/** Queue a spoken update for the caller. Only for incidents that came from a call. */
async function emitEvent(
  ctx: MutationCtx,
  incident: Doc<"incidents">,
  type: Doc<"events">["type"],
  teamName: string | null,
) {
  if (!incident.callId) return;
  await ctx.db.insert("events", {
    exerciseId: incident.exerciseId,
    type,
    incidentId: incident._id,
    callId: incident.callId,
    teamName,
    createdAt: Date.now(),
    announcedAt: null,
  });
}

/** A dispatcher marks people stuck in a building directly on the map. */
export const reportFromMap = mutation({
  args: {
    latitude: v.number(),
    longitude: v.number(),
    peopleCount: v.union(v.number(), v.null()),
    reportedPosition: v.union(v.string(), v.null()),
    reportedAddress: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const id = await ctx.db.insert("incidents", {
      exerciseId: EXERCISE_ID,
      callId: null,
      source: "map_report",
      reportedAddress: args.reportedAddress,
      latitude: args.latitude,
      longitude: args.longitude,
      locationVerified: true,
      peopleCount: args.peopleCount,
      reportedPosition: args.reportedPosition,
      hazards: [],
      summary: "Marked on the map by a dispatcher.",
      transcript: null,
      status: "awaiting_assignment",
      assignedTeamId: null,
      callConnected: false,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    const who = args.peopleCount ?? "Unknown number of";
    await logActivity(ctx, `New report: ${who} people at ${args.reportedAddress}.`, id);
    return id;
  },
});

/** Dispatcher confirms the candidate location, or places the incident on a building. */
export const verifyLocation = mutation({
  args: {
    incidentId: v.id("incidents"),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
  },
  handler: async (ctx, { incidentId, latitude, longitude }) => {
    const incident = await load(ctx, incidentId);
    const lat = latitude ?? incident.latitude;
    const lon = longitude ?? incident.longitude;
    if (lat == null || lon == null) throw new ConvexError("Place the incident on the map first");
    await bump(ctx, incident, {
      latitude: lat,
      longitude: lon,
      locationVerified: true,
      locationNote: latitude != null ? "Placed by dispatcher" : incident.locationNote,
      status: incident.status === "needs_review" ? "awaiting_assignment" : incident.status,
    });
    await logActivity(ctx, `Location confirmed for ${incident.reportedAddress}.`, incident._id);
  },
});

/** Approve a team. Runs as one transaction, so a team can't be double-booked. */
export const assignTeam = mutation({
  args: { incidentId: v.id("incidents"), teamId: v.id("teams") },
  handler: async (ctx, { incidentId, teamId }) => {
    const incident = await load(ctx, incidentId);
    const team = await ctx.db.get(teamId);
    if (!team) throw new ConvexError("Team not found");
    if (!incident.locationVerified) throw new ConvexError("Confirm the location before assigning a team");
    if (!team.available) throw new ConvexError(`${team.name} is no longer available`);
    if (incident.status !== "awaiting_assignment") throw new ConvexError("Incident is not awaiting a team");

    await bump(ctx, incident, { status: "assigned", assignedTeamId: team._id });
    await ctx.db.patch(team._id, { available: false, currentAssignment: incident._id, updatedAt: Date.now() });
    await logActivity(ctx, `${team.name} assigned to ${incident.reportedAddress}.`, incident._id);
    await emitEvent(ctx, incident, "assignment_approved", team.name);
  },
});

export const setStatus = mutation({
  args: { incidentId: v.id("incidents"), status: incidentStatus },
  handler: async (ctx, { incidentId, status }) => {
    const incident = await load(ctx, incidentId);
    if (incident.status === status) return;
    await bump(ctx, incident, { status });

    const team = incident.assignedTeamId ? await ctx.db.get(incident.assignedTeamId) : null;
    if (status === "resolved" && team) {
      await ctx.db.patch(team._id, { available: true, currentAssignment: null, updatedAt: Date.now() });
    }
    await logActivity(ctx, `${incident.reportedAddress}: ${STATUS_LABEL[status]}.`, incident._id);
    if (status === "en_route") await emitEvent(ctx, incident, "team_en_route", team?.name ?? null);
    if (status === "resolved") await emitEvent(ctx, incident, "rescue_resolved", team?.name ?? null);
  },
});
