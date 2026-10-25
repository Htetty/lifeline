import { v } from "convex/values";

// How deep a caller says the water is. Claude picks the body reference the caller
// meant; this fixed table turns it into metres, so the same words always give the
// same depth. Shared by Convex and the dashboard.

export const waterLevel = v.union(
  v.literal("ankle"),
  v.literal("knee"),
  v.literal("thigh"),
  v.literal("waist"),
  v.literal("chest"),
  v.literal("neck"),
  v.literal("over_head"),
  v.literal("measured"),
);

export type WaterLevel = "ankle" | "knee" | "thigh" | "waist" | "chest" | "neck" | "over_head" | "measured";

/** Typical adult heights of each reference, metres above the floor they stand on. */
export const LEVEL_METERS: Record<Exclude<WaterLevel, "measured">, number> = {
  ankle: 0.15,
  knee: 0.5,
  thigh: 0.7,
  waist: 1.0,
  chest: 1.3,
  neck: 1.5,
  over_head: 2.0,
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
};

/** Floor-to-floor height used to place callers on upper floors. */
export const FLOOR_HEIGHT_M = 3;

/** Depth in metres for a report, or null when a measurement is missing or implausible. */
export function reportMeters(level: WaterLevel, measuredMeters: number | null) {
  if (level !== "measured") return LEVEL_METERS[level];
  return measuredMeters != null && measuredMeters > 0 && measuredMeters < 10 ? measuredMeters : null;
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
