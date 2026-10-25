import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { queueCallerUpdate, stageText } from "./callerUpdates";
import { getExercise, isCurrentEvent, logActivity, requireBackend } from "./lib";
import { autoGroup, reevaluateLinks, unlink } from "./linking";
import { advisoryTags, callerRole, hazard, incidentSource, riskFactor, withdrawal } from "./schema";
import { EXERCISE_ID } from "./seedData";
import { describeReport, replacesReport, reportMeters, waterLevel, type StoredWaterReport } from "./waterReports";

// Functions for the FastAPI voice backend. Each takes the shared BACKEND_SECRET.

/** Same hazard or factor name, ignoring case and spacing. */
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

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
    callerRole: v.optional(callerRole),
    riskFactors: v.optional(v.array(riskFactor)),
    /** How deep the caller says the water is where they are. */
    waterReport: v.optional(
      v.object({
        level: waterLevel,
        measuredMeters: v.union(v.number(), v.null()),
        floor: v.union(v.number(), v.null()),
        evidence: v.union(v.string(), v.null()),
      }),
    ),
    turnId: v.optional(v.string()),
    sequence: v.optional(v.number()),
    fingerprint: v.optional(v.string()),
    response: v.optional(v.any()),
    /** Explicit caller retractions. Null or missing values are never treated as one. */
    withdrawn: v.optional(v.array(withdrawal)),
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

    // Keep the gauge level at the time of the report, so it stays a local correction as the river changes.
    let water: StoredWaterReport | null = null;
    const meters = args.waterReport ? reportMeters(args.waterReport.level, args.waterReport.measuredMeters) : null;
    if (args.waterReport && meters != null) {
      const exercise = await getExercise(ctx);
      const floor = args.waterReport.floor;
      water = {
        level: args.waterReport.level,
        meters,
        floor: floor != null && floor >= 0 && floor < 60 ? Math.round(floor) : null,
        evidence: args.waterReport.evidence,
        at: now,
        gaugeSurface: exercise?.waterSurfaceElevation ?? 0,
      };
    }

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
        waterReport: water,
        callConnected: true,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      await logActivity(ctx, `Incoming call: ${args.reportedAddress ?? "location not given yet"}.`, id);
      await queueCallerUpdate(ctx, (await ctx.db.get(id))!, "details_received");
      await autoGroup(ctx, id);
      return await finish((await ctx.db.get(id))!);
    }

    // callConnected is left alone: a late utterance after hang-up is saved, but must not
    // reopen the call and restart announcements to a caller who is gone.
    const patch: Partial<Doc<"incidents">> = { transcript: args.transcript };
    const history: Doc<"incidents">["factHistory"] = [];
    const withdrawn = args.withdrawn ?? [];
    const withdrawnNames = (fact: "hazard" | "risk_factor") =>
      withdrawn.filter((w) => w.fact === fact && w.name);

    if (args.peopleCount != null) patch.peopleCount = args.peopleCount;
    // "I don't know how many" makes the count unknown; a new number is a correction instead.
    const countWithdrawal = withdrawn.find((w) => w.fact === "people_count");
    if (countWithdrawal && args.peopleCount == null && existing.peopleCount != null) {
      patch.peopleCount = null;
      history.push({ at: now, field: "peopleCount", previous: String(existing.peopleCount), evidence: null,
        withdrawnBy: countWithdrawal.evidence });
      await logActivity(ctx, `Caller withdrew the people count (was ${existing.peopleCount}); now unknown.`, existing._id);
    }
    if (args.reportedPosition != null) patch.reportedPosition = args.reportedPosition;
    if (args.summary) patch.summary = args.summary;
    if (args.callerRole && args.callerRole !== "unknown") patch.callerRole = args.callerRole;
    // A fact the caller withdrew comes back only with new words, not a re-read of the old ones.
    const stale = (field: string, name: string, evidence: string | null) =>
      (existing.factHistory ?? []).some(
        (h) => h.withdrawnBy != null && h.field === field && same(h.previous, name) && h.evidence === evidence,
      );

    // Risk factors only accumulate: a model omission must never quietly lower priority.
    // Only an explicit caller withdrawal removes one (the dispatcher's override is the other way).
    const known = new Map((existing.riskFactors ?? []).map((r) => [r.factor, r]));
    for (const r of args.riskFactors ?? []) {
      if (!known.has(r.factor) && !stale("riskFactor", r.factor, r.evidence)) known.set(r.factor, r);
    }
    for (const w of withdrawnNames("risk_factor")) {
      const r = [...known.values()].find((x) => same(x.factor, w.name!));
      if (!r) continue;
      known.delete(r.factor);
      if ((existing.riskFactors ?? []).some((e) => e.factor === r.factor)) {
        history.push({ at: now, field: "riskFactor", previous: r.factor, evidence: r.evidence, withdrawnBy: w.evidence });
        await logActivity(ctx, `Caller withdrew "${r.factor.replaceAll("_", " ")}"; check the priority.`, existing._id);
      }
    }
    const currentRisks = [...known.values()];
    if (JSON.stringify(currentRisks) !== JSON.stringify(existing.riskFactors ?? [])) patch.riskFactors = currentRisks;

    // A later description replaces the earlier one; a missing one keeps it.
    const prior = existing.waterReport;
    if (water && replacesReport(prior, water)) {
      patch.waterReport = water;
    }

    // Each extraction reads the whole transcript, so a non-empty list is the complete current list.
    // An empty list means "nothing new", unless the caller explicitly withdrew a hazard.
    const hazardWithdrawals = withdrawnNames("hazard");
    let hazards = (args.hazards.length ? args.hazards : existing.hazards).filter(
      (h) => !stale("hazard", h.hazard, h.evidence),
    );
    const withdrawnHazards: Doc<"incidents">["hazards"] = [];
    for (const w of hazardWithdrawals) {
      const match = (h: { hazard: string }) => same(h.hazard, w.name!);
      // Record the stored hazard, with the words that originally supported it.
      for (const h of existing.hazards.filter(match)) {
        withdrawnHazards.push(h);
        history.push({ at: now, field: "hazard", previous: h.hazard, evidence: h.evidence, withdrawnBy: w.evidence });
        await logActivity(ctx, `Caller withdrew hazard "${h.hazard}".`, existing._id);
      }
      hazards = hazards.filter((h) => !match(h));
    }
    if (args.hazards.length || hazardWithdrawals.length || hazards.length !== existing.hazards.length) {
      patch.hazards = hazards;
    }

    // Keep every known fact the caller changed, with its evidence, so a correction loses nothing.
    const changed = (field: string, previous: unknown, next: unknown) => {
      if (previous == null || next == null || previous === next) return;
      history.push({ at: now, field, previous: String(previous), evidence: null });
    };
    changed("peopleCount", existing.peopleCount, patch.peopleCount);
    changed("reportedPosition", existing.reportedPosition, patch.reportedPosition);
    if (existing.reportedAddress !== NO_ADDRESS_YET) changed("reportedAddress", existing.reportedAddress, args.reportedAddress);
    if (patch.waterReport && prior) {
      history.push({ at: now, field: "waterReport", previous: describeReport(prior), evidence: prior.evidence });
    }
    if (patch.hazards) {
      const kept = new Set([...patch.hazards, ...withdrawnHazards].map((h) => h.hazard.trim().toLowerCase()));
      for (const h of existing.hazards) {
        if (!kept.has(h.hazard.trim().toLowerCase())) {
          history.push({ at: now, field: "hazard", previous: h.hazard, evidence: h.evidence });
        }
      }
    }
    if (history.length) patch.factHistory = [...(existing.factHistory ?? []), ...history];

    const hadAddress = existing.reportedAddress !== NO_ADDRESS_YET;
    let tellCallerLocationUnclear = false;
    if (args.reportedAddress != null) patch.reportedAddress = args.reportedAddress;
    // A linked report only mirrors its main incident's team; it isn't dispatched itself.
    const dispatched = !existing.linkedTo && (existing.status === "assigned" || existing.status === "en_route");

    const norm = (a: string) => a.trim().toLowerCase();
    // A simulated caller's pin comes from the scenario (simulation.pinCall), not their words.
    const corrected =
      existing.source !== "simulation" &&
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
        // Only worth telling the caller if they had already heard the location was confirmed.
        tellCallerLocationUnclear = existing.locationVerified;
      }
    } else if (!existing.locationVerified && args.candidateLatitude != null && args.candidateLongitude != null) {
      patch.latitude = args.candidateLatitude;
      patch.longitude = args.candidateLongitude;
      patch.locationNote = args.candidateLabel ?? null;
    }

    await ctx.db.patch(existing._id, { ...patch, updatedAt: now, version: existing.version + 1 });
    // Queued after the save, so it carries the new decisionRevision.
    if (tellCallerLocationUnclear) await queueCallerUpdate(ctx, existing, "location_unclear");
    const saved = (await ctx.db.get(existing._id))!;
    if (corrected && !dispatched && saved.linkedTo) {
      // A different place may be a different incident, whoever linked it.
      await unlink(ctx, saved, "Caller corrected their location");
    } else {
      // Grouping evidence changed (room, floor, role, pin): re-check links both ways.
      const moved = saved.latitude !== existing.latitude || saved.longitude !== existing.longitude;
      const what = [
        saved.reportedPosition !== existing.reportedPosition && `position "${saved.reportedPosition}"`,
        saved.callerRole !== existing.callerRole && `caller role "${saved.callerRole}"`,
        saved.reportedAddress !== existing.reportedAddress && `address "${saved.reportedAddress}"`,
        moved && "location",
      ].filter(Boolean);
      if (what.length) await reevaluateLinks(ctx, saved._id, `the caller's ${what.join(", ")} changed`);
    }
    await autoGroup(ctx, existing._id);
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
    // Same rule as pendingEvents: nothing for a caller who hung up, nothing no longer true.
    const pending = incident.callConnected
      ? (
          await ctx.db
            .query("events")
            .withIndex("by_call_announced", (q) => q.eq("callId", callId).eq("announcedAt", null))
            .collect()
        ).filter((e) => isCurrentEvent(incident, e))
      : [];
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

