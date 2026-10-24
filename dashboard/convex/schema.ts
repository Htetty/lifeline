import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Shared data contract for the dashboard (Next.js) and the voice backend (FastAPI).
// Unknown facts stay null rather than being guessed.

export const incidentStatus = v.union(
  v.literal("needs_review"),
  v.literal("awaiting_assignment"),
  v.literal("assigned"),
  v.literal("en_route"),
  v.literal("resolved"),
);

export const incidentSource = v.union(
  v.literal("live_demo"),
  v.literal("recording"),
  v.literal("fixture"),
  v.literal("map_report"),
);

export const hazard = v.object({
  hazard: v.string(),
  /** Caller's words supporting this fact, when it came from a call. */
  evidence: v.union(v.string(), v.null()),
});

/** A fact the caller later changed, kept so a correction never loses evidence. */
export const factChange = v.object({
  at: v.number(),
  field: v.string(),
  previous: v.string(),
  /** Caller's words that supported the previous value, when known. */
  evidence: v.union(v.string(), v.null()),
});

/**
 * Optional ModernBERT topic tags. Advisory only: never copied into incident facts
 * or status. `basedOnVersion` is the incident version the tags were computed for.
 */
export const advisoryTags = v.object({
  status: v.union(v.literal("ok"), v.literal("disabled"), v.literal("unavailable")),
  tags: v.array(v.string()),
  modelVersion: v.union(v.string(), v.null()),
  basedOnVersion: v.number(),
  at: v.number(),
});

export const capability = v.union(
  v.literal("road_vehicle"),
  v.literal("high_water_vehicle"),
  v.literal("boat"),
  v.literal("air"),
);

export default defineSchema({
  exercises: defineTable({
    exerciseId: v.string(),
    name: v.string(),
    /** Simulated water surface elevation, metres above sea level. */
    waterSurfaceElevation: v.number(),
  }).index("by_exerciseId", ["exerciseId"]),

  incidents: defineTable({
    exerciseId: v.string(),
    callId: v.union(v.string(), v.null()),
    source: incidentSource,
    reportedAddress: v.string(),
    latitude: v.union(v.number(), v.null()),
    longitude: v.union(v.number(), v.null()),
    locationVerified: v.boolean(),
    /** How an unverified location was found, e.g. "Map search: Days Inn San Diego Hotel Circle". */
    locationNote: v.optional(v.union(v.string(), v.null())),
    peopleCount: v.union(v.number(), v.null()),
    reportedPosition: v.union(v.string(), v.null()),
    hazards: v.array(hazard),
    summary: v.string(),
    transcript: v.union(v.string(), v.null()),
    status: incidentStatus,
    assignedTeamId: v.union(v.id("teams"), v.null()),
    /** Whether the caller is still connected. Separate from rescue status. */
    callConnected: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
    version: v.number(),
    /** Changes only when a dispatcher decision or its location basis changes. */
    decisionRevision: v.optional(v.number()),
    factHistory: v.optional(v.array(factChange)),
    advisoryTags: v.optional(advisoryTags),
  })
    .index("by_exercise", ["exerciseId"])
    .index("by_callId", ["callId"]),

  teams: defineTable({
    exerciseId: v.string(),
    name: v.string(),
    latitude: v.number(),
    longitude: v.number(),
    available: v.boolean(),
    capabilities: v.array(capability),
    currentAssignment: v.union(v.id("incidents"), v.null()),
    simulated: v.literal(true),
    updatedAt: v.number(),
  }).index("by_exercise", ["exerciseId"]),

  activity: defineTable({
    exerciseId: v.string(),
    at: v.number(),
    message: v.string(),
    incidentId: v.union(v.id("incidents"), v.null()),
  }).index("by_exercise_at", ["exerciseId", "at"]),

  /**
   * Confirmed, caller-relevant updates for the voice agent to announce.
   * Written only after the state change is saved; FastAPI marks them announced.
   */
  events: defineTable({
    exerciseId: v.string(),
    type: v.union(v.literal("assignment_approved"), v.literal("team_en_route"), v.literal("rescue_resolved")),
    incidentId: v.id("incidents"),
    callId: v.string(),
    teamName: v.union(v.string(), v.null()),
    createdAt: v.number(),
    announcedAt: v.union(v.number(), v.null()),
    /** The incident's decisionRevision this event describes; stale once it moves on. */
    decisionRevision: v.optional(v.number()),
  }).index("by_call_announced", ["callId", "announcedAt"]),

  voiceCalls: defineTable({
    callId: v.string(), nextSequence: v.number(), ended: v.boolean(),
  }).index("by_call", ["callId"]),
  voiceTurns: defineTable({
    callId: v.string(), turnId: v.string(), sequence: v.number(),
    fingerprint: v.string(), result: v.any(),
  }).index("by_call_turn", ["callId", "turnId"]),
});
