import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { queueCallerUpdate, stageText } from "./callerUpdates";
import { logActivity, requireBackend } from "./lib";
import { autoGroup } from "./linking";
import { callerRole, hazard, incidentSource, riskFactor } from "./schema";
import { EXERCISE_ID } from "./seedData";

// Functions for the FastAPI voice backend. Each takes the shared BACKEND_SECRET.

const NO_ADDRESS_YET = "Location not given yet";

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
    candidateLabel: v.optional(v.string()),
    /**
     * True only when the caller changed or took back a location they gave earlier.
     * Rewording the same place is not a change.
     */
    locationChanged: v.optional(v.boolean()),
    callerRole: v.optional(callerRole),
    riskFactors: v.optional(v.array(riskFactor)),
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
        reportedAddress: args.reportedAddress ?? NO_ADDRESS_YET,
        latitude: args.candidateLatitude ?? null,
        longitude: args.candidateLongitude ?? null,
        locationVerified: false,
        locationNote: args.candidateLabel ?? null,
        peopleCount: args.peopleCount,
        reportedPosition: args.reportedPosition,
        hazards: args.hazards,
        summary: args.summary ?? "",
        transcript: args.transcript,
        status: "needs_review",
        assignedTeamId: null,
        callerRole: args.callerRole ?? "unknown",
        riskFactors: args.riskFactors ?? [],
        callConnected: true,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      await logActivity(ctx, `Incoming call: ${args.reportedAddress ?? "location not given yet"}.`, id);
      const created = (await ctx.db.get(id))!;
      await queueCallerUpdate(ctx, created, "details_received");
      await autoGroup(ctx, id);
      return await confirmedStatus(ctx, (await ctx.db.get(id))!);
    }

    const patch: Partial<Doc<"incidents">> = { transcript: args.transcript, callConnected: true };
    if (args.peopleCount != null) patch.peopleCount = args.peopleCount;
    if (args.reportedPosition != null) patch.reportedPosition = args.reportedPosition;
    if (args.summary) patch.summary = args.summary;
    if (args.callerRole && args.callerRole !== "unknown") patch.callerRole = args.callerRole;
    // Risk factors only accumulate: a model omission must never quietly lower priority.
    // The dispatcher's override is the way to lower it.
    const known = new Map((existing.riskFactors ?? []).map((r) => [r.factor, r]));
    for (const r of args.riskFactors ?? []) if (!known.has(r.factor)) known.set(r.factor, r);
    if (known.size !== (existing.riskFactors ?? []).length) patch.riskFactors = [...known.values()];

    // Each extraction reads the whole transcript, so a non-empty list is the complete current list.
    if (args.hazards.length) patch.hazards = args.hazards;

    const hadAddress = existing.reportedAddress !== NO_ADDRESS_YET;
    if (args.reportedAddress != null) patch.reportedAddress = args.reportedAddress;
    const dispatched = existing.status === "assigned" || existing.status === "en_route";

    const norm = (a: string) => a.trim().toLowerCase();
    const corrected =
      args.locationChanged === true &&
      hadAddress &&
      args.reportedAddress != null &&
      norm(args.reportedAddress) !== norm(existing.reportedAddress);

    if (corrected) {
      if (dispatched) {
        // Don't silently move a team's destination; flag it for the dispatcher.
        await logActivity(
          ctx,
          `Caller gave a different location after dispatch: "${args.reportedAddress}". Check with the team.`,
          existing._id,
        );
      } else {
        // The caller corrected their location: the old pin can't be trusted any more.
        patch.locationVerified = false;
        patch.status = "needs_review";
        patch.latitude = args.candidateLatitude ?? null;
        patch.longitude = args.candidateLongitude ?? null;
        patch.locationNote = args.candidateLabel ?? null;
        patch.linkedTo = null; // a different place may be a different incident
        await logActivity(ctx, `Caller corrected location to "${args.reportedAddress}". Needs review.`, existing._id);
        // Only worth telling the caller if they had already heard the location was confirmed.
        if (existing.locationVerified) await queueCallerUpdate(ctx, existing, "location_unclear");
      }
    } else if (!existing.locationVerified && args.candidateLatitude != null && args.candidateLongitude != null) {
      patch.latitude = args.candidateLatitude;
      patch.longitude = args.candidateLongitude;
      patch.locationNote = args.candidateLabel ?? null;
    }

    await ctx.db.patch(existing._id, { ...patch, updatedAt: now, version: existing.version + 1 });
    await autoGroup(ctx, existing._id);
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

