import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { isCurrentEvent, logActivity, requireBackend } from "./lib";
import { advisoryTags, hazard, incidentSource } from "./schema";
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
    callConnected: incident.callConnected,
    decisionRevision: incident.decisionRevision ?? 0,
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
    turnId: v.optional(v.string()),
    sequence: v.optional(v.number()),
    fingerprint: v.optional(v.string()),
    response: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    requireBackend(args.secret);
    const hasTurn = args.turnId !== undefined;
    if (hasTurn !== (args.sequence !== undefined) || hasTurn !== (args.fingerprint !== undefined) ||
        (hasTurn && args.response === undefined)) throw new ConvexError("Incomplete voice turn identity");
    const call = await ctx.db.query("voiceCalls").withIndex("by_call", q => q.eq("callId", args.callId)).unique();
    if (args.turnId !== undefined) {
      const receipt = await ctx.db.query("voiceTurns").withIndex("by_call_turn", q => q.eq("callId", args.callId).eq("turnId", args.turnId!)).unique();
      if (receipt) {
        if (receipt.fingerprint !== args.fingerprint || receipt.sequence !== args.sequence) throw new ConvexError("Turn identity conflict");
        return receipt.result;
      }
      if (!call || call.ended) throw new ConvexError("Voice call is not active");
      if (!Number.isInteger(args.sequence) || args.sequence !== call.nextSequence || !args.fingerprint) throw new ConvexError("Out of order voice turn");
    }
    async function finish(incident: Doc<"incidents">) {
      const status = await confirmedStatus(ctx, incident);
      if (args.turnId === undefined) return status;
      const result = { ...args.response, incident: status };
      await ctx.db.insert("voiceTurns", {callId: args.callId, turnId: args.turnId,
        sequence: args.sequence!, fingerprint: args.fingerprint!, result});
      await ctx.db.patch(call!._id, {nextSequence: args.sequence! + 1});
      return result;
    }
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
        callConnected: true,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      await logActivity(ctx, `Incoming call: ${args.reportedAddress ?? "location not given yet"}.`, id);
      return await finish((await ctx.db.get(id))!);
    }

    // callConnected is left alone: a late utterance after hang-up is saved, but must not
    // reopen the call and restart announcements to a caller who is gone.
    const patch: Partial<Doc<"incidents">> = { transcript: args.transcript };
    if (args.peopleCount != null) patch.peopleCount = args.peopleCount;
    if (args.reportedPosition != null) patch.reportedPosition = args.reportedPosition;
    if (args.summary) patch.summary = args.summary;

    // Each extraction reads the whole transcript, so a non-empty list is the complete current list.
    if (args.hazards.length) patch.hazards = args.hazards;

    // Keep every known fact the caller changed, with its evidence, so a correction loses nothing.
    const history: Doc<"incidents">["factHistory"] = [];
    const changed = (field: string, previous: unknown, next: unknown) => {
      if (previous == null || next == null || previous === next) return;
      history.push({ at: now, field, previous: String(previous), evidence: null });
    };
    changed("peopleCount", existing.peopleCount, patch.peopleCount);
    changed("reportedPosition", existing.reportedPosition, patch.reportedPosition);
    if (existing.reportedAddress !== NO_ADDRESS_YET) changed("reportedAddress", existing.reportedAddress, args.reportedAddress);
    if (patch.hazards) {
      const kept = new Set(patch.hazards.map((h) => h.hazard.trim().toLowerCase()));
      for (const h of existing.hazards) {
        if (!kept.has(h.hazard.trim().toLowerCase())) {
          history.push({ at: now, field: "hazard", previous: h.hazard, evidence: h.evidence });
        }
      }
    }
    if (history.length) patch.factHistory = [...(existing.factHistory ?? []), ...history];

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
      // Anything queued for the caller was decided for the old location.
      patch.decisionRevision = (existing.decisionRevision ?? 0) + 1;
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
        await logActivity(ctx, `Caller corrected location to "${args.reportedAddress}". Needs review.`, existing._id);
      }
    } else if (!existing.locationVerified && args.candidateLatitude != null && args.candidateLongitude != null) {
      patch.latitude = args.candidateLatitude;
      patch.longitude = args.candidateLongitude;
      patch.locationNote = args.candidateLabel ?? null;
    }

    await ctx.db.patch(existing._id, { ...patch, updatedAt: now, version: existing.version + 1 });
    return await finish((await ctx.db.get(existing._id))!);
  },
});

