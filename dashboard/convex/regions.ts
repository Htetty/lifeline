import { SEED_INCIDENTS, SEED_TEAMS, SF_SEED_TEAMS, type SeedIncident, type SeedTeam } from "./seedData";

// The areas an exercise can run in. Everything location-specific hangs off a region: the
// simulated area (the flood grid, roads and buildings in public/data/<id>/ cover exactly
// `bounds`), how the flood is modelled, where the water starts, and the default teams.
// The exercise records its region; resetting with another region switches the whole app.

export type RegionId = "mission-valley" | "sf-waterfront";

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface WaterLevel {
  /** Water surface at the gauge, metres NAVD88. */
  surface: number;
  /** Time of the replayed reading behind it. */
  observedAt: number;
}

export interface Region {
  id: RegionId;
  name: string;
  bounds: Bounds;
  view: { center: [number, number]; zoom: number; pitch: number; bearing: number };
  /**
   * "river": the surface runs parallel to a river channel through the area and is set at a
   * stream gauge (src/lib/flood.ts). "bay": one flat surface spreading inland from open water.
   */
  flood: { kind: "river"; gaugeLongitude: number } | { kind: "bay" };
  /** Where a reset exercise starts, and where the sample incidents were written. */
  water: { start: WaterLevel; samples: WaterLevel | null; min: number; max: number };
  teams: SeedTeam[];
  incidents: SeedIncident[];
}

export const REGIONS: Record<RegionId, Region> = {
  "mission-valley": {
    id: "mission-valley",
    name: "Mission Valley, San Diego",
    bounds: { west: -117.185, south: 32.752, east: -117.135, north: 32.776 },
    view: { center: [-117.1635, 32.7628], zoom: 15.4, pitch: 60, bearing: -20 },
    flood: { kind: "river", gaugeLongitude: -117.1686285 },
    // The first replayed reading of the Feb 27, 2017 storm at the Fashion Valley gauge: 4.4 ft
    // at 07:00 PST, i.e. (16.48 ft datum + 4.4 ft) in metres. The samples describe 9.78 ft at noon.
    water: {
      start: { surface: 6.36, observedAt: 1488207600000 },
      samples: { surface: 8.0, observedAt: 1488225600000 },
      min: 5.5,
      max: 12,
    },
    teams: SEED_TEAMS,
    incidents: SEED_INCIDENTS,
  },
  "sf-waterfront": {
    id: "sf-waterfront",
    name: "Marina District, San Francisco",
    // The Golden Gate shore: Crissy Field and the Palace of Fine Arts east past the Marina to Fort Mason.
    bounds: { west: -122.463, south: 37.796, east: -122.423, north: 37.812 },
    view: { center: [-122.443, 37.8025], zoom: 15, pitch: 55, bearing: -50 },
    flood: { kind: "bay" },
    // The Jan 1983 record storm tide at the Golden Gate (NOAA 9414290), replayed with a
    // hypothetical 1 m of sea-level rise; see src/data/tideReplay.ts. Starts at the low tide before the peak.
    water: { start: { surface: 1.48, observedAt: 412473600000 }, samples: null, min: 0, max: 6 },
    teams: SF_SEED_TEAMS,
    incidents: [],
  },
};

export const DEFAULT_REGION: RegionId = "mission-valley";

export function regionOf(exercise: { region?: RegionId | null } | null | undefined): Region {
  return REGIONS[exercise?.region ?? DEFAULT_REGION];
}