/**
 * Everything the voice agent needs about a call, as one reactive query:
 * a status card (confirmed facts + what it may say if asked) and the updates
 * waiting to be spoken. FastAPI subscribes to this and pushes changes to the agent.
 */
export const callState = query({
  args: { secret: v.string(), callId: v.string() },
  handler: async (ctx, { secret, callId }) => {
    requireBackend(secret);
    const incident = await byCall(ctx, callId);
    if (!incident) return { status: null, pending: [] };
    const team = incident.assignedTeamId ? await ctx.db.get(incident.assignedTeamId) : null;
    const teamName = team?.name ?? null;
    const pending = await ctx.db
      .query("events")
      .withIndex("by_call_announced", (q) => q.eq("callId", callId).eq("announcedAt", null))
      .collect();
    return {
      status: {
        incidentId: incident._id,
        version: incident.version,
        stage: incident.status,
        sayIfAsked: stageText(incident, teamName),
        locationConfirmed: incident.locationVerified,
        reportedAddress: incident.reportedAddress,
        peopleCount: incident.peopleCount,
        reportedPosition: incident.reportedPosition,
        hazards: incident.hazards.map((h) => h.hazard),
        assignedTeamName: teamName,
        callConnected: incident.callConnected,
        callerRole: incident.callerRole ?? "unknown",
        linkedToAnotherReport: Boolean(incident.linkedTo),
      },
      pending: pending
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((e) => ({ eventId: e._id, type: e.type, text: e.text ?? e.type, createdAt: e.createdAt })),
    };
  },
});

/** Saved transcript, so a restarted backend can continue a call where it left off. */
export const transcriptForCall = query({
  args: { secret: v.string(), callId: v.string() },
  handler: async (ctx, { secret, callId }) => {
    requireBackend(secret);
    return (await byCall(ctx, callId))?.transcript ?? null;
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
  args: { secret: v.string(), callId: v.string(), eventId: v.id("events") },
  handler: async (ctx, { secret, callId, eventId }) => {
    requireBackend(secret);
    const event = await ctx.db.get(eventId);
    if (event && event.callId === callId && event.announcedAt == null) {
      await ctx.db.patch(eventId, { announcedAt: Date.now() });
    }
  },
});

/** Delete incidents created by the regression checks (callId starting "check-" or "review-test-"), once resolved. */
export const purgeCheckIncidents = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    requireBackend(secret);
    const incidents = await ctx.db
      .query("incidents")
      .withIndex("by_exercise", (q) => q.eq("exerciseId", EXERCISE_ID))
      .collect();
    let removed = 0;
    for (const incident of incidents) {
      if (!/^(check|review-test)-/.test(incident.callId ?? "") || incident.status !== "resolved") continue;
      const activity = await ctx.db
        .query("activity")
        .withIndex("by_exercise_at", (q) => q.eq("exerciseId", EXERCISE_ID))
        .collect();
      for (const a of activity) if (a.incidentId === incident._id) await ctx.db.delete(a._id);
      const events = await ctx.db
        .query("events")
        .withIndex("by_call_announced", (q) => q.eq("callId", incident.callId!))
        .collect();
      for (const e of events) await ctx.db.delete(e._id);
      await ctx.db.delete(incident._id);
      removed++;
    }
    return removed;
  },
});
