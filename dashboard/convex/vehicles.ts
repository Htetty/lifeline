import type { Doc } from "./_generated/dataModel";

// How each simulated team moves, and the deepest water each can drive through. Shared by
// the flood-aware router (src/lib/router.ts) and the server's checks on planned routes.
// Rough planning figures for the exercise, not vehicle specifications.

export type Mover = "road_vehicle" | "high_water_vehicle" | "boat" | "air";

export interface Profile {
  label: string;
  /** Deepest water the vehicle (or a boat's tow vehicle) can drive through, metres. */
  limit: number;
  /** Top speed once in water, m/s. */
  wadingSpeed: number;
}

export const PROFILES: Record<Exclude<Mover, "air">, Profile> = {
  road_vehicle: { label: "road vehicle", limit: 0.3, wadingSpeed: 3 },
  high_water_vehicle: { label: "high-water truck", limit: 0.75, wadingSpeed: 5 },
  // Towed on its trailer until the water is deep enough to launch.
  boat: { label: "boat (towed on roads)", limit: 0.6, wadingSpeed: 4 },
};

export function moverFor(capabilities: Doc<"teams">["capabilities"]): Mover {
  if (capabilities.includes("air")) return "air";
  if (capabilities.includes("boat")) return "boat";
  if (capabilities.includes("high_water_vehicle")) return "high_water_vehicle";
  return "road_vehicle";
}