/** The call disconnected. The incident stays open until a dispatcher resolves it. */
export const callEnded = mutation({
  args: { secret: v.string(), callId: v.string() },
  handler: async (ctx, { secret, callId }) => {
    requireBackend(secret);
    const call = await ctx.db.query("voiceCalls").withIndex("by_call", q => q.eq("callId", callId)).unique();
    if (call) await ctx.db.patch(call._id, {ended: true});
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
    const incident = await byCall(ctx, callId);
    // Nothing is spoken to a caller who hung up, and nothing that is no longer true.
    if (!incident || !incident.callConnected) return [];
    const events = await ctx.db
      .query("events")
      .withIndex("by_call_announced", (q) => q.eq("callId", callId).eq("announcedAt", null))
      .collect();
    return events.filter((e) => isCurrentEvent(incident, e));
  },
});

export const markAnnounced = mutation({
  args: { secret: v.string(), callId: v.string(), eventId: v.id("events") },
  handler: async (ctx, { secret, callId, eventId }) => {
    requireBackend(secret);
    const event = await ctx.db.get(eventId);
    if (!event || event.callId !== callId) return { acknowledged: false };
    if (event.announcedAt != null) return { acknowledged: true };
    // Refuse to record a stale update as heard; the voice layer re-polls for the current one.
    const incident = await ctx.db.get(event.incidentId);
    if (!incident || !isCurrentEvent(incident, event)) return { acknowledged: false };
    await ctx.db.patch(eventId, { announcedAt: Date.now() });
    return { acknowledged: true };
  },
});

/**
 * Store optional ModernBERT tags for the call's incident. Writes only `advisoryTags`
 * (not version or facts), and ignores results computed for an older incident version.
 */
export const setAdvisoryTags = mutation({
  args: {
    secret: v.string(),
    callId: v.string(),
    tags: advisoryTags,
  },
  handler: async (ctx, { secret, callId, tags }) => {
    requireBackend(secret);
    const incident = await byCall(ctx, callId);
    if (!incident) return false;
    if (tags.basedOnVersion > incident.version) return false;
    if (incident.advisoryTags && incident.advisoryTags.basedOnVersion > tags.basedOnVersion) return false;
    await ctx.db.patch(incident._id, { advisoryTags: tags });
    return true;
  },
});

export const startVoiceCall = mutation({
  args: {secret: v.string(), callId: v.string()},
  handler: async (ctx, {secret, callId}) => {
    requireBackend(secret);
    const call = await ctx.db.query("voiceCalls").withIndex("by_call", q => q.eq("callId", callId)).unique();
    if (call) {
      if (call.ended) throw new ConvexError("Voice call has ended");
      return {nextSequence: call.nextSequence};
    }
    await ctx.db.insert("voiceCalls", {callId, nextSequence: 1, ended: false});
    return {nextSequence: 1};
  },
});

export const turnReceipt = query({
  args: {secret: v.string(), callId: v.string(), turnId: v.string(), sequence: v.number(), fingerprint: v.string()},
  handler: async (ctx, args) => {
    requireBackend(args.secret);
    const receipt = await ctx.db.query("voiceTurns").withIndex("by_call_turn", q => q.eq("callId", args.callId).eq("turnId", args.turnId)).unique();
    if (!receipt) return null;
    if (receipt.fingerprint !== args.fingerprint || receipt.sequence !== args.sequence) throw new ConvexError("Turn identity conflict");
    return receipt.result;
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
