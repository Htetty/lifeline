import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { queueCallerUpdate } from "./callerUpdates";
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
    const moving = latitude != null && (latitude !== incident.latitude || longitude !== incident.longitude);
    if (moving && incident.status !== "needs_review" && incident.status !== "awaiting_assignment") {
      throw new ConvexError("A team is already dispatched here. Unassign the team before moving the location.");
    }
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
    if (!incident.locationVerified) await queueCallerUpdate(ctx, incident, "location_confirmed");
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
    await queueCallerUpdate(ctx, incident, "assignment_approved", { teamName: team.name });
  },
});

/** Allowed status changes. Assignment itself goes through assignTeam. */
const TRANSITIONS: Record<Doc<"incidents">["status"], Doc<"incidents">["status"][]> = {
  needs_review: ["resolved"],
  awaiting_assignment: ["resolved"],
  assigned: ["en_route", "awaiting_assignment", "resolved"],
  en_route: ["awaiting_assignment", "resolved"],
  resolved: [],
};

export const setStatus = mutation({
  args: { incidentId: v.id("incidents"), status: incidentStatus },
  handler: async (ctx, { incidentId, status }) => {
    const incident = await load(ctx, incidentId);
    if (incident.status === status) return;
    if (!TRANSITIONS[incident.status].includes(status)) {
      throw new ConvexError(`Can't change from "${STATUS_LABEL[incident.status]}" to "${STATUS_LABEL[status]}"`);
    }

    const team = incident.assignedTeamId ? await ctx.db.get(incident.assignedTeamId) : null;
    const unassigning = status === "awaiting_assignment";
    // Leaving dispatch (unassigned or resolved) frees the team.
    if (team && (unassigning || status === "resolved") && team.currentAssignment === incident._id) {
      await ctx.db.patch(team._id, { available: true, currentAssignment: null, updatedAt: Date.now() });
    }
    await bump(ctx, incident, unassigning ? { status, assignedTeamId: null } : { status });

    await logActivity(
      ctx,
      unassigning && team
        ? `${team.name} unassigned from ${incident.reportedAddress}; awaiting a team.`
        : `${incident.reportedAddress}: ${STATUS_LABEL[status]}.`,
      incident._id,
    );
    const teamName = team?.name ?? null;
    if (unassigning) await queueCallerUpdate(ctx, incident, "assignment_changed", { teamName });
    if (status === "en_route") await queueCallerUpdate(ctx, incident, "team_en_route", { teamName });
    if (status === "resolved") await queueCallerUpdate(ctx, incident, "rescue_resolved", { teamName });
  },
});

/** Dispatcher-written message for the voice agent to read to the caller word for word. */
export const sendCallerMessage = mutation({
  args: { incidentId: v.id("incidents"), message: v.string() },
  handler: async (ctx, { incidentId, message }) => {
    const incident = await load(ctx, incidentId);
    const text = message.trim();
    if (!incident.callId) throw new ConvexError("This incident has no call to send a message to");
    if (!incident.callConnected) throw new ConvexError("The caller is no longer on the line");
    if (!text) throw new ConvexError("Write a message first");
    if (text.length > 300) throw new ConvexError("Keep caller messages under 300 characters");
    await queueCallerUpdate(ctx, incident, "dispatcher_message", { message: text });
    await logActivity(ctx, `Message queued for caller at ${incident.reportedAddress}: "${text}"`, incident._id);
  },
});

/** What the caller has been told (or will be told) for an incident, newest first. */
export const callerUpdates = query({
  args: { incidentId: v.id("incidents") },
  handler: async (ctx, { incidentId }) => {
    const incident = await ctx.db.get(incidentId);
    if (!incident?.callId) return [];
    const events = await ctx.db
      .query("events")
      .withIndex("by_call_announced", (q) => q.eq("callId", incident.callId!))
      .collect();
    return events
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((e) => ({
        id: e._id,
        type: e.type,
        text: e.text ?? e.type,
        createdAt: e.createdAt,
        state: (e.supersededAt ? "replaced" : e.announcedAt ? "spoken" : "waiting") as "replaced" | "spoken" | "waiting",
      }));
  },
});
