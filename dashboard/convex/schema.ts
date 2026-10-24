import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { callerUpdateType } from "./callerUpdates";

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

/** Whether the caller is among the people needing rescue or reporting others. */
export const callerRole = v.union(v.literal("trapped"), v.literal("witness"), v.literal("unknown"));

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
    callerRole: v.optional(callerRole),
    /**
     * Set when a dispatcher links this report to another one about the same people:
     * this report then follows the main incident's status and team.
     */
    linkedTo: v.optional(v.union(v.id("incidents"), v.null())),
    /** Nearby incidents the dispatcher said are separate rescues (hides the suggestion). */
    separateFrom: v.optional(v.array(v.id("incidents"))),
    /** Whether the caller is still connected. Separate from rescue status. */
    callConnected: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
    version: v.number(),
  })
    .index("by_exercise", ["exerciseId"])
    .index("by_callId", ["callId"])
    .index("by_linkedTo", ["linkedTo"]),

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
   * Confirmed, caller-relevant updates for the voice agent to speak.
   * Written only after the state change is saved; FastAPI acknowledges them once played.
   * A newer progress update supersedes an unspoken older one.
   */
  events: defineTable({
    exerciseId: v.string(),
    type: callerUpdateType,
    incidentId: v.id("incidents"),
    callId: v.string(),
    teamName: v.union(v.string(), v.null()),
    /** Exact words for the caller (optional for rows written before this field existed). */
    text: v.optional(v.string()),
    createdAt: v.number(),
    announcedAt: v.union(v.number(), v.null()),
    /** Set when replaced by a newer update before being spoken. */
    supersededAt: v.optional(v.union(v.number(), v.null())),
  }).index("by_call_announced", ["callId", "announcedAt"]),
});
