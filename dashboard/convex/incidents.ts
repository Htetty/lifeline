import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { autoGroup, bump, linkedReports, linkInto, reevaluateLinks } from "./linking";
import { queueCallerUpdate } from "./callerUpdates";
import { isCurrentEvent, logActivity, requireDispatcher } from "./lib";
import { incidentStatus, priorityTier } from "./schema";
import { EXERCISE_ID } from "./seedData";
import { beginTrip, routePlan, stopTrip } from "./trips";

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

function rejectIfLinked(incident: Doc<"incidents">) {
  if (incident.linkedTo) {
    throw new ConvexError("This report is linked to another incident. Manage the main report, or unlink it first.");
  }
}

/** Linked reports follow the main incident's status and team, and their callers hear the same progress. */
async function syncLinked(
  ctx: MutationCtx,
  main: Doc<"incidents">,
  patch: Pick<Doc<"incidents">, "status" | "assignedTeamId">,
  update: Doc<"events">["type"] | null,
  teamName: string | null,
) {
  for (const report of await linkedReports(ctx, main._id)) {
    await bump(ctx, report, patch, true);
    if (update) await queueCallerUpdate(ctx, report, update, { teamName });
  }
}

/** A dispatcher marks people stuck in a building directly on the map. */
export const reportFromMap = mutation({
  args: {
    latitude: v.number(),
    longitude: v.number(),
    peopleCount: v.union(v.number(), v.null()),
    reportedPosition: v.union(v.string(), v.null()),
    reportedAddress: v.string(),
    dispatcherToken: v.optional(v.string()),
  },
  handler: async (ctx, { dispatcherToken, ...args }) => {
    requireDispatcher(dispatcherToken);
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
    await autoGroup(ctx, id);
    return id;
  },
});

/** Dispatcher confirms the candidate location, or places the incident on a building. */
export const verifyLocation = mutation({
  args: {
    incidentId: v.id("incidents"),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    dispatcherToken: v.optional(v.string()),
  },
  handler: async (ctx, { dispatcherToken, incidentId, latitude, longitude }) => {
    requireDispatcher(dispatcherToken);
    const incident = await load(ctx, incidentId);
    rejectIfLinked(incident);
    if (incident.locationVerified && latitude == null && longitude == null) return;
    const moving = latitude != null && (latitude !== incident.latitude || longitude !== incident.longitude);
    if (moving && incident.status !== "needs_review" && incident.status !== "awaiting_assignment") {
      throw new ConvexError("A team is already dispatched here. Unassign the team before moving the location.");
    }
    const lat = latitude ?? incident.latitude;
    const lon = longitude ?? incident.longitude;
    if (lat == null || lon == null) throw new ConvexError("Place the incident on the map first");
    // Moving the pin is a decision: anything queued for the old location is stale.
    await bump(
      ctx,
      incident,
      {
        latitude: lat,
        longitude: lon,
        locationVerified: true,
        locationNote: latitude != null ? "Placed by dispatcher" : incident.locationNote,
        status: incident.status === "needs_review" ? "awaiting_assignment" : incident.status,
      },
      moving,
    );
    await logActivity(ctx, `Location confirmed for ${incident.reportedAddress}.`, incident._id);
    if (!incident.locationVerified) await queueCallerUpdate(ctx, incident, "location_confirmed");
    if (moving) await reevaluateLinks(ctx, incident._id, "the dispatcher moved the pin");
    await autoGroup(ctx, incident._id);
  },
});

/** Approve a team. Runs as one transaction, so a team can't be double-booked. */
export const assignTeam = mutation({
  args: { dispatcherToken: v.optional(v.string()), incidentId: v.id("incidents"), teamId: v.id("teams") },
  handler: async (ctx, { dispatcherToken, incidentId, teamId }) => {
    requireDispatcher(dispatcherToken);
    const incident = await load(ctx, incidentId);
    rejectIfLinked(incident);
    const team = await ctx.db.get(teamId);
    if (!team) throw new ConvexError("Team not found");
    if (!incident.locationVerified) throw new ConvexError("Confirm the location before assigning a team");
    if (!team.available) throw new ConvexError(`${team.name} is no longer available`);
    if (incident.status !== "awaiting_assignment") throw new ConvexError("Incident is not awaiting a team");

    await assignTeamTo(ctx, incident, team);
  },
});

/**
 * The one way a team is assigned (manual approval and approved plans alike). Callers check
 * that the pair is valid first; this saves it in the caller's transaction and queues the
 * approved caller update, which is only delivered once the transaction commits.
 */
