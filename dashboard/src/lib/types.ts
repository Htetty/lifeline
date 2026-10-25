import type { Trip } from "../../convex/tripMath";
import type { StoredWaterReport } from "../../convex/waterReports";

// Dashboard view of the shared data contract. The source of truth is
// convex/schema.ts; ids are Convex document ids.

export type IncidentStatus =
  | "needs_review"
  | "awaiting_assignment"
  | "assigned"
  | "en_route"
  | "resolved";

export type IncidentSource = "live_demo" | "recording" | "fixture" | "map_report" | "simulation";

export interface Incident {
  id: string;
  callId: string | null;
  source: IncidentSource;
  exerciseId: string;
  reportedAddress: string;
  latitude: number | null;
  longitude: number | null;
  locationVerified: boolean;
  /** How an unverified location was found (e.g. a map search match). */
  locationNote?: string | null;
  peopleCount: number | null;
  reportedPosition: string | null;
  hazards: { hazard: string; evidence: string | null }[];
  summary: string;
  transcript: string | null;
  status: IncidentStatus;
  assignedTeamId: string | null;
  /** Whether the caller is still on the line (separate from rescue status). */
  callConnected: boolean;
  /** Caller is among the people needing rescue, or a witness reporting others. */
  callerRole?: "trapped" | "witness" | "unknown";
  /** Main incident this report was linked to (same people), if any. */
  linkedTo?: string | null;
  /** Why it was linked, e.g. "Auto-linked: same room 312". */
  linkNote?: string | null;
  /** Nearby incidents a dispatcher marked as separate rescues. */
  separateFrom?: string[];
  riskFactors?: { factor: RiskFactorKind; evidence: string | null }[];
  /** Latest water depth the caller described (see convex/waterReports.ts). */
  waterReport?: StoredWaterReport | null;
  priorityOverride?: { tier: PriorityTier; reason: string } | null;
  /** Computed on the dashboard for display (not stored). */
  priorityTier?: PriorityTier;
  createdAt: number;
  updatedAt: number;
  version: number;
  decisionRevision?: number;
  /** Earlier values of facts the caller changed, with the words that supported them. */
  factHistory?: {
    at: number;
    field: string;
    previous: string;
    evidence: string | null;
    /** Caller's words taking the fact back; absent for an ordinary correction. */
    withdrawnBy?: string;
  }[];
  /** Optional ModernBERT topic tags. Advisory only; never incident facts. */
  advisoryTags?: {
    status: "ok" | "disabled" | "unavailable";
    tags: string[];
    modelVersion: string | null;
    basedOnVersion: number;
    at: number;
  };
}

export type PriorityTier = "critical" | "high" | "standard";

export type RiskFactorKind =
  | "serious_injury"
  | "medical_need"
  | "water_chest_or_higher"
  | "water_rising_fast"
  | "in_moving_water"
  | "in_vehicle"
  | "no_higher_ground"
  | "on_roof"
  | "child"
  | "elderly"
  | "limited_mobility"
  | "pregnant";

export type TeamCapability = "road_vehicle" | "high_water_vehicle" | "boat" | "air";

export interface RescueTeam {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  available: boolean;
  capabilities: TeamCapability[];
  currentAssignment: string | null;
  updatedAt: number;
  simulated: boolean;
  trip: Trip | null;
}

export interface ActivityEntry {
  id: string;
  at: number;
  message: string;
  incidentId: string | null;
}

export interface ExerciseState {
  exerciseId: string;
  /** Water surface at the river gauge in metres NAVD88. */
  waterSurfaceElevation: number;
  /** Time of the replayed gauge reading behind the level; null when set by hand. */
  waterObservedAt: number | null;
  incidents: Incident[];
  teams: RescueTeam[];
  activity: ActivityEntry[];
}

export const ACTIVE_STATUSES: IncidentStatus[] = ["needs_review", "awaiting_assignment"];
export const DISPATCHED_STATUSES: IncidentStatus[] = ["assigned", "en_route"];

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  needs_review: "Needs review",
  awaiting_assignment: "Awaiting team",
  assigned: "Team assigned",
  en_route: "Team en route",
  resolved: "Resolved",
};
