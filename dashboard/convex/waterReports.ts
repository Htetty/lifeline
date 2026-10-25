import { v } from "convex/values";

// How deep a caller says the water is. Claude picks the body reference the caller
// meant; this fixed table turns it into metres, so the same words always give the
// same depth. When the caller describes the water some other way, Claude estimates
// the depth ("estimated"), and when they only say there is water, a small fixed
// depth stands for it ("present"). Shared by Convex and the dashboard.

export const waterLevel = v.union(
  v.literal("ankle"),
  v.literal("knee"),
  v.literal("thigh"),
  v.literal("waist"),
  v.literal("chest"),
  v.literal("neck"),
  v.literal("over_head"),
  v.literal("measured"),
  v.literal("estimated"),
  v.literal("present"),
);

export type WaterLevel =
  | "ankle"
  | "knee"
  | "thigh"
  | "waist"
  | "chest"
  | "neck"
  | "over_head"
  | "measured"
  | "estimated"
  | "present";

/** Levels whose depth comes from the caller's or Claude's number rather than the table. */
type NumericLevel = "measured" | "estimated";

/** Depth assumed when a caller says there is water but not how deep, metres. */
export const PRESENT_METERS = 0.3;
/** Claude's estimates are trusted only up to this depth, metres. */
export const MAX_ESTIMATE_METERS = 6;
/** A new estimate within this of the stored one is the same description, metres; it keeps the map steady. */
export const ESTIMATE_TOLERANCE_METERS = 0.3;

/** Typical adult heights of each reference, metres above the floor they stand on. */
export const LEVEL_METERS: Record<Exclude<WaterLevel, NumericLevel>, number> = {
  ankle: 0.15,
  knee: 0.5,
  thigh: 0.7,
  waist: 1.0,
  chest: 1.3,
  neck: 1.5,
  over_head: 2.0,
  present: PRESENT_METERS,
};

export const LEVEL_LABEL: Record<WaterLevel, string> = {
  ankle: "ankle-deep",
  knee: "knee-deep",
  thigh: "thigh-deep",
  waist: "waist-deep",
  chest: "chest-deep",
  neck: "neck-deep",
  over_head: "over their head",
  measured: "measured",
  estimated: "estimated",
  present: "water reported",
};

/** How a report reads on the map and in the panel, e.g. "chest-deep", "~1.5 m (estimated)". */
export function describeReport(report: { level: WaterLevel; meters: number }) {
  if (report.level === "measured") return `${report.meters.toFixed(1)} m`;
  if (report.level === "estimated") return `~${report.meters.toFixed(1)} m (estimated)`;
  return LEVEL_LABEL[report.level];
}

/** Floor-to-floor height used to place callers on upper floors. */
export const FLOOR_HEIGHT_M = 3;

/** Depth in metres for a report, or null when a measurement or estimate is missing or implausible. */
export function reportMeters(level: WaterLevel, measuredMeters: number | null) {
  if (level === "measured") return measuredMeters != null && measuredMeters > 0 && measuredMeters < 10 ? measuredMeters : null;
  if (level === "estimated") {
    return measuredMeters != null && measuredMeters > 0 && measuredMeters <= MAX_ESTIMATE_METERS ? measuredMeters : null;
  }
  return LEVEL_METERS[level];
}

/**
 * Whether a new report should replace the stored one. A vague "there's water" never
 * replaces a description with a depth, and an estimate that moved less than the
 * tolerance on the same floor is the same description re-read, not a change.
 */
export function replacesReport(
  prior: Pick<StoredWaterReport, "level" | "meters" | "floor"> | null | undefined,
  next: Pick<StoredWaterReport, "level" | "meters" | "floor">,
) {
  if (!prior) return true;
  if (next.level === "present" && prior.level !== "present") return false;
  if (next.level === "estimated" && prior.level === "estimated" && next.floor === prior.floor) {
    return Math.abs(next.meters - prior.meters) >= ESTIMATE_TOLERANCE_METERS;
  }
  return prior.level !== next.level || prior.meters !== next.meters || prior.floor !== next.floor;
}

export interface StoredWaterReport {
  level: WaterLevel;
  meters: number;
  /** Floor the caller stands on, above the street; null when not said (treated as ground). */
  floor: number | null;
  evidence: string | null;
  at: number;
  /** Water surface at the river gauge when the caller said it, so the report keeps its offset as the river changes. */
  gaugeSurface: number;
}

export const storedWaterReport = v.object({
  level: waterLevel,
  meters: v.number(),
  floor: v.union(v.number(), v.null()),
  evidence: v.union(v.string(), v.null()),
  at: v.number(),
  gaugeSurface: v.number(),
});
