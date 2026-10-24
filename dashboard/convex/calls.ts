import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { logActivity, requireBackend } from "./lib";
import { hazard, incidentSource } from "./schema";
import { EXERCISE_ID } from "./seedData";

// Functions for the FastAPI voice backend. Each takes the shared BACKEND_SECRET.

async function byCall(ctx: QueryCtx, callId: string) {
  return await ctx.db
    .query("incidents")
    .withIndex("by_callId", (q) => q.eq("callId", callId))
    .first();
}

async function confirmedStatus(ctx: QueryCtx, incident: Doc<"incidents">) {
  const team = incident.assignedTeamId ? await ctx.db.get(incident.assignedTeamId) : null;
  return {
    incidentId: incident._id,
    status: incident.status,
    locationVerified: incident.locationVerified,
    assignedTeamName: team?.name ?? null,
    version: incident.version,
  };
}

/**
 * Create or update the incident for a call from Claude's extracted facts.
 * Null fields mean "not mentioned yet" and never erase known facts.
 */
export const upsertFromCall = mutation({
  args: {
    secret: v.string(),
    callId: v.string(),
    source: incidentSource,
    reportedAddress: v.union(v.string(), v.null()),
    peopleCount: v.union(v.number(), v.null()),
    reportedPosition: v.union(v.string(), v.null()),
    hazards: v.array(hazard),
    summary: v.union(v.string(), v.null()),
    transcript: v.string(),
    /** Candidate coordinates from geocoding, never treated as verified. */
    candidateLatitude: v.optional(v.number()),
    candidateLongitude: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireBackend(args.secret);
    const now = Date.now();
    const existing = await byCall(ctx, args.callId);

    if (!existing) {
      const id = await ctx.db.insert("incidents", {
        exerciseId: EXERCISE_ID,
        callId: args.callId,
        source: args.source,
        reportedAddress: args.reportedAddress ?? "Location not given yet",
        latitude: args.candidateLatitude ?? null,
        longitude: args.candidateLongitude ?? null,
        locationVerified: false,
        peopleCount: args.peopleCount,
        reportedPosition: args.reportedPosition,
        hazards: args.hazards,
        summary: args.summary ?? "",
        transcript: args.transcript,
        status: "needs_review",
        assignedTeamId: null,
        callConnected: true,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      await logActivity(ctx, `Incoming call: ${args.reportedAddress ?? "location not given yet"}.`, id);
      return await confirmedStatus(ctx, (await ctx.db.get(id))!);
    }

    const patch: Partial<Doc<"incidents">> = { transcript: args.transcript, callConnected: true };
    if (args.peopleCount != null) patch.peopleCount = args.peopleCount;
    if (args.reportedPosition != null) patch.reportedPosition = args.reportedPosition;
    if (args.summary) patch.summary = args.summary;

    // Each extraction reads the whole transcript, so a non-empty list is the complete current list.
    if (args.hazards.length) patch.hazards = args.hazards;

    const addressChanged =
      args.reportedAddress != null &&
      args.reportedAddress.trim().toLowerCase() !== existing.reportedAddress.trim().toLowerCase();
    if (addressChanged) {
      patch.reportedAddress = args.reportedAddress!;
      if (existing.status === "needs_review" || existing.status === "awaiting_assignment") {
        // The caller corrected their location: the old pin can't be trusted any more.
        patch.locationVerified = false;
        patch.status = "needs_review";
        patch.latitude = args.candidateLatitude ?? null;
        patch.longitude = args.candidateLongitude ?? null;
      }
      await logActivity(
        ctx,
        existing.status === "assigned" || existing.status === "en_route"
          ? `Caller gave a different location after dispatch: "${args.reportedAddress}". Check with the team.`
          : `Caller location updated to "${args.reportedAddress}". Needs review.`,
        existing._id,
      );
    } else if (!existing.locationVerified && args.candidateLatitude != null && args.candidateLongitude != null) {
      patch.latitude = args.candidateLatitude;
      patch.longitude = args.candidateLongitude;
    }

    await ctx.db.patch(existing._id, { ...patch, updatedAt: now, version: existing.version + 1 });
    return await confirmedStatus(ctx, (await ctx.db.get(existing._id))!);
  },
});

/** The call disconnected. The incident stays open until a dispatcher resolves it. */
export const callEnded = mutation({
  args: { secret: v.string(), callId: v.string() },
  handler: async (ctx, { secret, callId }) => {
    requireBackend(secret);
    const incident = await byCall(ctx, callId);
    if (!incident || !incident.callConnected) return;
    await ctx.db.patch(incident._id, { callConnected: false, updatedAt: Date.now() });
    await logActivity(ctx, `Call ended for ${incident.reportedAddress}; incident remains open.`, incident._id);
  },
});

/** Confirmed status of the call's incident, for the voice agent's context. */
export const statusForCall = query({
  args: { secret: v.string(), callId: v.string() },
  handler: async (ctx, { secret, callId }) => {
    requireBackend(secret);
    const incident = await byCall(ctx, callId);
    return incident ? await confirmedStatus(ctx, incident) : null;
  },
});

/** Updates waiting to be spoken to this caller, oldest first. */
export const pendingEvents = query({
  args: { secret: v.string(), callId: v.string() },
  handler: async (ctx, { secret, callId }) => {
    requireBackend(secret);
    return await ctx.db
      .query("events")
      .withIndex("by_call_announced", (q) => q.eq("callId", callId).eq("announcedAt", null))
      .collect();
  },
});

export const markAnnounced = mutation({
  args: { secret: v.string(), eventId: v.id("events") },
  handler: async (ctx, { secret, eventId }) => {
    requireBackend(secret);
    const event = await ctx.db.get(eventId);
    if (event && event.announcedAt == null) await ctx.db.patch(eventId, { announcedAt: Date.now() });
  },
});
