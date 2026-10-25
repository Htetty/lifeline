// Builds a region's demo simulation scenario (backend/scripts/sim/<region>.json): fictional
// callers in real buildings, each timed to the gauge reading at which the dashboard's flood
// model first surrounds their building with water, dry staging points for the rescue teams,
// and the gauge readings to replay. The people and their stories are invented; only the
// buildings and the gauge records are real.
//
// Run from dashboard/ (needs network for elevation tiles and OpenStreetMap buildings):
//   npm run sim:scenario -- --region sf-waterfront
//   npm run sim:scenario -- --region mission-valley --buildings overpass.json   # skip the download

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { regionArg } from "../regionArg";
import { computeFlood, depthAt, isFlooded, type FloodResult } from "../../src/lib/flood";
import { gaugeFor } from "../../src/lib/gauge";
import { overpass } from "../overpass";
import { loadModel } from "./model";

const region = regionArg();
const gauge = gaugeFor(region.id);
const OUT = join(__dirname, `../../../backend/scripts/sim/${region.id}.json`);
const SEED = 20170227;
const CALLS = 46;
/** Last reading the demo replays: the replayed storm's peak. */
const PEAK_INDEX = gauge.readings.reduce((best, [, s], i) => (s > gauge.readings[best][1] ? i : best), 0);
/** Callers in different buildings at least this far apart, so pins don't pile up. */
const MIN_SPACING_M = 90;
/** A building counts as cut off once flood water is this many grid cells (15 m) away or closer. */
const CUT_OFF_CELLS = 4;
/** Unaddressed buildings are described from a named or addressed landmark this close. */
const LANDMARK_M = 250;
const STAGING_POINTS = 10;

// ---- Deterministic randomness ------------------------------------------------------

let state = SEED;
const rand = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;
function shuffle<T>(xs: T[]) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/** Whether flood water reaches within CUT_OFF_CELLS of a point. */
function cutOff(grid: Parameters<typeof isFlooded>[0], flood: FloodResult, lon: number, lat: number) {
  const c = Math.floor((lon - grid.bounds.west) / grid.dLon);
  const r = Math.floor((grid.bounds.north - lat) / grid.dLat);
  for (let dr = -CUT_OFF_CELLS; dr <= CUT_OFF_CELLS; dr++) {
    for (let dc = -CUT_OFF_CELLS; dc <= CUT_OFF_CELLS; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr >= 0 && rr < grid.rows && cc >= 0 && cc < grid.cols && flood.wet[rr * grid.cols + cc]) return true;
    }
  }
  return false;
}

/** Deepest water within CUT_OFF_CELLS of a point. */
function nearbyDepth(grid: Parameters<typeof isFlooded>[0], flood: FloodResult, lon: number, lat: number) {
  let deepest = 0;
  for (let dr = -CUT_OFF_CELLS; dr <= CUT_OFF_CELLS; dr++) {
    for (let dc = -CUT_OFF_CELLS; dc <= CUT_OFF_CELLS; dc++) {
      deepest = Math.max(deepest, depthAt(grid, flood, lon + dc * grid.dLon, lat + dr * grid.dLat));
    }
  }
  return deepest;
}

const metres = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 111_320);

// ---- Buildings ---------------------------------------------------------------------

interface OsmBuilding {
  type: string;
  id: number;
  center?: { lat: number; lon: number };
  tags: Record<string, string>;
}

async function fetchBuildings(): Promise<OsmBuilding[]> {
  const { west, south, east, north } = region.bounds;
  return overpass<OsmBuilding>(`[out:json][timeout:120];way["building"](${south},${west},${north},${east});out center tags;`);
}

type Kind = "house" | "apartments" | "hotel" | "business" | "school" | "church";

function kindOf(tags: Record<string, string>): Kind | null {
  const b = tags.building;
  if (["parking", "roof", "carport", "construction", "train_station", "garage", "garages", "shed"].includes(b)) return null;
  if (b === "hotel" || /hotel|inn\b|suites|lodge|motel/i.test(tags.name ?? "")) return "hotel";
  if (["apartments", "residential", "terrace", "dormitory"].includes(b) || /apartments|villas|residences|lofts/i.test(tags.name ?? "")) {
    return "apartments";
  }
  if (["house", "detached", "semidetached_house"].includes(b)) return "house";
  if (["school", "education", "university", "college"].includes(b)) return "school";
  if (b === "church") return "church";
  return "business";
}

