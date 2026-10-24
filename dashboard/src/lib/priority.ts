import { FLOOR_HEIGHT_M, type BuildingWaterReport } from "./flood";
import type { Incident, PriorityTier, RiskFactorKind } from "./types";

// Rescue priority from explicit rules, so every tier can be explained and tested.
// Inputs: risk factors the caller reported (with their words), and our simulated
// water depth compared with where the people are in the building. The dispatcher
// can override the result; nothing here assigns or dispatches.

export const TIER_RANK: Record<PriorityTier, number> = { critical: 0, high: 1, standard: 2 };

export const FACTOR_LABEL: Record<RiskFactorKind, string> = {
  serious_injury: "serious injury",
  medical_need: "medical need",
  water_chest_or_higher: "water at chest or higher",
  water_rising_fast: "water rising fast",
  in_moving_water: "in moving water",
  in_vehicle: "in a vehicle",
  no_higher_ground: "can't get higher",
  on_roof: "on a roof",
  child: "child",
  elderly: "elderly person",
  limited_mobility: "limited mobility",
  pregnant: "pregnant",
};

const CRITICAL: RiskFactorKind[] = ["serious_injury", "water_chest_or_higher", "in_moving_water"];
const CRITICAL_COMBOS: [RiskFactorKind, RiskFactorKind][] = [
  ["in_vehicle", "water_rising_fast"],
  ["no_higher_ground", "water_rising_fast"],
];
const HIGH: RiskFactorKind[] = [
  "medical_need",
  "water_rising_fast",
  "in_vehicle",
  "no_higher_ground",
  "on_roof",
  "child",
  "elderly",
  "limited_mobility",
  "pregnant",
];

const CHEST_HEIGHT_M = 1.2;
const ORDINALS = ["ground", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

export interface Priority {
  tier: PriorityTier;
  /** Why, most important first, e.g. "water at chest or higher", "water model: 1.4 m above their floor". */
  reasons: string[];
  /** The tier the rules gave, when a dispatcher override is in effect. */
  computedTier?: PriorityTier;
  overrideReason?: string;
}

/** Height of the floor the people are on, above ground; "roof" uses the building height. */
function floorBase(position: string | null, buildingHeight: number | null): number | null {
  if (!position) return null;
  const text = position.toLowerCase();
  if (/\broof\b/.test(text)) return buildingHeight;
  if (/\battic\b/.test(text)) return buildingHeight != null ? Math.max(0, buildingHeight - FLOOR_HEIGHT_M) : null;
  const numbered = text.match(/(\d+)(?:st|nd|rd|th)?\s*floor/);
  if (numbered) return (Math.max(1, Number(numbered[1])) - 1) * FLOOR_HEIGHT_M;
  const word = ORDINALS.findIndex((w) => new RegExp(`\\b${w}\\s+floor`).test(text));
  if (word >= 0) return Math.max(0, word - 1) * FLOOR_HEIGHT_M; // US usage: ground floor = first floor
  const room = roomFloor(text);
  if (room != null) return (room - 1) * FLOOR_HEIGHT_M;
  return null;
}

/** Hotel-style room numbers start with the floor: 312 → 3, 1204 → 12. A guess, so it's labelled. */
function roomFloor(text: string): number | null {
  const m = text.match(/\b(?:room|rm|apt|apartment|unit|suite)\s*#?\s*(\d{3,4})\b/);
  if (!m) return null;
  const floor = Number(m[1].length === 3 ? m[1][0] : m[1].slice(0, 2));
  return floor >= 1 ? floor : null;
}

/** What our water model says about the people's floor, if we can tell. */
function waterChecks(position: string | null, water: BuildingWaterReport | null): { tier: PriorityTier; reason: string } | null {
  if (!water || water.depth == null || water.depth <= 0) return null;
  if (water.submerged) return { tier: "critical", reason: "water model: building fully submerged" };
  const base = floorBase(position, water.buildingHeight);
  if (base == null) return null;
  const guessed = !/floor|roof|attic/i.test(position ?? "") ? " (floor guessed from room number)" : "";
  const above = water.depth - base;
  if (above >= CHEST_HEIGHT_M) {
    return { tier: "critical", reason: `water model: ~${above.toFixed(1)} m above their floor${guessed}` };
  }
  if (above > 0) return { tier: "high", reason: `water model: water on their floor (~${above.toFixed(1)} m)${guessed}` };
  if (above > -1) return { tier: "high", reason: `water model: within 1 m of their floor${guessed}` };
  return null;
}

/**
 * Priority for an incident. Risk factors from linked reports count too
 * (a witness may mention the child the trapped caller didn't).
 */
export function computePriority(
  incident: Incident,
  linked: Incident[],
  water: BuildingWaterReport | null,
): Priority {
  const factors = new Set<RiskFactorKind>();
  for (const i of [incident, ...linked]) for (const r of i.riskFactors ?? []) factors.add(r.factor);

  const critical = [
    ...CRITICAL.filter((f) => factors.has(f)).map((f) => FACTOR_LABEL[f]),
    ...CRITICAL_COMBOS.filter(([a, b]) => factors.has(a) && factors.has(b)).map(
      ([a, b]) => `${FACTOR_LABEL[a]} + ${FACTOR_LABEL[b]}`,
    ),
  ];
  const high = HIGH.filter((f) => factors.has(f)).map((f) => FACTOR_LABEL[f]);
  const model = waterChecks(incident.reportedPosition, water);
  if (model?.tier === "critical") critical.push(model.reason);
  else if (model) high.push(model.reason);

  const tier: PriorityTier = critical.length ? "critical" : high.length ? "high" : "standard";
  const reasons = [...critical, ...high];

  const override = incident.priorityOverride;
  if (override) return { tier: override.tier, reasons, computedTier: tier, overrideReason: override.reason };
  return { tier, reasons };
}