/** Names of the call's current hazards, so the extractor can name one the caller withdraws. */
export const recordedHazards = query({
  args: { secret: v.string(), callId: v.string() },
  handler: async (ctx, { secret, callId }) => {
    requireBackend(secret);
    return (await byCall(ctx, callId))?.hazards.map((h) => h.hazard) ?? [];
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

/** Updates that answer "which team / is anyone coming?" when a caller asks for a replay. */
const STATUS_UPDATES: Doc<"events">["type"][] = [
  "assignment_approved",
  "assignment_changed",
  "team_en_route",
  "rescue_resolved",
  "report_linked",
];

/**
 * An update a caller explicitly asked to hear again. It may already have been heard
 * (announced), but only while it is still true: superseded or reversed updates never
 * come back. With `eventId`, that exact update; otherwise the latest current status update.
 */
export const currentAnnouncement = query({
  args: { secret: v.string(), callId: v.string(), eventId: v.optional(v.id("events")) },
  handler: async (ctx, { secret, callId, eventId }) => {
    requireBackend(secret);
    const incident = await byCall(ctx, callId);
    if (!incident || !incident.callConnected) return null;
    if (eventId) {
      const event = await ctx.db.get(eventId);
      return event && event.callId === callId && isCurrentEvent(incident, event) ? event : null;
    }
    const events = await ctx.db
      .query("events")
      .withIndex("by_call_announced", (q) => q.eq("callId", callId))
      .collect();
    return (
      events
        .filter((e) => STATUS_UPDATES.includes(e.type) && isCurrentEvent(incident, e))
        .sort((x, y) => y.createdAt - x.createdAt)[0] ?? null
    );
  },
});

export const markAnnounced = mutation({
  args: { secret: v.string(), callId: v.string(), eventId: v.id("events") },
  handler: async (ctx, { secret, callId, eventId }) => {
    requireBackend(secret);
    const event = await ctx.db.get(eventId);
    if (!event || event.callId !== callId) return { acknowledged: false };
    // Replaced by a newer update before it was spoken: never report it as heard.
    if (event.supersededAt) return { acknowledged: false };
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
