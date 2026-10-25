import type { Doc } from "./_generated/dataModel";
import { moverFor } from "./vehicles";

// How long a team spends on scene before the rescue is done, for the demo simulation's
// automatic finish. Rough exercise figures, not operational guidance: a base time to reach
// and assess the people, time per person to get them out, extra for what makes a rescue
// slower (mobility, injuries, roofs, cars), and a handoff before the team is ready again.

const BASE_MIN = 6;
const PER_PERSON_MIN = { boat: 2.5, air: 4, ground: 2 } as const;
/** When the caller never said how many. */
const UNKNOWN_PEOPLE = 2;
const HANDOFF_MIN = 4;

const EXTRA_MIN: Partial<Record<NonNullable<Doc<"incidents">["riskFactors"]>[number]["factor"], number>> = {
  limited_mobility: 8,
  serious_injury: 8,
  medical_need: 5,
  elderly: 4,
  pregnant: 4,
  on_roof: 5,
  water_chest_or_higher: 4,
  no_higher_ground: 3,
  in_vehicle: 3,
  in_moving_water: 5,
  child: 2,
};

/** Simulated minutes on scene, with a short explanation for the activity log. */
export function onSceneMinutes(
  incident: Pick<Doc<"incidents">, "peopleCount" | "riskFactors">,
  linked: Pick<Doc<"incidents">, "riskFactors">[],
  team: Pick<Doc<"teams">, "capabilities">,
) {
  const mover = moverFor(team.capabilities);
  const people = incident.peopleCount ?? UNKNOWN_PEOPLE;
  const perPerson = mover === "air" ? PER_PERSON_MIN.air : mover === "boat" ? PER_PERSON_MIN.boat : PER_PERSON_MIN.ground;
  const factors = new Set([incident, ...linked].flatMap((i) => (i.riskFactors ?? []).map((r) => r.factor)));
  const extras = [...factors].filter((f) => EXTRA_MIN[f]);
  const minutes = BASE_MIN + people * perPerson + extras.reduce((n, f) => n + EXTRA_MIN[f]!, 0) + HANDOFF_MIN;
  const who = incident.peopleCount == null ? "unknown number of people" : `${people} ${people === 1 ? "person" : "people"}`;
  const why = extras.length ? `${who}; ${extras.map((f) => f.replaceAll("_", " ")).join(", ")}` : who;
  return { minutes: Math.round(minutes), why };
}

/** Default compression of on-scene time; the simulation's start can set its own. */
export const ON_SCENE_SPEEDUP = 30;
/** Even a quick rescue stays on screen long enough to notice. */
export const MIN_ON_SCENE_MS = 12_000;

export function onSceneMs(minutes: number, speedup = ON_SCENE_SPEEDUP) {
  return Math.max(MIN_ON_SCENE_MS, (minutes * 60_000) / speedup);
}