export async function assignTeamTo(ctx: MutationCtx, incident: Doc<"incidents">, team: Doc<"teams">) {
  await bump(ctx, incident, { status: "assigned", assignedTeamId: team._id }, true);
  await ctx.db.patch(team._id, { available: false, currentAssignment: incident._id, updatedAt: Date.now() });
  await logActivity(ctx, `${team.name} assigned to ${incident.reportedAddress}.`, incident._id);
  await queueCallerUpdate(ctx, incident, "assignment_approved", { teamName: team.name });
  await syncLinked(ctx, incident, { status: "assigned", assignedTeamId: team._id }, "assignment_approved", team.name);
}

/** Allowed status changes. Assignment itself goes through assignTeam. */
const TRANSITIONS: Record<Doc<"incidents">["status"], Doc<"incidents">["status"][]> = {
  needs_review: ["resolved"],
  awaiting_assignment: ["resolved"],
  assigned: ["en_route", "awaiting_assignment", "resolved"],
  en_route: ["awaiting_assignment", "resolved"],
  resolved: [],
};

export const setStatus = mutation({
  args: {
    dispatcherToken: v.optional(v.string()),
    incidentId: v.id("incidents"),
    status: incidentStatus,
    /** Flood-aware route for the team when going en route; without one, Convex plans a fallback. */
    plan: v.optional(routePlan),
  },
  handler: async (ctx, { dispatcherToken, incidentId, status, plan }) => {
    requireDispatcher(dispatcherToken);
    const incident = await load(ctx, incidentId);
    rejectIfLinked(incident);
    if (incident.status === status) return;
    if (!TRANSITIONS[incident.status].includes(status)) {
      throw new ConvexError(`Can't change from "${STATUS_LABEL[incident.status]}" to "${STATUS_LABEL[status]}"`);
    }
    await applyStatus(ctx, incident, status, plan);
  },
});

/**
 * Saves an allowed status change (checked by the caller) with everything that goes with it:
 * freeing or sending the team, the activity log, caller updates and linked reports.
 */
export async function applyStatus(
  ctx: MutationCtx,
  incident: Doc<"incidents">,
  status: Doc<"incidents">["status"],
  plan?: Infer<typeof routePlan>,
) {
  const team = incident.assignedTeamId ? await ctx.db.get(incident.assignedTeamId) : null;
  const unassigning = status === "awaiting_assignment";
  // Leaving dispatch (unassigned or resolved) frees the team.
  if (team && (unassigning || status === "resolved") && team.currentAssignment === incident._id) {
    await stopTrip(ctx, team);
    await ctx.db.patch(team._id, { available: true, currentAssignment: null, updatedAt: Date.now() });
  }
  await bump(ctx, incident, unassigning ? { status, assignedTeamId: null } : { status }, true);
  // After the status is saved, so the trip sees the incident as en route.
  if (team && status === "en_route") {
    if (plan) await beginTrip(ctx, team._id, incident._id, { ...plan, route: "planned" });
    else await ctx.scheduler.runAfter(0, internal.trips.planTrip, { teamId: team._id, incidentId: incident._id });
  }

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
  const update = unassigning
    ? "assignment_changed"
    : status === "en_route"
      ? "team_en_route"
      : status === "resolved"
        ? "rescue_resolved"
        : null;
  await syncLinked(
    ctx,
    incident,
    { status, assignedTeamId: unassigning ? null : incident.assignedTeamId },
    update,
    teamName,
  );
}

/**
 * Link reports about the same people to a main incident (e.g. ten witnesses calling about one
 * family on a roof). Linked reports leave the queue and map, follow the main incident's status
 * and team, and their callers hear its progress. Separate rescues in the same building
 * (different floors, different families) should stay separate.
 */
export const linkReports = mutation({
  args: { dispatcherToken: v.optional(v.string()), mainId: v.id("incidents"), reportIds: v.array(v.id("incidents")) },
  handler: async (ctx, { dispatcherToken, mainId, reportIds }) => {
    requireDispatcher(dispatcherToken);
    let main = await load(ctx, mainId);
    if (main.linkedTo) main = await load(ctx, main.linkedTo); // always link to the top-level incident
    if (main.status === "resolved") throw new ConvexError("The main incident is already resolved");

    for (const reportId of reportIds) {
      const report = await load(ctx, reportId);
      if (report._id === main._id || report.linkedTo === main._id) continue;
      if (report.status === "resolved") throw new ConvexError(`"${report.reportedAddress}" is already resolved`);
      if (report.status === "assigned" || report.status === "en_route") {
        throw new ConvexError(`"${report.reportedAddress}" has its own team. Unassign it before linking.`);
      }
      await linkInto(ctx, main, report, "Linked by dispatcher");
    }
  },
});