function addressOf(tags: Record<string, string>) {
  const street = tags["addr:street"];
  const number = tags["addr:housenumber"]?.split(/[;,]/)[0];
  return street ? (number ? `${number} ${street}` : street) : null;
}

// ---- Personas ------------------------------------------------------------------------

type Risk =
  | "serious_injury"
  | "medical_need"
  | "water_rising_fast"
  | "in_vehicle"
  | "no_higher_ground"
  | "on_roof"
  | "child"
  | "elderly"
  | "limited_mobility"
  | "pregnant";

const TEMPERAMENTS = [
  "panicked and talks over the dispatcher, but answers when asked twice",
  "calm and precise, a little embarrassed to be calling",
  "breathless, speaks in short fragments",
  "chatty and keeps drifting into side details",
  "angry that help isn't there yet",
  "trying hard to stay calm for the kids, voice shaking",
  "confused about where exactly they are, has to look out the window to describe it",
  "speaks English as a second language, short simple sentences, sometimes searches for words",
  "elderly and hard of hearing, asks the dispatcher to repeat things",
  "teenager, scared, calling for their family",
];

const RISK_STORY: Record<Risk, string[]> = {
  serious_injury: [
    "one of the group cut their leg badly on debris and it won't stop bleeding",
    "one of the group fell on the stairs and may have broken an arm, they're in a lot of pain",
    "one of the group hit their head when the water knocked them over and is drowsy",
  ],
  medical_need: [
    "one of the group is diabetic and their insulin was left downstairs in the water",
    "one of the group uses an oxygen concentrator and the power is out, the backup tank is running low",
    "one of the group has asthma and is wheezing, the inhaler is almost empty",
    "one of the group takes heart medication and is having chest tightness",
  ],
  water_rising_fast: ["the water came up a foot in the last ten minutes", "you can see it climbing the stairs step by step"],
  in_vehicle: ["they drove into water in the parking lot and the car stalled, water is coming in through the doors"],
  no_higher_ground: ["there's nowhere higher to go, no attic access and no way onto the roof"],
  on_roof: ["they climbed out onto the roof", "they're up on the roof waving a flashlight"],
  child: ["one of the group is a toddler", "one of the group is a 6-year-old", "one of the group is a baby, six months old"],
  elderly: ["one of the group is 84", "one of the group is an elderly neighbour in their late 80s", "one of the group is 79"],
  limited_mobility: ["one of the group uses a wheelchair", "one of the group can't do stairs after a hip replacement", "one of the group uses a walker"],
  pregnant: ["one of the group is eight months pregnant"],
};

interface Persona {
  callerName: string;
  role: "trapped" | "witness";
  people: number;
  position: string;
  waterAtCall: "none yet" | "ankle" | "knee" | "waist" | "chest";
  risks: Risk[];
  story: string;
  temperament: string;
  /** How the caller describes where they are. */
  location: string;
}

const FIRST_NAMES = [
  "Maria", "James", "Linh", "Carlos", "Aisha", "Tom", "Priya", "Diego", "Grace", "Omar", "Rosa", "Kevin", "Mei",
  "Andre", "Fatima", "Luis", "Hannah", "Tariq", "Sofia", "Daniel", "Yuki", "Marcus", "Elena", "Sam", "Nadia",
  "Joe", "Ana", "Chris", "Leila", "Ben", "Isabel", "Ray", "Keiko", "Victor", "Jasmine", "Hector", "Olivia", "Ahmed",
];

const waterWord = (depth: number): Persona["waterAtCall"] =>
  depth < 0.05 ? "none yet" : depth < 0.3 ? "ankle" : depth < 0.7 ? "knee" : depth < 1.2 ? "waist" : "chest";

