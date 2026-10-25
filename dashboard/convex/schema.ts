import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { callerUpdateType } from "./callerUpdates";
import { storedWaterReport } from "./waterReports";

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

/** Risk factors a caller reported. Rules in src/lib/priority.ts turn these into a priority tier. */
export const riskFactorKind = v.union(
  v.literal("serious_injury"),
  v.literal("medical_need"),
  v.literal("water_chest_or_higher"),
  v.literal("water_rising_fast"),
  v.literal("in_moving_water"),
  v.literal("in_vehicle"),
  v.literal("no_higher_ground"),
  v.literal("on_roof"),
  v.literal("child"),
  v.literal("elderly"),
  v.literal("limited_mobility"),
  v.literal("pregnant"),
);

export const riskFactor = v.object({
  factor: riskFactorKind,
  /** Caller's words supporting it. */
  evidence: v.union(v.string(), v.null()),
});

export const priorityTier = v.union(v.literal("critical"), v.literal("high"), v.literal("standard"));

/** Whether the caller is among the people needing rescue or reporting others. */
export const callerRole = v.union(v.literal("trapped"), v.literal("witness"), v.literal("unknown"));
/** A fact the caller later changed, kept so a correction never loses evidence. */
export const factChange = v.object({
  at: v.number(),
  field: v.string(),
  previous: v.string(),
  /** Caller's words that supported the previous value, when known. */
  evidence: v.union(v.string(), v.null()),
  /** Set when the caller explicitly took the fact back: their words doing so. */
  withdrawnBy: v.optional(v.string()),
});

/** A fact the caller explicitly took back in their latest message (never inferred from silence). */
export const withdrawal = v.object({
  fact: v.union(v.literal("people_count"), v.literal("hazard"), v.literal("risk_factor")),
  /** Hazard name or risk factor id; null for people_count. */
  name: v.union(v.string(), v.null()),
  evidence: v.string(),
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

/** In brief, what the dashboard's flood-aware router returned for a team and incident (see convex/planning.ts). */
export const routeEvidence = v.object({
  mover: v.union(v.literal("road_vehicle"), v.literal("high_water_vehicle"), v.literal("boat"), v.literal("air")),
  realSeconds: v.number(),
  start: v.array(v.number()),
  end: v.array(v.number()),
  points: v.number(),
  modes: v.array(v.union(v.literal("road"), v.literal("water"), v.literal("foot"), v.literal("air"))),
  maxDepth: v.number(),
  limit: v.union(v.number(), v.null()),
});

export default defineSchema({
  exercises: defineTable({
    exerciseId: v.string(),
    name: v.string(),
    /** Water surface at the Fashion Valley river gauge, metres NAVD88. */
    waterSurfaceElevation: v.number(),
    /** Time of the replayed gauge reading behind the level; null when set by hand. */
    waterObservedAt: v.optional(v.union(v.number(), v.null())),
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
    riskFactors: v.optional(v.array(riskFactor)),
    /** Latest water depth the caller described; corrects the simulated flood around them. */
    waterReport: v.optional(v.union(storedWaterReport, v.null())),
    /** Dispatcher's override of the computed priority, with their reason. */
    priorityOverride: v.optional(v.union(v.object({ tier: priorityTier, reason: v.string() }), v.null())),
    /**
     * Set when a dispatcher links this report to another one about the same people:
     * this report then follows the main incident's status and team.
     */
    linkedTo: v.optional(v.union(v.id("incidents"), v.null())),
    /** Why it was linked, e.g. "Auto-linked: same room 312" or "Linked by dispatcher". */
    linkNote: v.optional(v.union(v.string(), v.null())),
    /** Nearby incidents the dispatcher said are separate rescues (hides the suggestion). */
    separateFrom: v.optional(v.array(v.id("incidents"))),
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
    /** Simulated trip to an incident (see tripMath.ts); null when the team is stationary. */
    trip: v.optional(
      v.union(
        v.object({
          incidentId: v.id("incidents"),
          path: v.array(v.array(v.number())),
          departAt: v.number(),
          arriveAt: v.number(),
          route: v.union(v.literal("planned"), v.literal("road"), v.literal("direct")),
          legs: v.optional(
            v.array(
              v.object({
                mode: v.union(v.literal("road"), v.literal("water"), v.literal("foot"), v.literal("air")),
                end: v.number(),
              }),
            ),
          ),
          realSeconds: v.number(),
        }),
        v.null(),
      ),
    ),
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
    /** The incident's decisionRevision this event describes; stale once it moves on. */
    decisionRevision: v.optional(v.number()),
  }).index("by_call_announced", ["callId", "announcedAt"]),

  /**
   * Assignment suggestions the dashboard computed, as the dispatcher saw them. Recording one
   * changes nothing else. `inputs` is the server's own snapshot of the planning inputs then.
   */
  assignmentPlans: defineTable({
    exerciseId: v.string(),
    planId: v.string(),
    /** Fingerprint of the inputs the dashboard planned from. */
    fingerprint: v.string(),
    /** Whether that matched the server's inputs when the plan was recorded. */
    matchedServer: v.boolean(),
    inputs: v.string(),
    /** The dashboard's fingerprint of every caller water report it planned with (resolved ones too).
     * Required on new plans; optional only so older rows still load (they can't be approved). */
    flood: v.optional(v.string()),
    proposals: v.array(
      v.object({
        incidentId: v.id("incidents"),
        teamId: v.id("teams"),
        tier: priorityTier,
        seconds: v.number(),
        reason: v.string(),
        /** The route the dispatcher was shown; approval must send this same route. Required on
         * new plans; optional only so older rows still load (they can't be approved). */
        evidence: v.optional(routeEvidence),
      }),
    ),
    unassigned: v.array(v.object({ incidentId: v.id("incidents"), reason: v.string() })),
    status: v.union(v.literal("proposed"), v.literal("approved")),
    createdAt: v.number(),
  })
    .index("by_planId", ["planId"])
    .index("by_exercise", ["exerciseId"]),

  /** Every approval attempt on a plan: what was applied, or why it was refused. */
  planDecisions: defineTable({
    exerciseId: v.string(),
    approvalId: v.string(),
    planId: v.string(),
    outcome: v.union(v.literal("approved"), v.literal("rejected_stale"), v.literal("rejected_invalid")),
    reason: v.union(v.string(), v.null()),
    selected: v.array(v.object({ incidentId: v.id("incidents"), teamId: v.id("teams") })),
    /** Fingerprint of the whole request, so a reused approvalId can only repeat the same request. */
    request: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_approvalId", ["approvalId"])
    .index("by_exercise", ["exerciseId"]),

  voiceCalls: defineTable({
    callId: v.string(), nextSequence: v.number(), ended: v.boolean(),
  }).index("by_call", ["callId"]),
  voiceTurns: defineTable({
    callId: v.string(), turnId: v.string(), sequence: v.number(),
    fingerprint: v.string(), result: v.any(),
  }).index("by_call_turn", ["callId", "turnId"]),
});
