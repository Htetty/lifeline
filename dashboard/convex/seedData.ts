// Fictional exercise data for Mission Valley, San Diego (San Diego River floodplain).
// Coordinates sit on real OSM building footprints so the map can highlight them;
// the people, reports, and teams are invented.

export const EXERCISE_ID = "mission-valley-exercise-1";
export const EXERCISE_NAME = "Mission Valley, San Diego";
/** The simulated area: the road graph (public/data/roads.json) and the flood grid cover exactly this. */
export const EXERCISE_BOUNDS = { west: -117.185, south: 32.752, east: -117.135, north: 32.776 };
// A reset exercise opens at the first replayed reading of the Feb 27, 2017 storm at the
// Fashion Valley gauge: 4.4 ft at 07:00 PST, i.e. (16.48 ft datum + 4.4 ft) in metres NAVD88.
export const DEFAULT_WATER_SURFACE_ELEVATION = 6.36;
export const DEFAULT_WATER_OBSERVED_AT = 1488207600000;
// The sample incidents describe the storm partway up: 9.78 ft at 12:00 PST.
export const SAMPLE_WATER_SURFACE_ELEVATION = 8.0;
export const SAMPLE_WATER_OBSERVED_AT = 1488225600000;

type Capability = "road_vehicle" | "high_water_vehicle" | "boat" | "air";
type RiskFactorKind = "limited_mobility" | "on_roof" | "water_rising_fast" | "elderly";

export interface SeedTeam {
  key: string;
  name: string;
  latitude: number;
  longitude: number;
  capabilities: Capability[];
}

export interface SeedIncident {
  reportedAddress: string;
  latitude: number;
  longitude: number;
  locationVerified: boolean;
  peopleCount: number | null;
  reportedPosition: string | null;
  hazards: string[];
  riskFactors?: { factor: RiskFactorKind; evidence: string }[];
  /** What the caller said about the water depth; see waterReports.ts. */
  waterReport?: { level: "ankle" | "knee" | "waist" | "chest"; floor: number; evidence: string };
  summary: string;
  status: "needs_review" | "awaiting_assignment" | "assigned";
  /** Seed team key, when the incident starts already assigned. */
  assignedTeam?: string;
  minutesAgo: number;
}

export const SEED_TEAMS: SeedTeam[] = [
  { key: "boat-1", name: "Swift Water Boat 1", latitude: 32.7695, longitude: -117.1745, capabilities: ["boat"] },
  { key: "boat-2", name: "Swift Water Boat 2", latitude: 32.7662, longitude: -117.1555, capabilities: ["boat"] },
  {
    key: "hwv-1",
    name: "High-Water Truck 7",
    latitude: 32.756,
    longitude: -117.1625,
    capabilities: ["high_water_vehicle", "road_vehicle"],
  },
  { key: "air-1", name: "Helicopter Rescue 1", latitude: 32.772, longitude: -117.148, capabilities: ["air"] },
];

export const SEED_INCIDENTS: SeedIncident[] = [
  {
    reportedAddress: "Hotel on Hotel Circle North, by the river",
    latitude: 32.761772,
    longitude: -117.16852,
    locationVerified: true,
    peopleCount: 3,
    reportedPosition: "Second floor",
    hazards: ["Water rising on stairs", "Power out"],
    summary: "Three adults sheltering on the second floor; ground floor flooded.",
    status: "awaiting_assignment",
    minutesAgo: 14,
  },
  {
    reportedAddress: "Tall building near Hotel Circle, river side",
    latitude: 32.764103,
    longitude: -117.166897,
    locationVerified: true,
    peopleCount: 2,
    reportedPosition: "Third floor",
    hazards: ["One person with limited mobility"],
    riskFactors: [{ factor: "limited_mobility", evidence: "one cannot use stairs" }],
    summary: "Two people on the third floor, one cannot use stairs.",
    status: "awaiting_assignment",
    minutesAgo: 10,
  },
  {
    reportedAddress: '"Low building behind the gas station, I think"',
    latitude: 32.760045,
    longitude: -117.166339,
    locationVerified: false,
    peopleCount: 1,
    reportedPosition: "Roof",
    hazards: ["Fast-moving water", "Caller unsure of address"],
    riskFactors: [
      { factor: "on_roof", evidence: "on a roof" },
      { factor: "water_rising_fast", evidence: "fast-moving water" },
    ],
    summary: "One person on a roof; caller could not confirm the street.",
    status: "needs_review",
    minutesAgo: 7,
  },
  {
    reportedAddress: "Camino de la Reina, office building",
    latitude: 32.765138,
    longitude: -117.15954,
    locationVerified: true,
    peopleCount: 5,
    reportedPosition: "Upper floor",
    hazards: ["Parking garage flooded"],
    summary: "Five staff stayed late and are now cut off by water.",
    status: "assigned",
    assignedTeam: "boat-2",
    minutesAgo: 3,
  },
  {
    reportedAddress: "Single-storey building off Camino de la Reina",
    latitude: 32.767954,
    longitude: -117.15809,
    locationVerified: true,
    peopleCount: 1,
    reportedPosition: "Ground floor, standing on furniture",
    hazards: ["Elderly caller", "Water at waist height"],
    riskFactors: [{ factor: "elderly", evidence: "elderly resident" }],
    waterReport: { level: "waist", floor: 0, evidence: "the water's up to my waist" },
    summary: "Elderly resident trapped on the ground floor.",
    status: "awaiting_assignment",
    minutesAgo: 1,
  },
];