function persona(kind: Kind, name: string | null, address: string | null, depth: number, floors: number): Persona {
  const witness = chance(0.12);
  const risks = new Set<Risk>();
  for (const [risk, p] of [
    ["elderly", 0.22], ["child", 0.25], ["limited_mobility", 0.12], ["medical_need", 0.14], ["serious_injury", 0.08],
    ["pregnant", 0.04], ["water_rising_fast", 0.25],
  ] as [Risk, number][]) {
    if (chance(p)) risks.add(risk);
  }
  let position: string;
  if (kind === "house") {
    position = pick(["attic", "on the roof", "second floor bedroom", "standing on the kitchen counter"]);
    if (position === "on the roof") risks.add("on_roof");
    if (position === "attic" && chance(0.5)) risks.add("no_higher_ground");
  } else if (kind === "apartments" || kind === "hotel") {
    const floor = 1 + Math.floor(rand() * Math.max(1, Math.min(floors, 5)));
    const room = `${floor}${String(1 + Math.floor(rand() * 30)).padStart(2, "0")}`;
    position = floor === 1 ? `ground floor, unit ${room}` : `floor ${floor}, ${kind === "hotel" ? "room" : "apartment"} ${room}`;
  } else if (chance(0.15)) {
    position = "in a car in the parking lot";
    risks.add("in_vehicle");
  } else {
    position = pick(["on the roof", "upstairs office", "storage mezzanine", "ground floor, standing on tables"]);
    if (position === "on the roof") risks.add("on_roof");
  }
  const people = witness ? 1 + Math.floor(rand() * 4) : pick([1, 1, 2, 2, 2, 3, 3, 4, 5, 6]);
  const place = name ? `${name}${address && !name.includes(address) ? ` (${address})` : ""}` : address!;
  const location = witness
    ? `You are safe on higher ground across the street, watching people trapped at ${place}.`
    : kind === "business" && !name
      ? `You are at the business at ${place}.`
      : `You are at ${place}.`;
  const story = [...risks].filter((r) => RISK_STORY[r]).map((r) => pick(RISK_STORY[r])).join("; ");
  return {
    callerName: pick(FIRST_NAMES),
    role: witness ? "witness" : "trapped",
    people,
    position,
    waterAtCall: waterWord(depth),
    risks: [...risks],
    story: story || "no injuries, just stuck and scared",
    temperament: pick(TEMPERAMENTS),
    location,
  };
}

// ---- Build -------------------------------------------------------------------------

