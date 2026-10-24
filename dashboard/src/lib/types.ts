// Dashboard view of the shared data contract. The source of truth is
// convex/schema.ts; ids are Convex document ids.

export type IncidentStatus =
  | "needs_review"
  | "awaiting_assignment"
  | "assigned"
  | "en_route"
  | "resolved";

export type IncidentSource = "live_demo" | "recording" | "fixture" | "map_report";

export interface Incident {
  id: string;
  callId: string | null;
  source: IncidentSource;
  exerciseId: string;
  reportedAddress: string;
  latitude: number | null;
  longitude: number | null;
  locationVerified: boolean;
  peopleCount: number | null;
  reportedPosition: string | null;
  hazards: { hazard: string; evidence: string | null }[];
  summary: string;
  transcript: string | null;
  status: IncidentStatus;
  assignedTeamId: string | null;
  /** Whether the caller is still on the line (separate from rescue status). */
  callConnected: boolean;
  createdAt: number;
  updatedAt: number;
  version: number;
}

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
}

export interface ActivityEntry {
  id: string;
  at: number;
  message: string;
  incidentId: string | null;
}

export interface ExerciseState {
  exerciseId: string;
  /** Simulated water surface elevation in metres above sea level (NAVD88-ish). */
  waterSurfaceElevation: number;
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