/** Undo a link: the report becomes its own incident again, without a team. */
export const unlinkReport = mutation({
  args: { dispatcherToken: v.optional(v.string()), reportId: v.id("incidents") },
  handler: async (ctx, { dispatcherToken, reportId }) => {
    requireDispatcher(dispatcherToken);
    const report = await load(ctx, reportId);
    if (!report.linkedTo) return;
    const main = await load(ctx, report.linkedTo);
    // Remember they're separate, so automatic grouping doesn't link them again.
    await bump(ctx, report, {
      linkedTo: null,
      linkNote: null,
      assignedTeamId: null,
      status: report.locationVerified ? "awaiting_assignment" : "needs_review",
      separateFrom: [...new Set([...(report.separateFrom ?? []), main._id])],
    }, true);
    await bump(ctx, main, { separateFrom: [...new Set([...(main.separateFrom ?? []), report._id])] });
    await logActivity(ctx, `Report "${report.reportedAddress}" unlinked; now its own incident.`, report._id);
  },
});

/** Dispatcher says two nearby incidents are separate rescues (stops suggesting a link). */
export const markSeparate = mutation({
  args: { dispatcherToken: v.optional(v.string()), incidentId: v.id("incidents"), otherId: v.id("incidents") },
  handler: async (ctx, { dispatcherToken, incidentId, otherId }) => {
    requireDispatcher(dispatcherToken);
    const [a, b] = [await load(ctx, incidentId), await load(ctx, otherId)];
    const add = (i: Doc<"incidents">, other: Id<"incidents">) =>
      bump(ctx, i, { separateFrom: [...new Set([...(i.separateFrom ?? []), other])] });
    await add(a, b._id);
    await add(b, a._id);
  },
});

/** Dispatcher-written message for the voice agent to read to the caller word for word. */
export const sendCallerMessage = mutation({
  args: { dispatcherToken: v.optional(v.string()), incidentId: v.id("incidents"), message: v.string() },
  handler: async (ctx, { dispatcherToken, incidentId, message }) => {
    requireDispatcher(dispatcherToken);
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
  args: { dispatcherToken: v.optional(v.string()), incidentId: v.id("incidents") },
  handler: async (ctx, { dispatcherToken, incidentId }) => {
    requireDispatcher(dispatcherToken);
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
        state: (e.announcedAt && !e.supersededAt
          ? "spoken"
          : e.supersededAt || !isCurrentEvent(incident, e)
            ? "replaced"
            : incident.callConnected
              ? "waiting"
              : "not delivered") as "replaced" | "spoken" | "waiting" | "not delivered",
      }));
  },
});

/** Dispatcher overrides the computed priority (or clears the override with tier null). */
export const setPriorityOverride = mutation({
  args: {
    dispatcherToken: v.optional(v.string()),
    incidentId: v.id("incidents"),
    tier: v.union(priorityTier, v.null()),
    reason: v.string(),
  },
  handler: async (ctx, { dispatcherToken, incidentId, tier, reason }) => {
    requireDispatcher(dispatcherToken);
    const incident = await load(ctx, incidentId);
    const why = reason.trim();
    if (tier && !why) throw new ConvexError("Give a reason for changing the priority");
    await bump(ctx, incident, { priorityOverride: tier ? { tier, reason: why } : null });
    await logActivity(
      ctx,
      tier
        ? `Priority for ${incident.reportedAddress} set to ${tier} by dispatcher: ${why}`
        : `Priority override cleared for ${incident.reportedAddress}.`,
      incident._id,
    );
  },
});

/** One-off: group obvious duplicates among existing incidents (`npx convex run incidents:autoGroupAll`). */
export const autoGroupAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const open = (
      await ctx.db
        .query("incidents")
        .withIndex("by_exercise", (q) => q.eq("exerciseId", EXERCISE_ID))
        .collect()
    ).sort((a, b) => a.createdAt - b.createdAt);
    for (const incident of open) await autoGroup(ctx, incident._id);
    const linked = (await ctx.db.query("incidents").collect()).filter((i) => i.linkedTo).length;
    return { linked };
  },
});