async function main() {
  const arg = process.argv.indexOf("--buildings");
  const buildings: OsmBuilding[] =
    arg > 0 ? JSON.parse(readFileSync(process.argv[arg + 1], "utf8")).elements : await fetchBuildings();
  const { grid, roads } = await loadModel(region);
  const floods: FloodResult[] = [];
  for (const [, surface] of gauge.readings.slice(0, PEAK_INDEX + 1)) floods.push(computeFlood(grid, surface));

  const { west, south, east, north } = region.bounds;
  const inside = (lon: number, lat: number) => lon > west + 0.002 && lon < east - 0.002 && lat > south + 0.001 && lat < north - 0.001;

  interface Candidate {
    id: number;
    lon: number;
    lat: number;
    kind: Kind;
    name: string | null;
    address: string | null;
    floors: number;
    onset: number;
  }
  const candidates: Candidate[] = [];
  const landmarks = buildings.flatMap((b) => {
    const label = b.tags.name ?? addressOf(b.tags);
    return b.center && label ? [{ lon: b.center.lon, lat: b.center.lat, label, street: b.tags["addr:street"] ?? null }] : [];
  });
  const compass = (dx: number, dy: number) =>
    Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "east" : "west") : dy > 0 ? "north" : "south";
  for (const b of buildings) {
    if (!b.center) continue;
    const { lon, lat } = b.center;
    const kind = kindOf(b.tags);
    if (!kind || !inside(lon, lat)) continue;
    // First reading (up to the peak) at which flood water surrounds the building.
    const onset = floods.slice(0, PEAK_INDEX + 1).findIndex((f) => cutOff(grid, f, lon, lat));
    if (onset < 0) continue;
    const levels = Number.parseInt(b.tags["building:levels"] ?? "", 10);
    const floors = Number.isFinite(levels) ? levels : kind === "hotel" ? 4 : kind === "apartments" ? 3 : 2;
    let name = b.tags.name ?? null;
    let address = addressOf(b.tags);
    if (!name && !address) {
      // Callers describe an unmarked building by what's next to it.
      let best: (typeof landmarks)[number] | null = null;
      let bestM = LANDMARK_M;
      for (const l of landmarks) {
        const m = metres([l.lon, l.lat], [lon, lat]);
        if (m > 20 && m < bestM) [best, bestM] = [l, m];
      }
      if (!best) continue;
      const side = compass(lon - best.lon, lat - best.lat);
      const storeys = floors >= 3 ? `${floors}-storey` : pick(["low", "one-storey", "two-storey", "grey", "white", "tan"]);
      name = `the ${storeys} building just ${side} of ${best.label}`;
      address = best.street;
    }
    candidates.push({ id: b.id, lon, lat, kind, name, address, floors, onset });
  }
  console.log(`${candidates.length} buildings are cut off by water by the peak`);

  // Spread picks across the storm: bucket by onset, then draw round-robin, keeping spacing.
  const buckets = new Map<number, Candidate[]>();
  for (const c of shuffle(candidates)) {
    const k = Math.floor(c.onset / 6);
    buckets.set(k, [...(buckets.get(k) ?? []), c]);
  }
  // Named places and homes make better calls than anonymous businesses.
  for (const list of buckets.values()) {
    list.sort((a, b) => Number(b.name != null || b.kind !== "business") - Number(a.name != null || a.kind !== "business"));
  }
  const chosen: Candidate[] = [];
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  while (chosen.length < CALLS && keys.some((k) => buckets.get(k)!.length)) {
    for (const k of keys) {
      const list = buckets.get(k)!;
      while (list.length) {
        const c = list.shift()!;
        if (chosen.every((o) => metres([o.lon, o.lat], [c.lon, c.lat]) >= MIN_SPACING_M)) {
          chosen.push(c);
          break;
        }
      }
      if (chosen.length >= CALLS) break;
    }
  }
  chosen.sort((a, b) => a.onset - b.onset);

  const callers = chosen.map((c, n) => {
    // Depth an hour after the water arrives, when the call is placed.
    const depth = nearbyDepth(grid, floods[Math.min(PEAK_INDEX, c.onset + 4)], c.lon, c.lat);
    return {
      id: `sim-${String(n + 1).padStart(2, "0")}`,
      onsetIndex: c.onset,
      longitude: c.lon,
      latitude: c.lat,
      place: c.name ?? c.address,
      address: c.address,
      buildingKind: c.kind,
      ...persona(c.kind, c.name, c.address, depth, c.floors),
    };
  });

  // Staging: road junctions that stay dry at the peak, close to (but not in) the flood, spread out.
  const peak = floods[PEAK_INDEX];
  const dryNear: [number, number][] = [];
  for (let i = 0; i < roads.count; i += 3) {
    const p: [number, number] = [roads.lon[i], roads.lat[i]];
    if (!inside(p[0], p[1]) || isFlooded(grid, peak, p[0], p[1])) continue;
    let near = false;
    for (let d = 1; d <= 5 && !near; d++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (depthAt(grid, peak, p[0] + dx * d * 2 * grid.dLon, p[1] + dy * d * 2 * grid.dLat) > 0) near = true;
      }
    }
    if (near) dryNear.push(p);
  }
  shuffle(dryNear);
  const staging: [number, number][] = [];
  for (const p of dryNear) {
    if (staging.every((s) => metres(s, p) > 600)) staging.push(p);
    if (staging.length >= STAGING_POINTS) break;
  }

  const onsets = callers.map((c) => c.onsetIndex);
  console.log(`${callers.length} callers, onset readings ${Math.min(...onsets)}–${Math.max(...onsets)}; ${staging.length} staging points`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        note: "Generated by dashboard/scripts/sim/build-scenario.ts. Fictional people in real OpenStreetMap buildings (© OpenStreetMap contributors, ODbL).",
        region: region.id,
        peakIndex: PEAK_INDEX,
        // Gauge readings to replay: [time, water surface in metres NAVD88].
        readings: gauge.readings.slice(0, PEAK_INDEX + 1).map(([t, v]) => [t, Math.round(v * 1000) / 1000]),
        staging: staging.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]),
        callers,
      },
      null,
      1,
    )}\n`,
  );
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
